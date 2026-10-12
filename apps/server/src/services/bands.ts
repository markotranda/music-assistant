import {
  buildDesired,
  DEFAULT_QUOTA_FORMULA,
  type DesiredTrack,
  getQuota,
  indexOnDisk,
  normTitle,
  type PinnedPick,
  planSync,
  type QuotaFormula,
  type RankedTrack,
  rankTracks,
  type ScoreTier,
  selectTracks,
  splitFileName,
} from "@ma/core";
import type { ArtistRow } from "../db/repositories.js";
import {
  deleteArtist,
  deletePlanRow,
  deletePlanRows,
  enqueueJobRow,
  getArtistById,
  getArtistByMbid,
  getPinnedRows,
  getPlanRowByNorm,
  getSetting,
  insertArtist,
  insertPlanRow,
  listPlanRows,
  nextPlanRank,
  replacePlanRows,
  setArtistScore,
} from "../db/repositories.js";
import { events } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";

/**
 * Band tracking service. Flow (mirrors the legacy add-band / set-score /
 * resync): resolve -> catalog -> quota -> popularity ranking -> selection ->
 * desired-state plan -> diff/reconcile. Acquisition (yt-dlp) happens when
 * Phase 3 executes the enqueued download jobs.
 */

export type SyncResult = {
  applied: boolean;
  desired: DesiredTrack[];
  acquire: DesiredTrack[];
  retire: { fileName: string }[];
  renames: { from: string; to: string }[];
};

export type OverridesSettings = {
  pinnedMbids: Record<string, string>;
  searchNameFixes: Record<string, string>;
};

export function getOverrides(deps: AppDeps): OverridesSettings {
  return (
    getSetting<OverridesSettings>(deps.db, "overrides") ?? {
      pinnedMbids: {},
      searchNameFixes: {},
    }
  );
}

function logEvent(deps: AppDeps, kind: string, payload: Record<string, unknown>): void {
  deps.db
    .insert(events)
    .values({ kind, payloadJson: JSON.stringify(payload) })
    .run();
}

export function enqueueJob(
  db: AppDeps["db"],
  type: string,
  payload: Record<string, unknown>,
): void {
  enqueueJobRow(db, type, payload); // dedupes identical pending jobs
}

/** Resolve a name to MBID candidates without any side effects. */
export async function resolveBand(deps: AppDeps, name: string) {
  return deps.musicbrainz.resolveArtist(name, getOverrides(deps));
}

/** Popularity ranking, with the merged-artist whitelist for pinned acts. */
async function fetchRanked(deps: AppDeps, artist: ArtistRow): Promise<RankedTrack[]> {
  const raw = await deps.lastfm.getTopTracks(artist.name);
  let ranked = rankTracks(raw);

  if (artist.pinnedMbid) {
    const whitelist = await buildMergedWhitelist(deps, artist);
    if (whitelist.size > 0) {
      ranked = ranked.filter((t) => whitelist.has(t.norm));
    }
  }
  if (ranked.length === 0) {
    throw new ApiError(422, `no usable ranked tracks returned for '${artist.name}'`);
  }
  return ranked;
}

/**
 * Same-name acts share a Last.fm page; a whitelist of the REAL act's songs
 * (own files + Deezer top) keeps the merged noise out.
 */
