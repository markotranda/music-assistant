CREATE TABLE `albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer NOT NULL,
	`mbid` text,
	`title` text NOT NULL,
	`release_date` text,
	`type` text,
	CONSTRAINT `fk_albums_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
CREATE TABLE `artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`mbid` text NOT NULL,
	`name` text NOT NULL,
	`disambig` text,
	`score` integer DEFAULT 0 NOT NULL,
	`catalog_size` integer,
	`quota` integer,
	`pinned_mbid` text,
	`ignored` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`artist_id` integer,
	`payload_json` text NOT NULL,
	`taste_fit` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_candidates_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer NOT NULL,
	`track_id` integer,
	`title` text NOT NULL,
	`norm_title` text NOT NULL,
	`rank` integer NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'PLANNED' NOT NULL,
	`source` text DEFAULT 'selected' NOT NULL,
	CONSTRAINT `fk_plan_items_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`),
	CONSTRAINT `fk_plan_items_track_id_tracks_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `scrobbles` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer,
	`title` text NOT NULL,
	`album` text,
	`played_at` text NOT NULL,
	`source` text DEFAULT 'lastfm' NOT NULL,
	CONSTRAINT `fk_scrobbles_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taste_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`genre_weights_json` text DEFAULT '{}' NOT NULL,
	`era_weights_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer NOT NULL,
	`title` text NOT NULL,
	`norm_title` text NOT NULL,
	`rank` integer,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'PLANNED' NOT NULL,
	`file_path` text,
	`ext` text,
	`duration_s` integer,
	`hash` text,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played` text,
	`acquired_at` text,
	CONSTRAINT `fk_tracks_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
CREATE INDEX `albums_artist_idx` ON `albums` (`artist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_mbid_uq` ON `artists` (`mbid`);--> statement-breakpoint
CREATE INDEX `candidates_status_idx` ON `candidates` (`status`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_run_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_items_artist_norm_uq` ON `plan_items` (`artist_id`,`norm_title`);--> statement-breakpoint
CREATE INDEX `plan_items_artist_idx` ON `plan_items` (`artist_id`);--> statement-breakpoint
CREATE INDEX `scrobbles_played_idx` ON `scrobbles` (`played_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_artist_norm_uq` ON `tracks` (`artist_id`,`norm_title`);