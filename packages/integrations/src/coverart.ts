import type { Cover } from "./retag.js";

/**
 * Cover Art Archive client. Front covers only — the archive keys art by
 * release(-group), and the placement layer already knows which release group a
 * song belongs to. A missing cover (404) and an unreachable archive both come
 * back as null: art is cosmetic, and its absence is reported by the caller's
 * summary rather than by failing an acquisition.
 */

export type CoverArtApi = {
  /** Front cover of a release-group, or null when none is published or reachable. */
  front(releaseGroupMbid: string): Promise<Cover | null>;
};

export function createCoverArt(options: {
  userAgent: string;
  fetchImpl?: typeof fetch;
}): CoverArtApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async front(releaseGroupMbid: string): Promise<Cover | null> {
      try {
        const res = await fetchImpl(
          `https://coverartarchive.org/release-group/${releaseGroupMbid}/front`,
          { headers: { "User-Agent": options.userAgent }, redirect: "follow" },
        );
        if (!res.ok) return null;
        return {
          data: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get("content-type") ?? "image/jpeg",
        };
      } catch {
        return null;
      }
    },
  };
}
