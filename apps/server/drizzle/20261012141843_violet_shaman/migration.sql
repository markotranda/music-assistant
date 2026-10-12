ALTER TABLE `candidates` ADD `key` text;--> statement-breakpoint
ALTER TABLE `scrobbles` ADD `artist_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `candidates_key_idx` ON `candidates` (`type`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scrobbles_unique_idx` ON `scrobbles` (`played_at`,`title`,`artist_name`);