import { fileURLToPath } from "node:url";
import type {
  AlbumTracks,
  CatalogSize,
  CollectionFs,
  DeezerApi,
  LastfmApi,
  MusicBrainzApi,
  RenameAction,
  ResolvedArtist,
} from "@ma/integrations";
import type { Db } from "../src/db";
import { createDb } from "../src/db";
import { seedSettings } from "../src/db/seed";
import type { AppDeps } from "../src/deps";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function makeDb(): Db {
  const db = createDb({ dbPath: ":memory:", migrationsFolder });
  seedSettings(db, { LASTFM_API_KEY: "test-key" });
  return db;
}

/** In-memory collection folder: band -> files, plus retired files. */
export function fakeCollectionFs(initial: Record<string, string[]> = {}) {
  const files = new Map<string, Set<string>>(
    Object.entries(initial).map(([band, names]) => [band, new Set(names)]),
  );
  const retired = new Map<string, string[]>();

  const fs: CollectionFs & { retired: Map<string, string[]>; files: Map<string, Set<string>> } = {
    files,
    retired,
    bandDir: (bandName: string) => `/fake/collection/${bandName}`,
    listBandFiles: (bandName: string) =>
      [...(files.get(bandName) ?? [])].map((fileName) => ({ fileName })),
    applyRenames: (bandName: string, renames: RenameAction[]) => {
      const set = files.get(bandName) ?? new Set<string>();
      for (const r of renames) {
        set.delete(r.from);
        set.add(r.viaTemp);
      }
      for (const r of renames) {
        set.delete(r.viaTemp);
        set.add(r.to);
      }
      files.set(bandName, set);
    },
    retireFiles: (bandName: string, toRetire: { fileName: string }[]) => {
      const set = files.get(bandName) ?? new Set<string>();
      for (const f of toRetire) {
        set.delete(f.fileName);
        retired.set(bandName, [...(retired.get(bandName) ?? []), f.fileName]);
      }
      files.set(bandName, set);
    },
  };
  return fs;
}

export type FakeOptions = {
  ranked?: { name: string; plays: number }[];
  resolved?: Partial<ResolvedArtist> | null;
  catalog?: CatalogSize;
  album?: AlbumTracks;
  deezerTitles?: string[];
  deezerThrows?: boolean;
  files?: Record<string, string[]>;
};

export type FakeDeps = AppDeps & {
  fs: ReturnType<typeof fakeCollectionFs>;
  calls: { deezer: number };
};

export function fakeDeps(opts: FakeOptions = {}): FakeDeps {
  const db = makeDb();
  const fs = fakeCollectionFs(opts.files ?? {});
  const calls = { deezer: 0 };

  const ranked = opts.ranked ?? syntheticRanked(30);

  const musicbrainz: MusicBrainzApi = {
    resolveArtist: async (name) =>
      opts.resolved === null
        ? null
        : ({
            mbid: `mbid-${name.toLowerCase().replace(/\W+/g, "-")}`,
            name,
            country: "US",
            disambiguation: null,
            pinned: false,
            alternatives: [],
            ...opts.resolved,
          } as ResolvedArtist),
    getCatalogSize: async () => opts.catalog ?? { albums: 10, catalog: 139, method: "test" },
    getAlbumTracks: async () =>
      opts.album ?? {
        found: true,
        album: "Test Album",
        date: "2010-01-01",
        tracks: ["Album Track 1", "Album Track 2"],
      },
  };

  const lastfm: LastfmApi = {
    getTopTracks: async () => ranked,
    getSimilarArtists: async () => [],
  };

  const deezer: DeezerApi = {
    getTopTrackTitles: async () => {
      calls.deezer += 1;
      if (opts.deezerThrows) throw new Error("deezer down");
      return opts.deezerTitles ?? [];
    },
  };

  return { db, musicbrainz, lastfm, deezer, collection: fs, fs, calls };
}

export function syntheticRanked(count: number): { name: string; plays: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { name: `Song ${String(n).padStart(2, "0")}`, plays: 1000 - n };
  });
}
