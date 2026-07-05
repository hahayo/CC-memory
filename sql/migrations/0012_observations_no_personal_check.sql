-- 0012_observations_no_personal_check.sql
--
-- CC-memory v0.5 M1：project DB observations 反向 CHECK——個人列不得回流。
--
-- ⚠️  **只套 project DB** ⚠️
--
--   project DB 的 observations 物理上不該存 project_id='__personal__' 的列。
--   本 migration 加 DB 層 routing CHECK，任何旁路寫入 personal row 都會被拒。
--
--   與 0008 不同：observations 是 0011 新建空表，不存在既有 personal rows，
--   因此不需要 0008 當年的 delete-personal-data maintenance window 順序。
--
-- 套用方式：
--   DATABASE_URL=<project-db-url> tsx scripts/apply-migration.ts sql/migrations/0012_observations_no_personal_check.sql
--
-- 為何不放共用 src/db/schema.ts：
--   schema.ts 是 project DB 與 personal DB 共用的 Drizzle source。CHECK constraint
--   `project_id <> '__personal__'` 是 per-DB 不變量（project DB 才成立），不是
--   schema-wide property。放共用 schema 會污染 personal DB。

ALTER TABLE "observations"
  ADD CONSTRAINT "observations_no_personal_check"
  CHECK ("project_id" <> '__personal__');
