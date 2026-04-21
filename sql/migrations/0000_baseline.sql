-- pgvector extension 必須先啟用，project_memories.embedding 依賴 vector(1536)
-- 注意：drizzle-kit generate 會覆寫本檔；重新生成 baseline 後需手動補回此行
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "project_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"project_path" text,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[],
	"decisions" text[] DEFAULT '{}'::text[],
	"next_steps" text[] DEFAULT '{}'::text[],
	"embedding" vector(1536),
	"status" text DEFAULT 'active',
	"merged_into" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "embedding_idx" ON "project_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "project_id_idx" ON "project_memories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "status_idx" ON "project_memories" USING btree ("status");