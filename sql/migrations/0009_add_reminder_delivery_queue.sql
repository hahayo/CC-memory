CREATE TABLE "reminder_delivery_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "scheduled_for" timestamptz NOT NULL,
  "payload" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'telegram',
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  CONSTRAINT "rdq_status_check" CHECK ("status" IN ('pending','delivered','dead')),
  CONSTRAINT "rdq_slot_uniq" UNIQUE ("task_id", "scheduled_for")
);
--> statement-breakpoint
CREATE INDEX "rdq_due_idx" ON "reminder_delivery_queue" ("status", "next_attempt_at");
