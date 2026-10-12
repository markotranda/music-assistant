import { createHttp, type HttpJson, IntegrationError } from "./http.js";

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
export type LastfmScrobble = {
  artist: string;
  title: string;
  album: string | null;
  /** ISO timestamp of the play. */
  playedAt: string;
};
export type LastfmRecentPage = {
  scrobbles: LastfmScrobble[];
  page: number;
  totalPages: number;
  total: number;
};

const DEFAULT_BASE = "https://ws.audioscrobbler.com/2.0/";

export function createLastfm(options: LastfmOptions) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const http = options.http ?? createHttp({ service: "lastfm" });

  const call = (method: string, params: Record<string, string>) => {
    if (!options.apiKey) {
      // A missing key reads as an opaque HTTP 400 from Last.fm otherwise.
      throw new IntegrationError(
        "Last.fm API key not configured — set it in Settings or .env (LASTFM_API_KEY)",
        { service: "lastfm" },
      );
    }
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

    /**
     * One page of a user's scrobble history (newest first). The importer walks
     * pages until `page >= totalPages`; `from`/`to` are Unix seconds for the
     * incremental follow-up syncs.
     */
    async getUserRecentTracks(
      user: string,
      opts: { from?: number; to?: number; page?: number; limit?: number } = {},
    ): Promise<LastfmRecentPage> {
      const params: Record<string, string> = {
        user,
        limit: String(opts.limit ?? 200),
      };
      if (opts.page) params.page = String(opts.page);
      if (opts.from !== undefined) params.from = String(opts.from);
      if (opts.to !== undefined) params.to = String(opts.to);

      const data = (await call("user.getRecentTracks", params)) as {
        recenttracks?: {
          track?: {
            name?: string;
            artist?: { "#text"?: string; name?: string } | string;
            album?: { "#text"?: string } | string;
            date?: { uts?: string };
          }[];
          "@attr"?: { page?: string; total?: string; totalPages?: string };
        };
      };

      const scrobbles: LastfmScrobble[] = [];
      for (const t of data.recenttracks?.track ?? []) {
        // "Now playing" entries carry no timestamp — not scrobbles yet.
        const uts = t.date?.uts;
        if (!uts || !t.name) continue;
        const artist =
          typeof t.artist === "string" ? t.artist : (t.artist?.["#text"] ?? t.artist?.name ?? "");
        const album = typeof t.album === "string" ? t.album : (t.album?.["#text"] ?? null);
        if (!artist) continue;
        scrobbles.push({
          artist,
          title: t.name,
          album: album || null,
          playedAt: new Date(Number(uts) * 1000).toISOString(),
        });
      }

      const attr = data.recenttracks?.["@attr"] ?? {};
      return {
        scrobbles,
        page: Number(attr.page) || 1,
        totalPages: Number(attr.totalPages) || 1,
        total: Number(attr.total) || scrobbles.length,
      };
    },

    /** Top genre tags for an artist (strongest first) — taste profile input. */
    async getTopTags(artist: string, limit = 5): Promise<string[]> {
      const data = (await call("artist.getTopTags", { artist })) as {
        toptags?: { tag?: { name: string }[] };
      };
      return (data.toptags?.tag ?? [])
        .slice(0, limit)
        .map((t) => t.name)
        .filter(Boolean);
    },
  };
}

export type LastfmApi = ReturnType<typeof createLastfm>;
