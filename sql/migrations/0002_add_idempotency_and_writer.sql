ALTER TABLE "project_memories" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "writer_host" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "writer_host" text;--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_idempotency_idx" ON "project_memories" USING btree ("idempotency_key") WHERE "project_memories"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "search_feedback" ADD CONSTRAINT "search_feedback_arrays_same_length" CHECK (cardinality("search_feedback"."result_ids") = cardinality("search_feedback"."result_project_ids")
          AND cardinality("search_feedback"."result_ids") = cardinality("search_feedback"."rank_positions")
          AND ("search_feedback"."scores" IS NULL OR cardinality("search_feedback"."scores") = cardinality("search_feedback"."result_ids")));