-- 0007_personal_db_check_constraint.sql
--
-- Phase 3 v0.4：獨立 personal DB 收口（見 docs/personal-hub/decisions/ADR-001-phase3-separate-db.md）。
--
-- ⚠️  **只在 personal DB 套用，不在 project DB 套用** ⚠️
--
--   personal DB 物理上只該存 project_id='__personal__' 的列。本 migration 加 CHECK
--   constraint 在 DB 層收口應用層 forced-mode 邊界；任何走旁路（migration script、
--   admin connection、psql）寫入非 __personal__ 列會被 DB 拒。
--
--   project DB 仍存所有專案資料含其他 namespace，套用此 CHECK 會擋住所有正常寫入。
--
-- 套用方式：
--   DATABASE_URL=<personal-db-url> tsx scripts/apply-migration.ts sql/migrations/0007_personal_db_check_constraint.sql
--
-- 為何不放共用 src/db/schema.ts：
--   schema.ts 是 project DB 與 personal DB 共用的 Drizzle source。CHECK constraint
--   `project_id='__personal__'` 是 per-DB 不變量（personal DB 才成立），不是
--   schema-wide property。放共用 schema 會污染 project DB（drizzle-kit generate
--   會把 CHECK 帶到下一個 project DB migration 上，所有 project insert 失敗）。
--
-- 端對端驗收：scripts/preflight.ts --mode post-copy case 11 嘗試 INSERT
--   非 __personal__ row 應被本 CHECK 拒。

ALTER TABLE "project_memories"
  ADD CONSTRAINT "project_memories_personal_only_check"
  CHECK ("project_id" = '__personal__');
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_personal_only_check"
  CHECK ("project_id" = '__personal__');
