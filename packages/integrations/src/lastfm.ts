import { createHttp, type HttpJson } from "./http.js";

/**
 * Last.fm API 2.0 client — popularity rankings and similar-artist discovery.
 * (The legacy UTF-8/Latin-1 corruption came from Invoke-RestMethod; fetch
 * decodes UTF-8 correctly.)
 */

export type LastfmOptions = {
  apiKey: string;
  http?: HttpJson;
  baseUrl?: string;
};

export type LastfmTrack = { name: string; plays: number };
export type LastfmSimilarArtist = { name: string; mbid: string | null; match: number };

const DEFAULT_BASE = "https://ws.audioscrobbler.com/2.0/";

export function createLastfm(options: LastfmOptions) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const http = options.http ?? createHttp({ service: "lastfm" });

  const call = (method: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({
      method,
      api_key: options.apiKey,
      format: "json",
      ...params,
    }).toString();
    return http(`${base}?${qs}`);
  };

  return {
    /** Global popularity ranking for an artist (up to 500 tracks). */
    async getTopTracks(artist: string, limit = 500): Promise<LastfmTrack[]> {
      const data = (await call("artist.gettoptracks", {
        artist,
        limit: String(limit),
      })) as {
        toptracks?: { track?: { name: string; playcount: string }[] };
      };
      return (data.toptracks?.track ?? []).map((t) => ({
        name: t.name,
        plays: Number(t.playcount) || 0,
      }));
    },

    /** Similar artists (0-1 match score) — Phase 5 discovery feed. */
    async getSimilarArtists(artist: string, limit = 10): Promise<LastfmSimilarArtist[]> {
      const data = (await call("artist.getSimilar", {
        artist,
        limit: String(limit),
      })) as {
        similarartists?: { artist?: { name: string; mbid?: string; match: string }[] };
      };
      return (data.similarartists?.artist ?? []).map((a) => ({
        name: a.name,
        mbid: a.mbid || null,
        match: Number(a.match) || 0,
      }));
    },
  };
}

export type LastfmApi = ReturnType<typeof createLastfm>;
