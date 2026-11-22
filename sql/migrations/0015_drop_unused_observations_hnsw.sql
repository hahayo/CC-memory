-- 0015_drop_unused_observations_hnsw.sql — 刪掉從沒被查詢用到的 observations HNSW 索引
--
-- 2026-11-22 已手動套用到 project 與 personal 兩個正式 DB。
-- 原本 0015 是替 embedding_bge_m3 建 HNSW 索引；沒有套用到任何正式 DB，已改為本檔。
--
-- 為什麼刪：
--   - 搜尋 SQL 以 `1 - (embedding <=> q) DESC` 排序，pgvector 無法用 HNSW 服務這種排序；
--     pg_stat_user_indexes 顯示 observations_embedding_idx（project 側 3043 MB）idx_scan = 0。
--   - 每次非 HOT UPDATE／INSERT 都要維護它：bge-m3 補算試跑時，64 筆 UPDATE 讀了該索引 60,413 個區塊，
--     88/92 次抽樣卡在 IO:DataFileRead，速度每秒 0.5 筆；刪除後同一支補算每秒 30 筆以上。
--   - embedding_bge_m3 也不建 HNSW：同樣用不到，且會讓之後的寫入付同樣代價。
--     若日後把搜尋改成 `ORDER BY col <=> q ASC LIMIT k`，再另開 migration 建索引並驗證 recall。
--   - project_memories.embedding_idx（43 MB）保留不動。
--
-- 每個 chunk 只放一個 statement：多 statement 會被當成隱含 transaction，CONCURRENTLY 不能在 transaction 內跑。
--
-- rollback（照原定義重建；兩側都要跑，project 側需時較久）：
--   CREATE INDEX CONCURRENTLY observations_embedding_idx ON public.observations USING hnsw (embedding vector_cosine_ops);

DROP INDEX CONCURRENTLY IF EXISTS "observations_embedding_idx";
