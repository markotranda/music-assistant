import {
  countScrobbles,
  getSetting,
  insertScrobbles,
  latestScrobbleAt,
  scrobblePlaysByArtist,
} from "../db/repositories.js";
import { defaultIntegrations, type IntegrationSettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { logEvent } from "./events.js";
import { recomputeTasteProfile } from "./taste.js";

/**
 * Scrobble ingestion (PLAN.md §4.3): full-history import on first run, then
 * incremental syncs from the last imported play. Duplicates are ignored at the
 * (playedAt, title, artistName) level so re-running is always safe.
 */

export type ScrobbleIngestResult = {
  imported: number;
  scanned: number;
  total: number;
  /** True when this run walked the full history instead of the delta. */
  full: boolean;
};

/** Last.fm pages are 200 rows; the guard stops a runaway history walk. */
const MAX_PAGES_PER_RUN = 500;

export async function ingestScrobbles(
  deps: AppDeps,
  opts: { full?: boolean } = {},
): Promise<ScrobbleIngestResult> {
  const integrations =
    getSetting<IntegrationSettings>(deps.db, "integrations") ?? defaultIntegrations();
  const user = integrations.lastfmUsername?.trim();
  if (!user) {
    throw new ApiError(
      422,
      "Last.fm username not configured — set it in Settings (Integrations) or .env (LASTFM_USERNAME)",
    );
  }

  const full = opts.full === true;
  const latest = latestScrobbleAt(deps.db);
  // 1 day of overlap: Last.fm timestamps and clock drift make the boundary fuzzy.
  const from = !full && latest ? Math.floor(Date.parse(latest) / 1000) - 86400 : undefined;

  let page = 1;
  let totalPages = 1;
  let scanned = 0;
  let imported = 0;
  do {
    const res = await deps.lastfm.getUserRecentTracks(user, { from, page, limit: 200 });
    totalPages = res.totalPages;
    scanned += res.scrobbles.length;
    imported += insertScrobbles(
      deps.db,
      res.scrobbles.map((s) => ({
        artistName: s.artist,
        title: s.title,
        album: s.album,
        playedAt: s.playedAt,
      })),
    );
    page += 1;
    if (page > MAX_PAGES_PER_RUN) {
      logEvent(deps, "scrobble_import_truncated", { user, scanned, totalPages });
      break;
    }
  } while (page <= totalPages);

  logEvent(deps, "scrobbles_ingested", { user, imported, scanned, full });
  await recomputeTasteProfile(deps);
  return { imported, scanned, total: countScrobbles(deps.db), full };
}

export function scrobbleStats(deps: AppDeps) {
  const topArtists = scrobblePlaysByArtist(deps.db)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 20);
  return {
    total: countScrobbles(deps.db),
    lastPlayedAt: latestScrobbleAt(deps.db),
    topArtists,
  };
}
