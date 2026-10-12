CREATE TABLE `artist_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`artist_id` integer NOT NULL,
	`tag` text NOT NULL,
	`rank` integer NOT NULL,
	CONSTRAINT `fk_artist_tags_artist_id_artists_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artist_tags_unique_idx` ON `artist_tags` (`artist_id`,`tag`);