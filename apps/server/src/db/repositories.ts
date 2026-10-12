import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import {
  albums,
  artists,
  artistTags,
  candidates,
  events,
  jobs,
  planItems,
  scrobbles,
  settings,
  tasteProfile,
  tracks,
} from "./schema.js";

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
    sizeBytes: number | null;
    /** Defaults to now; migration passes the file's mtime. */
    acquiredAt?: string;
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
    sizeBytes: input.sizeBytes,
    // Migration passes the file's mtime ("when it entered the collection");
    // downloads default to now. Re-upserts keep the original date.
    acquiredAt: input.acquiredAt ?? existing?.acquiredAt ?? new Date().toISOString(),
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

// ---------------------------------------------------------------- events

export type EventRow = typeof events.$inferSelect;

export function listEvents(db: Db, filter: { kind?: string; limit?: number } = {}): EventRow[] {
  const base = db.select().from(events);
  const withWhere = filter.kind ? base.where(eq(events.kind, filter.kind)) : base;
  return withWhere
    .orderBy(desc(events.id))
    .limit(filter.limit ?? 50)
    .all();
}

// -------------------------------------------------------------- scrobbles

export type ScrobbleRow = typeof scrobbles.$inferSelect;

/** Batch insert; duplicate (playedAt, title, artistName) rows are ignored. */
export function insertScrobbles(
  db: Db,
  rows: { artistName: string; title: string; album: string | null; playedAt: string }[],
): number {
  if (rows.length === 0) return 0;
  let inserted = 0;
  // Chunked so a full-history import stays well under SQLite's variable limit.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = db.insert(scrobbles).values(chunk).onConflictDoNothing().run();
    inserted += Number(res.changes ?? 0);
  }
  return inserted;
}

export function countScrobbles(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(scrobbles).get()?.n ?? 0;
}

export function latestScrobbleAt(db: Db): string | null {
  const row = db
    .select({ playedAt: scrobbles.playedAt })
    .from(scrobbles)
    .orderBy(desc(scrobbles.playedAt))
    .limit(1)
    .get();
  return row?.playedAt ?? null;
}

/** Play counts per artist name (case preserved as scrobbled). */
export function scrobblePlaysByArtist(db: Db): { artistName: string; plays: number }[] {
  return db
    .select({
      artistName: scrobbles.artistName,
      plays: sql<number>`count(*)`,
    })
    .from(scrobbles)
    .groupBy(scrobbles.artistName)
    .all();
}

// -------------------------------------------------------------- candidates

export type CandidateRow = typeof candidates.$inferSelect;

export function insertCandidate(
  db: Db,
  input: {
    type: string;
    artistId: number | null;
    key: string | null;
    payload: Record<string, unknown>;
    tasteFit: number | null;
    reason: string | null;
  },
): number {
  const res = db
    .insert(candidates)
    .values({
      type: input.type,
      artistId: input.artistId,
      key: input.key,
      payloadJson: JSON.stringify(input.payload),
      tasteFit: input.tasteFit,
      reason: input.reason,
    })
    .run();
  return Number(res.lastInsertRowid);
}

export function findCandidateByKey(db: Db, type: string, key: string): CandidateRow | undefined {
  return db
    .select()
    .from(candidates)
    .where(and(eq(candidates.type, type), eq(candidates.key, key)))
    .get();
}

export function listCandidates(
  db: Db,
  filter: { status?: string; limit?: number } = {},
): CandidateRow[] {
  const base = db.select().from(candidates);
  const withWhere = filter.status ? base.where(eq(candidates.status, filter.status)) : base;
  return withWhere
    .orderBy(desc(candidates.tasteFit), desc(candidates.id))
    .limit(filter.limit ?? 100)
    .all();
}

export function getCandidate(db: Db, id: number): CandidateRow | undefined {
  return db.select().from(candidates).where(eq(candidates.id, id)).get();
}

export function setCandidateStatus(db: Db, id: number, status: string): void {
  db.update(candidates).set({ status }).where(eq(candidates.id, id)).run();
}

