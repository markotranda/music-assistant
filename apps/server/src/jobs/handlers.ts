import { join } from "node:path";
import {
  type DesiredTrack,
  indexOnDisk,
  type Placement,
  splitFileName,
  targetFileName,
} from "@ma/core";
import { getArtistById, getPlanRowByNorm, setPlanStatus, upsertTrack } from "../db/repositories.js";
import { events } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { getOverrides, syncAllBands } from "../services/bands.js";
import { runDiscovery } from "../services/discovery.js";
import { runMigration } from "../services/migrate.js";
import { applyPrune, policyConfig, pruneReport, syncTrackPlayData } from "../services/policy.js";
import { runReleaseRadar } from "../services/releases.js";
import { ingestScrobbles } from "../services/scrobbles.js";
import { readAcquisition } from "../services/settings.js";
import { placementFor, retagBands, writeCanonicalTags } from "../services/tags.js";
import { verifyAll, verifyBand } from "../services/verify.js";
import type { JobHandler } from "./worker.js";

/**
 * Job handlers. The download handler is the legacy Get-Track port with the
 * silence removed: acquire (yt-dlp fallback chain) -> canonical retag ->
 * read-back verification -> record hash/size/duration. Failures throw so the
 * worker records the real reason on the job row.
 */

function logEvent(deps: AppDeps, kind: string, payload: Record<string, unknown>): void {
  deps.db
    .insert(events)
    .values({ kind, payloadJson: JSON.stringify(payload) })
    .run();
}

