import { normTitle, roundHalfToEven } from "@ma/core";
import { createHttp, type HttpJson } from "./http.js";

/**
 * MusicBrainz ws/2 client. Fixes two legacy flaws: the 100-item truncation
 * (catalog estimates silently wrong for large acts) via pagination, and
 * scattered Start-Sleep calls via a shared rate limiter.
 */

export type MusicBrainzOptions = {
  userAgent: string;
  http?: HttpJson;
  baseUrl?: string;
};

export type ArtistCandidate = {
  mbid: string;
  name: string;
  country: string | null;
  disambiguation: string | null;
};

export type ResolvedArtist = ArtistCandidate & {
  pinned: boolean;
  alternatives: ArtistCandidate[];
};

export type CatalogSize = {
  albums: number;
  catalog: number;
  method: string;
};

export type AlbumTracks =
  | { found: true; album: string; date: string | null; tracks: string[] }
  | { found: false; available: string[] };

type MbArtist = {
  id: string;
  name: string;
  country?: string;
  disambiguation?: string;
};

type MbReleaseGroup = {
  id: string;
  title: string;
  "first-release-date"?: string;
  "secondary-types"?: string[];
};

type MbRelease = {
  id: string;
  media?: { "track-count"?: number; tracks?: { title: string }[] }[];
  "release-group"?: { id: string; "primary-type"?: string; "secondary-types"?: string[] };
};

const DEFAULT_BASE = "https://musicbrainz.org/ws/2";
const PAGE = 100;

export function createMusicBrainz(options: MusicBrainzOptions) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const http =
    options.http ??
    createHttp({
      service: "musicbrainz",
      defaultHeaders: { "User-Agent": options.userAgent },
      rateLimitMs: 1100,
    });

  /** Fetches every page of a paginated collection (legacy truncated at 100). */
  async function fetchAllPages(
    url: string,
    itemsKey: string,
    countKey: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let offset = 0;
    for (;;) {
      const sep = url.includes("?") ? "&" : "?";
      const page = (await http(`${url}${sep}limit=${PAGE}&offset=${offset}`)) as Record<
        string,
        unknown
      >;
      const chunk = (page[itemsKey] as Record<string, unknown>[]) ?? [];
      items.push(...chunk);
      const total = Number(page[countKey] ?? 0);
      if (chunk.length < PAGE || items.length >= total) break;
      offset += PAGE;
    }
    return items;
  }

  function toCandidate(a: MbArtist): ArtistCandidate {
    return {
      mbid: a.id,
      name: a.name,
      country: a.country ?? null,
      disambiguation: a.disambiguation || null,
    };
  }

  function studioOnly(groups: MbReleaseGroup[]): MbReleaseGroup[] {
    return groups.filter((g) => !g["secondary-types"]?.length);
  }

  return {
    /**
     * Resolves an artist name to an MBID. Pinned overrides win; otherwise
     * exact-field search first (precise for ambiguous names), then a plain
     * query which also matches aliases ("Turbonegro" is filed under
     * "Turboneger" and exact-field returns nothing for it).
     */
    async resolveArtist(
      name: string,
      opts?: { pinnedMbid?: string; searchNameFixes?: Record<string, string> },
    ): Promise<ResolvedArtist | null> {
      if (opts?.pinnedMbid) {
        return {
          mbid: opts.pinnedMbid,
          name,
          country: null,
          disambiguation: "PINNED",
          pinned: true,
          alternatives: [],
        };
      }
      const fixed = opts?.searchNameFixes?.[name] ?? name;
      const q = encodeURIComponent(fixed);

      let page = (await http(`${base}/artist?query=artist:%22${q}%22&fmt=json&limit=5`)) as {
        artists?: MbArtist[];
      };
      if (!page.artists?.length) {
        page = (await http(`${base}/artist?query=${q}&fmt=json&limit=5`)) as {
          artists?: MbArtist[];
        };
      }
      const artists = page.artists ?? [];
      if (!artists.length) return null;

      return {
        ...toCandidate(artists[0] as MbArtist),
        pinned: false,
        alternatives: artists.slice(0, 5).map(toCandidate),
      };
    },

    /**
     * Catalog size = studio albums × sampled average tracks/album (fallback:
     * est 11/alb). Sub-linear quota means small errors here barely move the
     * result, so a sampled average is plenty.
     */
    async getCatalogSize(mbid: string): Promise<CatalogSize> {
      const groups = (await fetchAllPages(
        `${base}/release-group?artist=${mbid}&type=album&fmt=json`,
        "release-groups",
        "release-group-count",
      )) as unknown as MbReleaseGroup[];
      const studio = studioOnly(groups);
      if (studio.length === 0) return { albums: 0, catalog: 0, method: "none" };

      const releases = (await fetchAllPages(
        `${base}/release?artist=${mbid}&inc=media+release-groups&fmt=json`,
        "releases",
        "release-count",
      )) as unknown as MbRelease[];

      const perGroup = new Map<string, number>();
      for (const r of releases) {
        const rg = r["release-group"];
        if (!rg) continue;
        const isStudioAlbum =
          rg["primary-type"] === "Album" && !(rg["secondary-types"]?.length ?? 0);
        if (!isStudioAlbum || perGroup.has(rg.id)) continue; // first release per group (legacy)
        const sum = (r.media ?? []).reduce((acc, m) => acc + (m["track-count"] ?? 0), 0);
        perGroup.set(rg.id, sum);
      }
      const counts = [...perGroup.values()].filter((c) => c > 0 && c < 40);
      if (counts.length > 0) {
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        return {
          albums: studio.length,
          catalog: roundHalfToEven(studio.length * avg),
          method: `mb(avg ${avg.toFixed(1)} x ${studio.length}, n=${counts.length})`,
        };
      }
      return { albums: studio.length, catalog: studio.length * 11, method: "est(11/alb)" };
    },

    /** Album track list; on a miss returns what IS available instead of a bare "not found". */
    async getAlbumTracks(mbid: string, albumName: string): Promise<AlbumTracks> {
      const want = normTitle(albumName);
      const groups = (await fetchAllPages(
        `${base}/release-group?artist=${mbid}&type=album&fmt=json`,
        "release-groups",
        "release-group-count",
      )) as unknown as MbReleaseGroup[];

      const available = studioOnly(groups)
        .slice()
        .sort((a, b) =>
          (a["first-release-date"] ?? "").localeCompare(b["first-release-date"] ?? ""),
        )
        .map((g) => {
          const year = g["first-release-date"]?.slice(0, 4) ?? "?";
          return `${g.title} (${year})`;
        });

      let hit: MbReleaseGroup | undefined;
      if (want) {
        hit = groups.find((g) => normTitle(g.title) === want);
        hit ??= groups.find((g) => normTitle(g.title).includes(want));
      }
      if (!hit) return { found: false, available };

      const rels = (await http(`${base}/release?release-group=${hit.id}&fmt=json&limit=5`)) as {
        releases?: MbRelease[];
      };
      const relId = rels.releases?.[0]?.id;
      if (!relId) return { found: false, available };

      const full = (await http(`${base}/release/${relId}?inc=recordings&fmt=json`)) as MbRelease;
      const tracks = (full.media ?? []).flatMap((m) => (m.tracks ?? []).map((t) => t.title));
      return {
        found: true,
        album: hit.title,
        date: hit["first-release-date"] ?? null,
        tracks,
      };
    },
  };
}

export type MusicBrainzApi = ReturnType<typeof createMusicBrainz>;
