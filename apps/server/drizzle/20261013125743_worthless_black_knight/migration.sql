CREATE TABLE `placements` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer NOT NULL,
	`norm_title` text NOT NULL,
	`album` text NOT NULL,
	`year` integer,
	`track_no` integer,
	`track_total` integer,
	`disc_no` integer,
	`recording_mbid` text,
	`release_group_mbid` text,
	CONSTRAINT `fk_placements_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
ALTER TABLE `artists` ADD `placements_synced_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `placements_artist_norm_uq` ON `placements` (`artist_id`,`norm_title`);--> statement-breakpoint
CREATE INDEX `placements_artist_idx` ON `placements` (`artist_id`);