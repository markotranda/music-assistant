/**
 * @ma/integrations — adapters for external services. Config-injected,
 * fixture-tested; no live API calls in CI.
 */

export const MA_INTEGRATIONS_VERSION = "0.1.0";

/** External services the app talks to. */
export type IntegrationName = "musicbrainz" | "lastfm" | "deezer" | "ytdlp" | "filesystem";

export * from "./deezer.js";
export * from "./filesystem.js";
export * from "./http.js";
export * from "./lastfm.js";
export * from "./musicbrainz.js";
