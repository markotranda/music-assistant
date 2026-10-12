/**
 * @ma/integrations — adapters for external services.
 *
 * Every adapter is injected with its config (API keys, user agent, paths) and
 * exposes a small, testable interface. Adapters land in Phase 2 (MusicBrainz,
 * Last.fm, Deezer) and Phase 3 (yt-dlp, filesystem). Contract tests use
 * recorded fixtures; no live API calls in CI.
 */

export const MA_INTEGRATIONS_VERSION = "0.0.0";

/** External services the app talks to. */
export type IntegrationName = "musicbrainz" | "lastfm" | "deezer" | "ytdlp" | "filesystem";
