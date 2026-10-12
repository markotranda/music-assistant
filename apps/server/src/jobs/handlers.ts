import { join } from "node:path";
import { type DesiredTrack, indexOnDisk, splitFileName, targetFileName } from "@ma/core";
import { probeAudio, retagFile } from "@ma/integrations";
import {
  getArtistById,
  getPlanRowByNorm,
  getSetting,
  setPlanStatus,
  upsertTrack,
} from "../db/repositories.js";
import { events } from "../db/schema.js";
import { type AcquisitionSettings, DEFAULT_ACQUISITION } from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { getOverrides } from "../services/bands.js";
import { runDiscovery } from "../services/discovery.js";
import { runReleaseRadar } from "../services/releases.js";
import { ingestScrobbles } from "../services/scrobbles.js";
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

  const acq = getSetting<AcquisitionSettings>(deps.db, "acquisition") ?? DEFAULT_ACQUISITION;
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

  // YouTube metadata is unreliable — write canonical tags from OUR plan data.
  retagFile(res.filePath, {
    artist: artist.name,
    title: planRow.title,
    albumArtist: artist.name,
    trackNumber: planRow.rank,
  });

  // Read-back verification: prove the tags stuck before recording the file.
  const probe = await probeAudio(res.filePath);
  if (!probe) {
    setPlanStatus(deps.db, planRow.id, "FAILED");
    throw new Error(`acquired file for '${planRow.title}' is unreadable/corrupt`);
  }
  if (
    probe.title !== planRow.title ||
    probe.artist !== artist.name ||
    probe.albumArtist !== artist.name
  ) {
    setPlanStatus(deps.db, planRow.id, "FAILED");
    throw new Error(
      `retag verification failed for '${planRow.title}': read back title=${JSON.stringify(probe.title)} artist=${JSON.stringify(probe.artist)}`,
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

export function createJobHandlers(_deps: AppDeps): Record<string, JobHandler> {
  return {
    download,
    verify,
    scrobble_sync: scrobbleSync,
    release_radar: releaseRadar,
    discovery,
  };
}
