SELECT 'obs_collapsed_remaining' AS k, count(*) FROM observations WHERE project_id LIKE '\_%';
SELECT 'pm_collapsed_remaining' AS k, count(*) FROM project_memories WHERE project_id LIKE '\_%';
SELECT 'cross_project_fk_now' AS k, count(*) FROM observations o JOIN project_memories p ON p.id = o.rollup_memory_id WHERE o.project_id <> p.project_id;
SELECT 'pm_dup_active_keys' AS k, count(*) FROM (SELECT project_id, idempotency_key FROM project_memories WHERE status='active' AND idempotency_key IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) x;
SELECT project_id, count(*) FROM observations WHERE project_id LIKE '\_%' GROUP BY 1 ORDER BY 2 DESC LIMIT 8;
SELECT 'obs_total' AS k, count(*) FROM observations;
SELECT 'personal_leak' AS k, count(*) FROM observations WHERE project_id='__personal__';
