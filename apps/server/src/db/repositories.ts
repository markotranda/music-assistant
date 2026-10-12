import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { artists, planItems, settings } from "./schema.js";

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

export type ArtistRow = typeof artists.$inferSelect;

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

export function getArtistByMbid(db: Db, mbid: string): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.mbid, mbid)).get();
}

export function getArtistById(db: Db, id: number): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.id, id)).get();
}

export function listArtists(db: Db): ArtistRow[] {
  return db.select().from(artists).orderBy(asc(artists.name)).all();
}

export function setArtistScore(db: Db, id: number, score: number, quota: number): void {
  db.update(artists).set({ score, quota }).where(eq(artists.id, id)).run();
}

export function deleteArtist(db: Db, id: number): void {
  db.delete(artists).where(eq(artists.id, id)).run();
}

// ---------------------------------------------------------------- plan items

export type PlanRow = typeof planItems.$inferSelect;

export function listPlanRows(db: Db, artistId: number): PlanRow[] {
  return db
    .select()
    .from(planItems)
    .where(eq(planItems.artistId, artistId))
    .orderBy(asc(planItems.rank))
    .all();
}

export function getPinnedRows(db: Db, artistId: number): PlanRow[] {
  return listPlanRows(db, artistId).filter((r) => r.pinned);
}

export function getPlanRowByNorm(db: Db, artistId: number, norm: string): PlanRow | undefined {
  return db
    .select()
    .from(planItems)
    .where(and(eq(planItems.artistId, artistId), eq(planItems.normTitle, norm)))
    .get();
}

export function nextPlanRank(db: Db, artistId: number): number {
  const max = db
    .select({ max: sql<number>`coalesce(max(${planItems.rank}), 0)` })
    .from(planItems)
    .where(eq(planItems.artistId, artistId))
    .get();
  return (max?.max ?? 0) + 1;
}

export function replacePlanRows(
  db: Db,
  artistId: number,
  rows: { rank: number; title: string; norm: string; pinned: boolean }[],
): void {
  db.delete(planItems).where(eq(planItems.artistId, artistId)).run();
  if (rows.length === 0) return;
  db.insert(planItems)
    .values(
      rows.map((r) => ({
        artistId,
        title: r.title,
        normTitle: r.norm,
        rank: r.rank,
        pinned: r.pinned,
        status: "PLANNED",
        source: r.pinned ? "pinned" : "selected",
      })),
    )
    .run();
}

export function insertPlanRow(
  db: Db,
  input: {
    artistId: number;
    title: string;
    norm: string;
    rank: number;
    pinned: boolean;
    source?: string;
    status?: string;
  },
): number {
  const result = db
    .insert(planItems)
    .values({
      artistId: input.artistId,
      title: input.title,
      normTitle: input.norm,
      rank: input.rank,
      pinned: input.pinned,
      status: input.status ?? "PLANNED",
      source: input.source ?? (input.pinned ? "pinned" : "selected"),
    })
    .run();
  return Number(result.lastInsertRowid);
}

export function deletePlanRow(db: Db, artistId: number, norm: string): void {
  db.delete(planItems)
    .where(and(eq(planItems.artistId, artistId), eq(planItems.normTitle, norm)))
    .run();
}

export function deletePlanRows(db: Db, artistId: number): void {
  db.delete(planItems).where(eq(planItems.artistId, artistId)).run();
}