/** Rejects every pending candidate for an artist name ("never suggest"). */
export function rejectPendingForArtistName(db: Db, artistName: string): number {
  const lower = artistName.trim().toLowerCase();
  const rows = db.select().from(candidates).all();
  let rejected = 0;
  for (const r of rows) {
    if (r.status !== "pending") continue;
    const payload = JSON.parse(r.payloadJson) as { name?: string; artistName?: string };
    const matches =
      r.key === lower ||
      (payload.name ?? "").toLowerCase() === lower ||
      (payload.artistName ?? "").toLowerCase() === lower;
    if (matches) {
      setCandidateStatus(db, r.id, "rejected");
      rejected += 1;
    }
  }
  return rejected;
}

// ------------------------------------------------------------ taste profile

export type TasteProfileRow = typeof tasteProfile.$inferSelect;

export function saveTasteProfile(
  db: Db,
  profile: { genreWeights: Record<string, number>; eraWeights: Record<string, number> },
): void {
  const existing = db.select().from(tasteProfile).limit(1).get();
  const values = {
    genreWeightsJson: JSON.stringify(profile.genreWeights),
    eraWeightsJson: JSON.stringify(profile.eraWeights),
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    db.update(tasteProfile).set(values).where(eq(tasteProfile.id, existing.id)).run();
  } else {
    db.insert(tasteProfile).values(values).run();
  }
}

export function readTasteProfile(db: Db): TasteProfileRow | undefined {
  return db.select().from(tasteProfile).limit(1).get();
}

// ----------------------------------------------------------------- albums

export type AlbumRow = typeof albums.$inferSelect;

export function listAlbums(db: Db, artistId: number): AlbumRow[] {
  return db.select().from(albums).where(eq(albums.artistId, artistId)).all();
}

/** Records a release once (radar re-runs must not duplicate rows). */
export function insertAlbum(
  db: Db,
  input: {
    artistId: number;
    mbid: string | null;
    title: string;
    releaseDate: string | null;
    type: string | null;
  },
): void {
  const existing = db
    .select()
    .from(albums)
    .where(
      input.mbid
        ? and(eq(albums.artistId, input.artistId), eq(albums.mbid, input.mbid))
        : and(eq(albums.artistId, input.artistId), eq(albums.title, input.title)),
    )
    .get();
  if (existing) return;
  db.insert(albums).values(input).run();
}

// ------------------------------------------------------------ policy support

export function listTracks(
  db: Db,
  filter: { artistId?: number; status?: string } = {},
): (TrackRow & { artistName: string })[] {
  const rows = db
    .select({ track: tracks, artistName: artists.name })
    .from(tracks)
    .innerJoin(artists, eq(tracks.artistId, artists.id))
    .all();
  return rows
    .map((r) => ({ ...r.track, artistName: r.artistName }))
    .filter(
      (t) =>
        (filter.artistId === undefined || t.artistId === filter.artistId) &&
        (filter.status === undefined || t.status === filter.status),
    );
}

export function countTracksByStatus(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db
    .select({ status: tracks.status, n: sql<number>`count(*)` })
    .from(tracks)
    .groupBy(tracks.status)
    .all()) {
    out[row.status] = row.n;
  }
  return out;
}

export function sumOwnedBytes(db: Db): number {
  return Number(
    db
      .select({ n: sql<number>`coalesce(sum(${tracks.sizeBytes}), 0)` })
      .from(tracks)
      .where(eq(tracks.status, "OWNED"))
      .get()?.n ?? 0,
  );
}

export function updateTrackPlayData(
  db: Db,
  trackId: number,
  data: { playCount: number; lastPlayed: string | null },
): void {
  db.update(tracks)
    .set({ playCount: data.playCount, lastPlayed: data.lastPlayed })
    .where(eq(tracks.id, trackId))
    .run();
}

export type ArtistTagRow = typeof artistTags.$inferSelect;

/** Replaces an artist's cached tags (1 = strongest). */
export function replaceArtistTags(db: Db, artistId: number, tags: string[]): void {
  db.delete(artistTags).where(eq(artistTags.artistId, artistId)).run();
  const seen = new Set<string>();
  let rank = 1;
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    db.insert(artistTags).values({ artistId, tag, rank }).run();
    rank += 1;
  }
}

export function allArtistTags(db: Db): (ArtistTagRow & { artistName: string })[] {
  return db
    .select({ tag: artistTags, artistName: artists.name })
    .from(artistTags)
    .innerJoin(artists, eq(artistTags.artistId, artists.id))
    .all()
    .map((r) => ({ ...r.tag, artistName: r.artistName }));
}
