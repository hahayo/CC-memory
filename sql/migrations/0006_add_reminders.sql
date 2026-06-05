CREATE TABLE "reminder_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" text DEFAULT 'unknown' NOT NULL,
	"writer_host" text
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snooze_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurrence_interval_days" integer;--> statement-breakpoint
ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_log_task_slot_uniq" ON "reminder_log" USING btree ("task_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "reminder_log_task_idx" ON "reminder_log" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "tasks" USING btree (COALESCE("snooze_until", "remind_at")) WHERE "tasks"."remind_at" IS NOT NULL AND "tasks"."status" IN ('open','in_progress');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurrence_interval_check" CHECK ("tasks"."recurrence_interval_days" IS NULL OR "tasks"."recurrence_interval_days" > 0);