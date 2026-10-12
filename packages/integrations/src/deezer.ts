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

const DEFAULT_BASE = "https://api.deezer.com";

export function createDeezer(options: DeezerOptions = {}) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const http = options.http ?? createHttp({ service: "deezer" });

  return {
    /** Top track titles for the best-matching artist. Empty when no match. */
    async getTopTrackTitles(artist: string, limit = 100): Promise<string[]> {
      const search = (await http(`${base}/search/artist?q=${encodeURIComponent(artist)}`)) as {
        data?: { id: number; name: string }[];
      };
      const hit = search.data?.[0];
      if (!hit) return [];

      const top = (await http(`${base}/artist/${hit.id}/top?limit=${limit}`)) as {
        data?: { title: string }[];
      };
      return (top.data ?? []).map((t) => t.title);
    },
  };
}

export type DeezerApi = ReturnType<typeof createDeezer>;
