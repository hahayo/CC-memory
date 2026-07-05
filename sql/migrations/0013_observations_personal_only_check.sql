-- 0013_observations_personal_only_check.sql
--
-- CC-memory v0.5 M1：personal DB observations 收口。
--
-- ⚠️  **只在 personal DB 套用，不在 project DB 套用** ⚠️
--
--   personal DB 物理上只該存 project_id='__personal__' 的列。本 migration 加 CHECK
--   constraint 在 DB 層收口應用層邊界；任何旁路寫入非 __personal__ row 會被拒。
--
--   project DB 仍存所有專案 observations，套用此 CHECK 會擋住正常寫入。
--
-- 套用方式：
--   DATABASE_URL=<personal-db-url> tsx scripts/apply-migration.ts sql/migrations/0013_observations_personal_only_check.sql
--
-- 為何不放共用 src/db/schema.ts：
--   schema.ts 是 project DB 與 personal DB 共用的 Drizzle source。CHECK constraint
--   `project_id='__personal__'` 是 per-DB 不變量（personal DB 才成立），不是
--   schema-wide property。放共用 schema 會污染 project DB。

ALTER TABLE "observations"
  ADD CONSTRAINT "observations_personal_only_check"
  CHECK ("project_id" = '__personal__');
