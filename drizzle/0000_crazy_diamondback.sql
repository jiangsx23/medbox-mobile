CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`medicine_id` integer NOT NULL,
	`owner_id` integer,
	`qty` integer NOT NULL,
	`unit` text NOT NULL,
	`expiry_date` text,
	`opened_at` text,
	`open_life_days` integer,
	`location` text,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`medicine_id`) REFERENCES `medicines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `batches_medicine_idx` ON `batches` (`medicine_id`);--> statement-breakpoint
CREATE INDEX `batches_owner_idx` ON `batches` (`owner_id`);--> statement-breakpoint
CREATE INDEX `batches_status_idx` ON `batches` (`status`);--> statement-breakpoint
CREATE TABLE `medicines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generic` text NOT NULL,
	`brand` text,
	`spec` text,
	`form` text,
	`category` text,
	`purpose_notes` text,
	`daily_dose` real,
	`unit` text,
	`owner_id` integer,
	`auto_deduct` integer DEFAULT false NOT NULL,
	`auto_paused` integer DEFAULT false NOT NULL,
	`auto_from` text,
	`auto_accounted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `medicines_generic_idx` ON `medicines` (`generic`);--> statement-breakpoint
CREATE INDEX `medicines_category_idx` ON `medicines` (`category`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_name_unique` ON `members` (`name`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`type` text NOT NULL,
	`delta_qty` integer NOT NULL,
	`qty_after` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_events_batch_idx` ON `stock_events` (`batch_id`);