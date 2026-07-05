-- 0011_add_observations.sql — CC-memory v0.5 M1 observations shared schema
--
-- ⚠️ 套「兩側」DB（project + personal）：
--   observations 是共用 Drizzle schema 表，project/personal/test 三側欄位必須一致，
--   避免 Drizzle select 展開或 table checksum 因欄位 drift 失敗。
--
-- 本 migration 只含 additive schema、共用 indexes、共用 CHECK。
-- project-only / personal-only routing CHECK 分別在 0012 / 0013，不能放這裡。

CREATE TABLE "observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text NOT NULL,
  "session_id" text NOT NULL,
  "rollup_memory_id" uuid REFERENCES "project_memories"("id"),
  "type" text NOT NULL,
  "title" text NOT NULL,
  "subtitle" text,
  "facts" text[] DEFAULT '{}'::text[] NOT NULL,
  "concepts" text[] DEFAULT '{}'::text[] NOT NULL,
  "files" text[] DEFAULT '{}'::text[] NOT NULL,
  "narrative" text NOT NULL,
  "embedding" vector(1536),
  "discovery_tokens" integer NOT NULL,
  "source_hook" text NOT NULL,
  "content_hash" text NOT NULL,
  "writer_host" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "observations_type_check"
    CHECK ("type" IN ('decision','bugfix','feature','refactor','discovery','change')),
  CONSTRAINT "observations_status_check"
    CHECK ("status" IN ('active','archived')),
  CONSTRAINT "observations_discovery_tokens_check"
    CHECK ("discovery_tokens" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "observations_content_uniq"
  ON "observations" ("project_id", "session_id", "content_hash")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "observations_project_active_idx"
  ON "observations" ("project_id", "observed_at" DESC)
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "observations_session_idx"
  ON "observations" ("project_id", "session_id", "observed_at");
--> statement-breakpoint
CREATE INDEX "observations_status_idx"
  ON "observations" ("status");
--> statement-breakpoint
CREATE INDEX "observations_embedding_idx"
  ON "observations" USING hnsw ("embedding" vector_cosine_ops);
