SELECT 'db_now_utc' AS k, now() AT TIME ZONE 'UTC' AS v;
SELECT 'obs_new_since_stepA_total' AS k, count(*) FROM observations WHERE created_at >= '2026-09-02T23:13:00Z';
SELECT 'obs_new_since_stepA_collapsed' AS k, count(*) FROM observations WHERE created_at >= '2026-09-02T23:13:00Z' AND project_id LIKE '\_%';
SELECT 'pm_new_since_stepA_collapsed' AS k, count(*) FROM project_memories WHERE created_at >= '2026-09-02T23:13:00Z' AND project_id LIKE '\_%';
SELECT project_id, count(*) FROM observations WHERE created_at >= '2026-09-02T23:13:00Z' GROUP BY 1 ORDER BY 2 DESC;
SELECT 'obs_collapsed_total' AS k, count(*) FROM observations WHERE project_id LIKE '\_%';
SELECT 'pm_collapsed_total' AS k, count(*) FROM project_memories WHERE project_id LIKE '\_%';
SELECT 'obs_collapsed_max_created' AS k, max(created_at) FROM observations WHERE project_id LIKE '\_%';
