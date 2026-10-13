import {
  buildPlacements,
  normTitle,
  type Placement,
  type PlacementAlbumInput,
  roundHalfToEven,
} from "@ma/core";
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
  "primary-type"?: string;
  "secondary-types"?: string[];
};

type MbRelease = {
  id: string;
  title?: string;
  date?: string;
  status?: string;
  media?: {
    position?: number;
    "track-count"?: number;
    tracks?: {
      position?: number;
      title: string;
      recording?: { id?: string; title?: string };
    }[];
  }[];
  "release-group"?: { id: string; "primary-type"?: string; "secondary-types"?: string[] };
};

const DEFAULT_BASE = "https://musicbrainz.org/ws/2";
const PAGE = 100;

function yearOf(date: string | undefined): number | null {
  const y = date?.slice(0, 4);
  return y && /^\d{4}$/.test(y) ? Number(y) : null;
}

/**
 * The release representing a release-group. Earliest official release wins —
 * that is what makes the album attribution stable and reproducible, and
 * prefers the original issue over a later remaster (legacy `_canonical_release`).
 */
function canonicalRelease(releases: MbRelease[]): MbRelease | undefined {
  const official = releases.filter((r) => r.status === "Official");
  const pool = official.length > 0 ? official : releases;
  return pool.slice().sort((a, b) => {
    const da = a.date || "9999";
    const db = b.date || "9999";
    return da === db ? (a.title ?? "").localeCompare(b.title ?? "") : da.localeCompare(db);
  })[0];
}

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

    /**
     * Release-groups (any type — albums, singles, EPs) first released on or
     * after `since` ("YYYY-MM-DD"), newest first. The release radar's feed.
     */
    async getRecentReleaseGroups(
      mbid: string,
      since: string,
    ): Promise<
      {
        id: string;
        title: string;
        firstReleaseDate: string | null;
        primaryType: string | null;
        secondaryTypes: string[];
      }[]
    > {
      const groups = (await fetchAllPages(
        `${base}/release-group?artist=${mbid}&fmt=json`,
        "release-groups",
        "release-group-count",
      )) as unknown as MbReleaseGroup[];
      return groups
        .filter((g) => (g["first-release-date"] ?? "") >= since)
        .map((g) => ({
          id: g.id,
          title: g.title,
          firstReleaseDate: g["first-release-date"] ?? null,
          primaryType: g["primary-type"] ?? null,
          secondaryTypes: g["secondary-types"] ?? [],
        }))
        .sort((a, b) => (b.firstReleaseDate ?? "").localeCompare(a.firstReleaseDate ?? ""));
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

    /**
     * Every studio-album placement for the artist (legacy rule): each studio
     * album's canonical release tracklist, walked earliest-first, so a song is
     * attributed to its earliest official studio release and the track number
     * is that album's position. One browse per album — the response both
     * identifies the canonical release and carries its tracklist.
     */
    async syncPlacements(mbid: string): Promise<Placement[]> {
      const groups = (await fetchAllPages(
        `${base}/release-group?artist=${mbid}&type=album&fmt=json`,
        "release-groups",
        "release-group-count",
      )) as unknown as MbReleaseGroup[];

      const albums: PlacementAlbumInput[] = [];
      const studio = studioOnly(groups)
        .slice()
        .sort((a, b) => {
          const da = a["first-release-date"] ?? "9999";
          const db = b["first-release-date"] ?? "9999";
          return da === db ? a.title.localeCompare(b.title) : da.localeCompare(db);
        });

      for (const g of studio) {
        const browse = (await http(
          `${base}/release?release-group=${g.id}&inc=recordings&fmt=json&limit=${PAGE}`,
        )) as { releases?: MbRelease[] };
        const rel = canonicalRelease(browse.releases ?? []);
        if (!rel) continue;
        albums.push({
          title: g.title,
          year: yearOf(g["first-release-date"]),
          releaseGroupMbid: g.id,
          media: (rel.media ?? []).map((m) => ({
            position: m.position ?? null,
            trackCount: m["track-count"] ?? 0,
            tracks: (m.tracks ?? []).map((t) => ({
              position: t.position ?? null,
              title: t.title || t.recording?.title || "",
              recordingMbid: t.recording?.id ?? null,
            })),
          })),
        });
      }
      return buildPlacements(albums);
    },
  };
}

export type MusicBrainzApi = ReturnType<typeof createMusicBrainz>;
