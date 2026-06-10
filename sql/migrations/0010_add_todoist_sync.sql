-- 0010_add_todoist_sync.sql — A3d Todoist→cc-memory 單向 sync
--
-- ⚠️ 套「兩側」DB（project + personal），與 0007/0009 的 personal-only 紀律不同：
--   1. todoist_id 加在共用 tasks 表——Drizzle select 會展開 schema 全欄位，
--      project DB 缺欄會讓所有 task 查詢爆 column does not exist。
--   2. 遷移工具鏈 tableChecksum 用 to_jsonb 全列雜湊，兩側欄位集必須一致。
-- project 側 todoist_id 恆 NULL、sync_state 閒置（todoist 同步只發生在 personal）。

ALTER TABLE "tasks" ADD COLUMN "todoist_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_todoist_id_uniq" ON "tasks" ("todoist_id") WHERE "todoist_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_check";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_check"
  CHECK ("source" IN ('manual','telegram','claude-code','codex','mcp','todoist'));
--> statement-breakpoint
CREATE TABLE "sync_state" (
  "resource" text PRIMARY KEY,
  "sync_token" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