const download: JobHandler = async (payload, ctx) => {
  const { deps } = ctx;
  const { artistId, norm } = payload as {
    artistId: number;
    norm: string;
    title: string;
    rank: number;
  };

  const artist = getArtistById(deps.db, artistId);
  if (!artist) {
    logEvent(deps, "job_skipped", { jobId: ctx.jobId, reason: "artist no longer tracked" });
    return;
  }
  const planRow = getPlanRowByNorm(deps.db, artistId, norm);
  if (!planRow) {
    logEvent(deps, "job_skipped", { jobId: ctx.jobId, reason: "track no longer in plan" });
    return;
  }

  // Idempotent: a completed sync or earlier job may already have it.
  const existing = indexOnDisk(deps.collection.listBandFiles(artist.name)).find(
    (f) => f.norm === norm,
  );
  if (existing) {
    setPlanStatus(deps.db, planRow.id, "OWNED");
    return;
  }

  setPlanStatus(deps.db, planRow.id, "DOWNLOADING");

  const acq = readAcquisition(deps);
  const overrides = getOverrides(deps);
  const band = overrides.searchNameFixes[artist.name] ?? artist.name;
  const destBase = join(
    deps.collection.bandDir(artist.name),
    targetFileName(
      { rank: planRow.rank, title: planRow.title, norm, pinned: planRow.pinned } as DesiredTrack,
      "",
    ),
  );

  const res = await deps.ytdlp.download({
    band,
    title: planRow.title,
    destBase,
    audioFormat: acq.audioFormat,
    audioQuality: acq.audioQuality,
    minDurationS: acq.minDurationS,
    maxDurationS: acq.maxDurationS,
    playerClients: acq.playerClients,
  });

  if (!res.ok) {
    setPlanStatus(deps.db, planRow.id, "FAILED");
    throw new Error(`download failed for '${artist.name} - ${planRow.title}': ${res.error}`);
  }

  // YouTube metadata is unreliable — write canonical tags from OUR plan data,
  // including the album placement (earliest official studio release). Album
  // metadata is cosmetic: a failed placement lookup is reported and the
  // download continues with the rest of the canonical tags.
  let placement: Placement | null = null;
  try {
    placement = await placementFor(deps, artist, norm);
  } catch (err) {
    logEvent(deps, "tags_partial", {
      artistId,
      band: artist.name,
      title: planRow.title,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const tagged = await writeCanonicalTags(
    deps,
    res.filePath,
    artist,
    { title: planRow.title, rank: planRow.rank },
    placement,
    acq,
  );

  // Read-back verification: prove the tags stuck before recording the file.
  const probe = tagged.probe;
  if (!probe || tagged.mismatch) {
    setPlanStatus(deps.db, planRow.id, "FAILED");
    throw new Error(
      `retag verification failed for '${planRow.title}': ${tagged.mismatch ?? "file unreadable/corrupt"}`,
    );
  }

  const trackId = upsertTrack(deps.db, {
    artistId,
    title: planRow.title,
    norm,
    rank: planRow.rank,
    pinned: planRow.pinned,
    status: "OWNED",
    filePath: res.filePath,
    ext: splitFileName(res.filePath).extension,
    durationS: probe.durationS,
    hash: probe.hash,
    sizeBytes: probe.sizeBytes,
  });
  setPlanStatus(deps.db, planRow.id, "OWNED", trackId);
  logEvent(deps, "track_acquired", {
    artistId,
    band: artist.name,
    title: planRow.title,
    album: placement?.album ?? null,
    hash: probe.hash,
    durationS: probe.durationS,
    attempts: res.attempts.length,
  });
};

const verify: JobHandler = async (payload, ctx) => {
  const { deps } = ctx;
  const { artistId } = payload as { artistId?: number };
  const reports = artistId ? [await verifyBand(deps, artistId)] : await verifyAll(deps);
  logEvent(deps, "verify_report", {
    jobId: ctx.jobId,
    bands: reports.length,
    issues: reports.reduce((n, r) => n + r.issues.length, 0),
    reports,
  });
};

/** Full/incremental Last.fm scrobble import + taste-profile refresh. */
const scrobbleSync: JobHandler = async (payload, ctx) => {
  await ingestScrobbles(ctx.deps, { full: payload.full === true });
};

/** MusicBrainz release-groups -> new_release candidates. */
const releaseRadar: JobHandler = async (_payload, ctx) => {
  await runReleaseRadar(ctx.deps);
};

/** Last.fm getSimilar on top-affinity bands -> related candidates. */
const discovery: JobHandler = async (_payload, ctx) => {
  await runDiscovery(ctx.deps);
};

/** One-shot legacy import (PLAN §6 Phase 7) — see services/migrate.ts. */
const migrate: JobHandler = async (payload, ctx) => {
  await runMigration(ctx.deps, {
    bandsCsv: String(payload.bandsCsv ?? ""),
    planCsv: String(payload.planCsv ?? ""),
  });
};

/**
 * Weekly decay pass (PLAN §4.2 gate 5): fills play data from scrobbles, emits
 * the prune report, and — only with autoPruneEnabled — retires the proposals
 * via the reversible _retired flow.
 */
const pruneScan: JobHandler = async (_payload, ctx) => {
  const { deps } = ctx;
  syncTrackPlayData(deps);
  const report = pruneReport(deps);
  logEvent(deps, "prune_report", {
    jobId: ctx.jobId,
    summary: report.summary,
    proposals: report.proposals.slice(0, 100),
  });
  if (policyConfig(deps).autoPruneEnabled && report.proposals.length > 0) {
    applyPrune(deps);
  }
};

/** Weekly rotation pass: re-rank plans by global popularity blended with own plays. */
const rotationScan: JobHandler = async (_payload, ctx) => {
  const { deps } = ctx;
  if (!policyConfig(deps).rotationEnabled) return;
  syncTrackPlayData(deps);
  const summary = await syncAllBands(deps, { apply: true, rankBlend: "own_plays" });
  logEvent(deps, "rotation_scan", { jobId: ctx.jobId, ...summary });
};

/**
 * On-demand bulk plan: sync every tracked band — build or reconcile each plan
 * and enqueue downloads within budget. The manual answer to "I imported my
 * band list and nothing is planned yet" (per-band syncs stay on the band page).
 * Per-band failures land in `errors` and do not abort the run; if every band
 * fails the job fails too, with the real reason.
 */
const planAll: JobHandler = async (_payload, ctx) => {
  const { deps } = ctx;
  syncTrackPlayData(deps);
  const summary = await syncAllBands(deps, { apply: true, rankBlend: "own_plays" });
  logEvent(deps, "plan_all", { jobId: ctx.jobId, ...summary });
  if (summary.bands === 0 && summary.errors.length > 0) {
    throw new Error(`every band failed to sync: ${summary.errors[0]?.error ?? "unknown"}`);
  }
};

/**
 * Re-tag acquired files with the full canonical tag set (album, year, album
 * position, disc, MusicBrainz ids, cover art, ReplayGain) — the fix-up path
 * for files acquired before album metadata landed. One band or everything;
 * per-file problems land in the summary, never silently.
 */
const retag: JobHandler = async (payload, ctx) => {
  const { deps } = ctx;
  const { artistId } = payload as { artistId?: number };
  const summary = await retagBands(deps, { artistId });
  logEvent(deps, "retag_report", { jobId: ctx.jobId, ...summary });
  if (summary.errors.length > 0 && summary.retagged === 0) {
    throw new Error(`retag failed for every file: ${summary.errors[0]?.error ?? "unknown"}`);
  }
};

export function createJobHandlers(_deps: AppDeps): Record<string, JobHandler> {
  return {
    download,
    verify,
    scrobble_sync: scrobbleSync,
    release_radar: releaseRadar,
    discovery,
    migrate,
    prune_scan: pruneScan,
    rotation_scan: rotationScan,
    plan_all: planAll,
    retag,
  };
}
