CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`src` text NOT NULL,
	`uri` text NOT NULL,
	`cid` text,
	`val` text NOT NULL,
	`neg` integer DEFAULT false,
	`cts` text NOT NULL,
	`exp` text,
	`sig` blob
);
