-- 0014_add_embedding_bge_m3.sql — 本機 bge-m3 embedding 欄位（EMBEDDING_PROVIDER=local）
--
-- ⚠️ 套「兩側」DB（project + personal），與 0011 相同的 additive 紀律：
--   project_memories / observations 是共用 Drizzle schema 表，project/personal/test
--   三側欄位必須一致，避免 Drizzle select 展開或 table checksum 因欄位 drift 失敗。
--
-- ⚠️ 必須在部署包含此 schema 變更的程式碼「之前」對兩側 DB 套用：
--   Drizzle select-all / insert 會列出 schema 全部欄位，DB 缺欄會讓所有
--   memories/observations 查詢爆 column does not exist。
--   程式碼只需要本檔（0014）：runtime Drizzle 不直接用 index；
--   0015 的 HNSW index 純屬效能（缺它時 local semantic search 走 seq scan 仍可用）。
--
-- 每個 chunk 先 SET lock_timeout='5s'：
--   ADD COLUMN 只需短暫的 ACCESS EXCLUSIVE lock，但排隊等長 transaction 時
--   會擋住後面所有讀寫。寧可 5 秒內 fail fast（重跑即可）也不要默默卡死流量。
--
-- 本 migration 全為 additive。
--   rollback：先 rollback 0015（DROP INDEX），再
--     SET lock_timeout='5s'; ALTER TABLE project_memories DROP COLUMN IF EXISTS embedding_bge_m3;
--     SET lock_timeout='5s'; ALTER TABLE observations DROP COLUMN IF EXISTS embedding_bge_m3;
--
-- 套用方式（兩側都要跑）：
--   DATABASE_URL=<project-db-url>  tsx scripts/apply-migration.ts sql/migrations/0014_add_embedding_bge_m3.sql
--   DATABASE_URL=<personal-db-url> tsx scripts/apply-migration.ts sql/migrations/0014_add_embedding_bge_m3.sql

SET lock_timeout = '5s';
ALTER TABLE "project_memories" ADD COLUMN IF NOT EXISTS "embedding_bge_m3" vector(1024);
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE "observations" ADD COLUMN IF NOT EXISTS "embedding_bge_m3" vector(1024);
