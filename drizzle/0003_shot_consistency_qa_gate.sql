ALTER TABLE shots ADD COLUMN qa_status TEXT NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE shots ADD COLUMN qa_reason TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shots ADD COLUMN qa_model TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shots ADD COLUMN qa_checked_at INTEGER;
--> statement-breakpoint
ALTER TABLE shots ADD COLUMN qa_attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE shots ADD COLUMN verify_exempt INTEGER NOT NULL DEFAULT 0;
