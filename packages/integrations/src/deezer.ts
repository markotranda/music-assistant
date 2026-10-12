import { createHttp, type HttpJson } from "./http.js";

/**
 * Deezer client — top-track widening for the merged-artist whitelist
 * (Last.fm sometimes merges same-name acts; Deezer's list helps tell the
 * real act's songs apart). Optional enrichment: failures are surfaced to the
 * caller, which decides whether to degrade (and logs the reason).
 */

export type DeezerOptions = {
  http?: HttpJson;
  baseUrl?: string;
};

export type DeezerArtistHit = {
  id: number;
  name: string;
  nb_fan?: number;
};

const DEFAULT_BASE = "https://api.deezer.com";

/**
 * Best-matching artist, not just the first search hit: exact name match wins,
 * then the most popular candidate ("Terror" must not resolve to "T-Error"
 * just because the search ranked him first).
 */
export function pickArtist(hits: DeezerArtistHit[], name: string): DeezerArtistHit | undefined {
  if (hits.length === 0) return undefined;
  const exact = hits.filter((h) => h.name.toLowerCase() === name.toLowerCase());
  const pool = exact.length > 0 ? exact : hits;
  return pool.reduce((best, h) => ((h.nb_fan ?? 0) > (best.nb_fan ?? 0) ? h : best));
}

export function createDeezer(options: DeezerOptions = {}) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const http = options.http ?? createHttp({ service: "deezer" });

  return {
    /** Top track titles for the best-matching artist. Empty when no match. */
    async getTopTrackTitles(artist: string, limit = 100): Promise<string[]> {
      const search = (await http(`${base}/search/artist?q=${encodeURIComponent(artist)}`)) as {
        data?: DeezerArtistHit[];
      };
      const hit = pickArtist(search.data ?? [], artist);
      if (!hit) return [];

      const top = (await http(`${base}/artist/${hit.id}/top?limit=${limit}`)) as {
        data?: { title: string }[];
      };
      return (top.data ?? []).map((t) => t.title);
    },
  };
}

export type DeezerApi = ReturnType<typeof createDeezer>;
