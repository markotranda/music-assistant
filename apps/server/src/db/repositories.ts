import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { artists, jobs, planItems, settings, tracks } from "./schema.js";

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

export function setPlanStatus(db: Db, planId: number, status: string, trackId?: number): void {
  db.update(planItems)
    .set(trackId === undefined ? { status } : { status, trackId })
    .where(eq(planItems.id, planId))
    .run();
}

// ---------------------------------------------------------------- tracks

export type TrackRow = typeof tracks.$inferSelect;

export function getTrackByNorm(db: Db, artistId: number, norm: string): TrackRow | undefined {
  return db
    .select()
    .from(tracks)
    .where(and(eq(tracks.artistId, artistId), eq(tracks.normTitle, norm)))
    .get();
}

export function upsertTrack(
  db: Db,
  input: {
    artistId: number;
    title: string;
    norm: string;
    rank: number;
    pinned: boolean;
    status: string;
    filePath: string;
    ext: string;
    durationS: number | null;
    hash: string;
  },
): number {
  const existing = getTrackByNorm(db, input.artistId, input.norm);
  const values = {
    title: input.title,
    rank: input.rank,
    pinned: input.pinned,
    status: input.status,
    filePath: input.filePath,
    ext: input.ext,
    durationS: input.durationS,
    hash: input.hash,
    acquiredAt: new Date().toISOString(),
  };
  if (existing) {
    db.update(tracks).set(values).where(eq(tracks.id, existing.id)).run();
    return existing.id;
  }
  const result = db
    .insert(tracks)
    .values({
      artistId: input.artistId,
      normTitle: input.norm,
      ...values,
    })
    .run();
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------- jobs

export type JobRow = typeof jobs.$inferSelect;

/**
 * Queues a job unless an identical one is already pending (re-syncs must not
 * pile up duplicate downloads). Returns the new job id, or null on dedupe.
 */
export function enqueueJobRow(
  db: Db,
  type: string,
  payload: Record<string, unknown>,
): number | null {
  const payloadJson = JSON.stringify(payload);
  const existing = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, type), eq(jobs.payloadJson, payloadJson), eq(jobs.status, "pending")))
    .get();
  if (existing) return null;
  const result = db.insert(jobs).values({ type, payloadJson }).run();
  return Number(result.lastInsertRowid);
}

/** Atomically claims the next due job (pending -> running). */
export function claimNextJob(db: Db): JobRow | undefined {
  const now = new Date().toISOString();
  const job = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .get();
  if (!job) return undefined;
  const result = db
    .update(jobs)
    .set({ status: "running", startedAt: now, attempts: job.attempts + 1 })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
    .run();
  if (result.changes === 0) return claimNextJob(db); // lost the race; take the next
  return { ...job, status: "running", attempts: job.attempts + 1 };
}

export function completeJob(db: Db, id: number): void {
  db.update(jobs)
    .set({ status: "done", finishedAt: new Date().toISOString(), error: null })
    .where(eq(jobs.id, id))
    .run();
}

/**
 * Records a failed attempt. Exhausted jobs go `failed` with the full error;
 * otherwise the job returns to `pending` with a backoff — never silently.
 */
export function failJobAttempt(
  db: Db,
  id: number,
  attempts: number,
  opts: { maxAttempts: number; backoffMs: number; message: string },
): void {
  const exhausted = attempts >= opts.maxAttempts;
  db.update(jobs)
    .set({
      status: exhausted ? "failed" : "pending",
      runAt: new Date(Date.now() + attempts * opts.backoffMs).toISOString(),
      finishedAt: exhausted ? new Date().toISOString() : null,
      error: opts.message,
    })
    .where(eq(jobs.id, id))
    .run();
}

/** Boot recovery: a job stuck `running` from a crashed process re-queues. */
export function requeueRunningJobs(db: Db): number {
  const result = db
    .update(jobs)
    .set({ status: "pending", startedAt: null })
    .where(eq(jobs.status, "running"))
    .run();
  return Number(result.changes);
}

export function getJob(db: Db, id: number): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobs(
  db: Db,
  filter: { status?: string; type?: string; limit?: number } = {},
): JobRow[] {
  const conditions = [
    filter.status ? eq(jobs.status, filter.status) : undefined,
    filter.type ? eq(jobs.type, filter.type) : undefined,
  ].filter((c) => c !== undefined);
  const base = db.select().from(jobs);
  const withWhere = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return withWhere
    .orderBy(desc(jobs.runAt), desc(jobs.id))
    .limit(filter.limit ?? 50)
    .all();
}

/** Re-queues a failed job for another run. */
export function retryJob(db: Db, id: number): void {
  db.update(jobs)
    .set({ status: "pending", runAt: new Date().toISOString(), startedAt: null, finishedAt: null })
    .where(eq(jobs.id, id))
    .run();
}
