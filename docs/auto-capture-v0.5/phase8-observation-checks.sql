\set ON_ERROR_STOP on
\pset pager off
\echo '== read-only 確認 =='
SHOW default_transaction_read_only;
\echo '== 表結構 =='
\d project_memories
\d observations
\echo '== 總數（與基線 obs=14034 mem=226 比） =='
SELECT 'observations' t, count(*) total, count(*) FILTER (WHERE status='active') active FROM observations
UNION ALL SELECT 'project_memories', count(*), count(*) FILTER (WHERE status='active') FROM project_memories;
\echo '== 觀察窗新增（created_at >= 2026-08-29T15:15Z） =='
SELECT 'observations' t, count(*) n, count(*) FILTER (WHERE embedding IS NULL) embedding_null FROM observations WHERE created_at >= '2026-08-29T15:15:00Z'
UNION ALL SELECT 'project_memories', count(*), count(*) FILTER (WHERE embedding IS NULL) FROM project_memories WHERE created_at >= '2026-08-29T15:15:00Z';
\echo '== 檢查1：新增 observations 依 project_id =='
SELECT project_id, count(*) n, count(DISTINCT session_id) sessions FROM observations WHERE created_at >= '2026-08-29T15:15:00Z' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
\echo '== 檢查1：新增 rollup 依 project_id =='
SELECT project_id, count(*) n FROM project_memories WHERE created_at >= '2026-08-29T15:15:00Z' AND idempotency_key LIKE 'capture:v05:%' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
\echo '== 檢查1 抽查：最新 5 筆 observations =='
SELECT id, project_id, session_id, type, created_at, (embedding IS NULL) emb_null FROM observations ORDER BY created_at DESC LIMIT 5;
\echo '== 檢查2：rollup key 重複 =='
SELECT idempotency_key, count(*) FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%' GROUP BY 1 HAVING count(*)>1 LIMIT 10;
SELECT count(*) rollups_total, count(DISTINCT idempotency_key) distinct_keys FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%';
\echo '== 檢查3：__personal__ 零列 =='
SELECT (SELECT count(*) FROM observations WHERE project_id='__personal__') obs_personal, (SELECT count(*) FROM project_memories WHERE project_id='__personal__') mem_personal;
\echo '== 檢查5：全表 embedding NULL（active） =='
SELECT (SELECT count(*) FROM observations WHERE status='active' AND embedding IS NULL) obs_null, (SELECT count(*) FROM project_memories WHERE status='active' AND embedding IS NULL) mem_null;
\echo '== 檢查5：9/1 embedding 失敗時段（04:54Z–14:21Z）新列 =='
SELECT 'observations' t, count(*) n, count(*) FILTER (WHERE embedding IS NULL) emb_null FROM observations WHERE created_at BETWEEN '2026-09-01T04:50:00Z' AND '2026-09-01T14:25:00Z'
UNION ALL SELECT 'project_memories', count(*), count(*) FILTER (WHERE embedding IS NULL) FROM project_memories WHERE created_at BETWEEN '2026-09-01T04:50:00Z' AND '2026-09-01T14:25:00Z';
\echo '== 每日新增 observations =='
SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date d, count(*) FROM observations WHERE created_at >= '2026-08-29T15:15:00Z' GROUP BY 1 ORDER BY 1;
