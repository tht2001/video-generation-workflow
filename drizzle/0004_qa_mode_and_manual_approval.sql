ALTER TABLE `projects` ADD COLUMN `qa_mode` text DEFAULT 'loose' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shots` ADD COLUMN `qa_approved` integer DEFAULT 0 NOT NULL;
