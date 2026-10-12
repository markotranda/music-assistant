import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema (PLAN.md §5). Timestamps are ISO-8601 text.
 *
 * Created up front for every phase so later work adds behavior, not schema
 * churn. Statuses use plain text columns so the state machines can evolve
 * without migrations.
 */

const now = () => new Date().toISOString();

export const artists = sqliteTable(
  "artists",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mbid: text("mbid").notNull(),
    name: text("name").notNull(),
    disambig: text("disambig"),
    /** Taste tier 0-3; 0 = untracked/unset. */
    score: integer("score").notNull().default(0),
    catalogSize: integer("catalog_size"),
    quota: integer("quota"),
    /** User-forced MBID (same-name artist merges). */
    pinnedMbid: text("pinned_mbid"),
    /** Never suggest this artist again. */
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("artists_mbid_uq").on(t.mbid)],
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    title: text("title").notNull(),
    normTitle: text("norm_title").notNull(),
    /** Popularity rank shown as the NN filename prefix. */
    rank: integer("rank"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** PLANNED | DOWNLOADING | OWNED | FAILED | RETIRED */
    status: text("status").notNull().default("PLANNED"),
    filePath: text("file_path"),
    ext: text("ext"),
    durationS: integer("duration_s"),
    hash: text("hash"),
    sizeBytes: integer("size_bytes"),
    playCount: integer("play_count").notNull().default(0),
    lastPlayed: text("last_played"),
    acquiredAt: text("acquired_at"),
  },
  (t) => [uniqueIndex("tracks_artist_norm_uq").on(t.artistId, t.normTitle)],
);

export const planItems = sqliteTable(
  "plan_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    trackId: integer("track_id").references(() => tracks.id),
    title: text("title").notNull(),
    normTitle: text("norm_title").notNull(),
    rank: integer("rank").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** PLANNED | DOWNLOADING | OWNED | FAILED */
    status: text("status").notNull().default("PLANNED"),
    /** Why this is in the plan: selected | pinned | imported */
    source: text("source").notNull().default("selected"),
  },
  (t) => [
    uniqueIndex("plan_items_artist_norm_uq").on(t.artistId, t.normTitle),
    index("plan_items_artist_idx").on(t.artistId),
  ],
);

export const albums = sqliteTable(
  "albums",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    mbid: text("mbid"),
    title: text("title").notNull(),
    releaseDate: text("release_date"),
    /** album | single | ep | compilation ... */
    type: text("type"),
  },
  (t) => [index("albums_artist_idx").on(t.artistId)],
);

export const candidates = sqliteTable(
  "candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** new_release | related | trending | missing_track */
    type: text("type").notNull(),
    artistId: integer("artist_id").references(() => artists.id),
    /** Dedupe identity: "rg:<release-group mbid>" for releases, normalized artist name for related acts. */
    key: text("key"),
    payloadJson: text("payload_json").notNull(),
    /** 0-100 taste-fit score. */
    tasteFit: integer("taste_fit"),
    /** pending | approved | rejected */
    status: text("status").notNull().default("pending"),
    /** Human-readable "why suggested". */
    reason: text("reason"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [
    index("candidates_status_idx").on(t.status),
    index("candidates_key_idx").on(t.type, t.key),
  ],
);

export const scrobbles = sqliteTable(
  "scrobbles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id").references(() => artists.id),
    /** Display name as scrobbled — untracked artists have no artists row. */
    artistName: text("artist_name").notNull().default(""),
    title: text("title").notNull(),
    album: text("album"),
    playedAt: text("played_at").notNull(),
    /** lastfm | listenbrainz | manual */
    source: text("source").notNull().default("lastfm"),
  },
  (t) => [
    index("scrobbles_played_idx").on(t.playedAt),
    uniqueIndex("scrobbles_unique_idx").on(t.playedAt, t.title, t.artistName),
  ],
);

export const tasteProfile = sqliteTable("taste_profile", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  genreWeightsJson: text("genre_weights_json").notNull().default("{}"),
  eraWeightsJson: text("era_weights_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

/** Cached genre tags per artist (Last.fm getTopTags) — genre-cap attribution. */
export const artistTags = sqliteTable(
  "artist_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id),
    /** Lowercase tag. */
    tag: text("tag").notNull(),
    /** 1 = strongest. */
    rank: integer("rank").notNull(),
  },
  (t) => [uniqueIndex("artist_tags_unique_idx").on(t.artistId, t.tag)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** sync | download | release_radar | scrobble_import | prune ... */
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    /** pending | running | done | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAt: text("run_at").notNull().$defaultFn(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    error: text("error"),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Audit log for sync/prune/policy decisions. */
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("events_created_idx").on(t.createdAt)],
);
