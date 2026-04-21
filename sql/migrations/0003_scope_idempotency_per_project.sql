ALTER TABLE "tasks" DROP CONSTRAINT "tasks_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "tasks_idempotency_idx";--> statement-breakpoint
DROP INDEX "project_memories_idempotency_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_project_key_idx" ON "tasks" USING btree ("project_id","idempotency_key") WHERE "tasks"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_idempotency_idx" ON "project_memories" USING btree ("project_id","idempotency_key") WHERE "project_memories"."idempotency_key" IS NOT NULL;