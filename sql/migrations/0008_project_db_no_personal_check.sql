-- 0008_project_db_no_personal_check.sql
--
-- Phase 3 v0.4：project DB 反向 CHECK——個人列「不得回流」的結構性保證（Codex A2）。
-- 與 0007 互為鏡像：0007 只套 personal DB（只准 __personal__），0008 只套 project DB
-- （禁止 __personal__）。雙向 DB 層保證，漏改 env / 舊 client 寫錯邊在 DB 層被拒。
--
-- ⚠️  **只套 project DB、且只能在 delete-personal-data --execute COMMIT 之後** ⚠️
--
--   先套會被既有個人列違反（ALTER TABLE ADD CONSTRAINT 會全表驗證）。
--   maintenance window 順序：migrate copy → preflight post-copy → delete --execute
--   → 套本 migration → preflight post-delete（D4 會 probe 本 CHECK 拒寫）。
--
-- 套用方式：
--   DATABASE_URL=<project-db-url> tsx scripts/apply-migration.ts sql/migrations/0008_project_db_no_personal_check.sql
--
-- bot_user_state 不加：user-level state（active_project_id 合法持有 personal 標記，
-- 處置見 handback runbook）。
--
-- 為何不放共用 src/db/schema.ts：同 0007——per-DB 不變量，不是 schema-wide property。

ALTER TABLE "project_memories"
  ADD CONSTRAINT "project_memories_no_personal_check"
  CHECK ("project_id" <> '__personal__');
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_no_personal_check"
  CHECK ("project_id" <> '__personal__');
--> statement-breakpoint
ALTER TABLE "search_feedback"
  ADD CONSTRAINT "search_feedback_no_personal_check"
  CHECK (("query_project_id" IS DISTINCT FROM '__personal__')
         AND NOT ('__personal__' = ANY("result_project_ids")));