async function buildMergedWhitelist(deps: AppDeps, artist: ArtistRow): Promise<Set<string>> {
  const norms = new Set<string>();
  for (const f of deps.collection.listBandFiles(artist.name)) {
    const { base } = splitFileName(f.fileName);
    const n = normTitle(base.replace(/^\d+\s-\s/, ""));
    if (n) norms.add(n);
  }
  try {
    const titles = await deps.deezer.getTopTrackTitles(artist.name);
    for (const t of titles) {
      const n = normTitle(t);
      if (n) norms.add(n);
    }
  } catch (err) {
    // Degrade (own files still whitelist) but never silently: the event log
    // records exactly why the whitelist is weaker than intended.
    logEvent(deps, "whitelist_degraded", {
      artist: artist.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return norms;
}

/** Preview or apply the desired-state plan for one band. */
export async function syncBand(
  deps: AppDeps,
  artistId: number,
  opts: { apply: boolean },
): Promise<SyncResult> {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const formula = getSetting<QuotaFormula>(deps.db, "formula") ?? DEFAULT_QUOTA_FORMULA;
  const ranked = await fetchRanked(deps, artist);
  const picks = selectTracks(ranked, artist.quota ?? 0, artist.score, formula.deepShare);
  const pinned: PinnedPick[] = getPinnedRows(deps.db, artistId).map((r) => ({
    title: r.title,
    norm: r.normTitle,
  }));

  const desired = buildDesired(picks, pinned);
  const onDisk = indexOnDisk(deps.collection.listBandFiles(artist.name));
  const plan = planSync(desired, onDisk);

  if (opts.apply) {
    replacePlanRows(deps.db, artistId, desired);
    if (plan.renames.length > 0) deps.collection.applyRenames(artist.name, plan.renames);
    if (plan.retire.length > 0) deps.collection.retireFiles(artist.name, plan.retire);
    for (const d of plan.acquire) {
      enqueueJob(deps.db, "download", {
        artistId,
        norm: d.norm,
        title: d.title,
        rank: d.rank,
      });
    }
    logEvent(deps, "sync_applied", {
      artistId,
      name: artist.name,
      acquired: plan.acquire.length,
      retired: plan.retire.length,
      renamed: plan.renames.length,
    });
  }

  return {
    applied: opts.apply,
    desired,
    acquire: plan.acquire,
    retire: plan.retire.map((f) => ({ fileName: f.fileName })),
    renames: plan.renames.map((r) => ({ from: r.from, to: r.to })),
  };
}

/** Track a new band: resolve -> catalog -> quota -> plan -> reconcile. */
export async function trackBand(
  deps: AppDeps,
  input: { name: string; mbid?: string; score?: number },
): Promise<{
  artist: ArtistRow;
  catalog: { albums: number; catalog: number; method: string };
  sync: SyncResult;
}> {
  const score = (input.score ?? 1) as ScoreTier;
  if (![1, 2, 3].includes(score)) {
    throw new ApiError(422, "score must be 1, 2 or 3");
  }

  const overrides = getOverrides(deps);
  const resolved = input.mbid
    ? { mbid: input.mbid, name: input.name, pinned: true }
    : await deps.musicbrainz.resolveArtist(input.name, overrides);
  if (!resolved) {
    throw new ApiError(404, `could not resolve '${input.name}' on MusicBrainz`, {
      hint: "try POST /api/artists/resolve to see candidates, then pass mbid",
    });
  }

  const existing = getArtistByMbid(deps.db, resolved.mbid);
  if (existing) {
    throw new ApiError(409, `'${existing.name}' is already tracked`, { artistId: existing.id });
  }

  const catalog = await deps.musicbrainz.getCatalogSize(resolved.mbid);
  const quota = getQuota(score, catalog.catalog);
  const artistId = insertArtist(deps.db, {
    mbid: resolved.mbid,
    name: resolved.name,
    disambig: "disambiguation" in resolved ? resolved.disambiguation : null,
    score,
    catalogSize: catalog.catalog,
    quota,
    pinnedMbid: "pinned" in resolved && resolved.pinned ? resolved.mbid : null,
  });

  logEvent(deps, "artist_tracked", { artistId, name: resolved.name, catalog, quota });
  let sync: SyncResult;
  try {
    sync = await syncBand(deps, artistId, { apply: true });
  } catch (err) {
    // Don't leave a half-tracked artist behind when the initial sync fails
    // (e.g. no Last.fm key or no ranked tracks): roll back and surface the error.
    deletePlanRows(deps.db, artistId);
    deleteArtist(deps.db, artistId);
    logEvent(deps, "track_rolled_back", {
      name: resolved.name,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(500, "artist vanished during tracking");
  return { artist, catalog, sync };
}

/** Change the taste tier: re-quota and re-plan immediately (legacy set-score). */
export async function setScore(
  deps: AppDeps,
  artistId: number,
  score: ScoreTier,
): Promise<{ artist: ArtistRow; sync: SyncResult }> {
  if (![1, 2, 3].includes(score)) {
    throw new ApiError(422, "score must be 1, 2 or 3");
  }
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const quota = getQuota(score, artist.catalogSize ?? 0);
  setArtistScore(deps.db, artistId, score, quota);
  logEvent(deps, "score_changed", { artistId, score, quota });

  const sync = await syncBand(deps, artistId, { apply: true });
  const updated = getArtistById(deps.db, artistId);
  if (!updated) throw new ApiError(500, "artist vanished during score change");
  return { artist: updated, sync };
}

/** Untrack a band: retire its files (never delete) and drop its rows. */
export function untrack(deps: AppDeps, artistId: number): { retired: number } {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const files = deps.collection.listBandFiles(artist.name);
  if (files.length > 0) deps.collection.retireFiles(artist.name, files);
  deletePlanRows(deps.db, artistId);
  deleteArtist(deps.db, artistId);
  logEvent(deps, "artist_untracked", { artistId, name: artist.name, retired: files.length });
  return { retired: files.length };
}

/** Pin a single track — survives every re-plan (legacy add-track). */
export function pinTrack(
  deps: AppDeps,
  artistId: number,
  title: string,
): { id: number; rank: number; title: string; norm: string } {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const norm = normTitle(title);
  if (!norm) throw new ApiError(422, `'${title}' has no usable normalized title`);

  const existing = getPlanRowByNorm(deps.db, artistId, norm);
  if (existing) {
    return {
      id: existing.id,
      rank: existing.rank,
      title: existing.title,
      norm: existing.normTitle,
    };
  }

  const rank = nextPlanRank(deps.db, artistId);
  const id = insertPlanRow(deps.db, {
    artistId,
    title,
    norm,
    rank,
    pinned: true,
    source: "pinned",
  });
  enqueueJob(deps.db, "download", { artistId, norm, title, rank });
  logEvent(deps, "track_pinned", { artistId, title, norm });
  return { id, rank, title, norm };
}

/** Pin a whole album (legacy add-album): every track becomes a pinned row. */
export async function pinAlbum(
  deps: AppDeps,
  artistId: number,
  albumName: string,
): Promise<{
  pinned: { id: number; rank: number; title: string; norm: string }[];
  skipped: string[];
}> {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const album = await deps.musicbrainz.getAlbumTracks(artist.mbid, albumName);
  if (!album.found) {
    throw new ApiError(404, `album '${albumName}' not found for ${artist.name}`, {
      available: album.available,
    });
  }

  const pinned: { id: number; rank: number; title: string; norm: string }[] = [];
  const skipped: string[] = [];
  for (const title of album.tracks) {
    const norm = normTitle(title);
    if (!norm || getPlanRowByNorm(deps.db, artistId, norm)) {
      skipped.push(title);
      continue;
    }
    pinned.push(pinTrack(deps, artistId, title));
  }
  logEvent(deps, "album_pinned", { artistId, album: album.album, pinned: pinned.length });
  return { pinned, skipped };
}

/** Remove one planned track and retire its file if present. */
export function removeTrack(deps: AppDeps, artistId: number, norm: string): { retired: boolean } {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const row = getPlanRowByNorm(deps.db, artistId, norm);
  if (!row) throw new ApiError(404, `track '${norm}' not in plan for ${artist.name}`);

  deletePlanRow(deps.db, artistId, norm);
  const onDisk = indexOnDisk(deps.collection.listBandFiles(artist.name)).find(
    (f) => f.norm === norm,
  );
  if (onDisk) deps.collection.retireFiles(artist.name, [onDisk]);
  logEvent(deps, "track_removed", { artistId, norm, retired: Boolean(onDisk) });
  return { retired: Boolean(onDisk) };
}

/** Band detail for the API: rows + counts. */
export function bandDetail(deps: AppDeps, artistId: number) {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);
  const plan = listPlanRows(deps.db, artistId);
  const onDisk = deps.collection.listBandFiles(artist.name);
  return { artist, plan, onDiskCount: onDisk.length };
}
