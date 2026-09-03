-- Step B 唯讀擷取 v2：崩塌 project_id 的既有列（observations／project_memories），含守衛欄位 status／content_hash
SHOW default_transaction_read_only;
\t on
\a
\o /home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-rows.jsonl
SELECT row_to_json(r) FROM (
  SELECT 'observations' AS "table", id::text AS id, project_id AS old_project_id, session_id,
         rollup_memory_id::text AS rollup_memory_id, status, content_hash, created_at
    FROM observations WHERE project_id LIKE '\_%'
  UNION ALL
  SELECT 'project_memories', id::text, project_id,
         substring(idempotency_key from 'capture:v05:.*:([^:]+)$') AS session_id,
         NULL, status, NULL, created_at
    FROM project_memories WHERE project_id LIKE '\_%'
  ORDER BY 1, 4, 8
) r;
\o
\t off
\a
SELECT 'observations' AS t, count(*) FROM observations WHERE project_id LIKE '\_%'
UNION ALL SELECT 'project_memories', count(*) FROM project_memories WHERE project_id LIKE '\_%'
UNION ALL SELECT 'pm_rollup_key_null', count(*) FROM project_memories WHERE project_id LIKE '\_%' AND idempotency_key IS NULL
UNION ALL SELECT 'pm_non_capture_key', count(*) FROM project_memories WHERE project_id LIKE '\_%' AND idempotency_key IS NOT NULL AND idempotency_key NOT LIKE 'capture:v05:%'
UNION ALL SELECT 'obs_total', count(*) FROM observations
UNION ALL SELECT 'pm_total', count(*) FROM project_memories;
\t on
\a
\o /home/haha/.cache/cc-memory/stepb-2026-09-03/stepb-all-rollups.jsonl
SELECT row_to_json(r) FROM (
  SELECT id::text AS id, project_id, idempotency_key, status FROM project_memories
   WHERE idempotency_key LIKE 'capture:v05:%'
) r;
\o
\t off
\a
