import { asc, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { artists, settings } from "./schema.js";

// ---------------------------------------------------------------- settings

export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (JSON.parse(row.valueJson) as T) : undefined;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, valueJson: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: JSON.stringify(value), updatedAt: new Date().toISOString() },
    })
    .run();
}

// ---------------------------------------------------------------- artists

export type ArtistInsert = {
  mbid: string;
  name: string;
  disambig?: string | null;
  score?: number;
  catalogSize?: number | null;
  quota?: number | null;
  pinnedMbid?: string | null;
};

export function insertArtist(db: Db, input: ArtistInsert): number {
  const result = db
    .insert(artists)
    .values({
      mbid: input.mbid,
      name: input.name,
      disambig: input.disambig ?? null,
      score: input.score ?? 0,
      catalogSize: input.catalogSize ?? null,
      quota: input.quota ?? null,
      pinnedMbid: input.pinnedMbid ?? null,
    })
    .run();
  return Number(result.lastInsertRowid);
}

export function getArtistByMbid(db: Db, mbid: string) {
  return db.select().from(artists).where(eq(artists.mbid, mbid)).get();
}

export function listArtists(db: Db) {
  return db.select().from(artists).orderBy(asc(artists.name)).all();
}
