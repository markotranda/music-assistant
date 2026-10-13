import {
  type CollectionFs,
  type CoverArtApi,
  createCollectionFs,
  createCoverArt,
  createDeezer,
  createLastfm,
  createMusicBrainz,
  createYtDlp,
  type DeezerApi,
  type LastfmApi,
  type MusicBrainzApi,
  type YtDlpApi,
} from "@ma/integrations";
import type { Db } from "./db/index.js";
import { getSetting } from "./db/repositories.js";
import { defaultIntegrations, type IntegrationSettings } from "./db/seed.js";

/** Everything the request layer needs — injectable for tests. */
export type AppDeps = {
  db: Db;
  musicbrainz: MusicBrainzApi;
  lastfm: LastfmApi;
  deezer: DeezerApi;
  coverart: CoverArtApi;
  collection: CollectionFs;
  ytdlp: YtDlpApi;
};

/** Builds real adapters from Settings + env. Secrets live in the Settings store. */
export function createDeps(db: Db, env: NodeJS.ProcessEnv = process.env): AppDeps {
  const integrations: IntegrationSettings =
    getSetting<IntegrationSettings>(db, "integrations") ?? defaultIntegrations(env);

  return {
    db,
    musicbrainz: createMusicBrainz({ userAgent: integrations.musicbrainzUserAgent }),
    lastfm: createLastfm({ apiKey: integrations.lastfmApiKey }),
    deezer: createDeezer(),
    coverart: createCoverArt({ userAgent: integrations.musicbrainzUserAgent }),
    collection: createCollectionFs({
      collectionDir: env.MA_COLLECTION_DIR ?? "./collection",
      retiredDir: env.MA_RETIRED_DIR ?? "./_retired",
    }),
    ytdlp: createYtDlp({
      binary: env.MA_YTDLP ?? "yt-dlp",
      ffmpegLocation: env.MA_FFMPEG_DIR,
      // EJS challenge solvers run on Node — point yt-dlp at the running one.
      nodeExe: env.MA_NODE ?? process.execPath,
    }),
  };
}

/**
 * Rebuilds the adapters in place (same deps object, so route closures see the
 * new ones). Called after integration settings change so an edited Last.fm key
 * or user-agent takes effect immediately.
 */
export function refreshDeps(deps: AppDeps, env: NodeJS.ProcessEnv = process.env): void {
  Object.assign(deps, createDeps(deps.db, env));
}
