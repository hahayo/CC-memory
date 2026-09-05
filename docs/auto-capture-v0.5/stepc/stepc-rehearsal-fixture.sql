-- Step C 彩排 fixture（只打本機測試 PG）。三個 session：
--   sess-c-1 類 1：目標 T1（AI_Copilot，1 筆 linked obs a1）＋舊 rollup O1(__: x1,x2)、O2(___: x3)
--   sess-c-2 類 2：舊 rollup O3(__: x4,x5)、O4(___: x6)，新 id 下沒有 rollup → 存活者 O3
--   sess-c-3 類 3：舊 rollup O5(__: x7)，只有 encoded-dir 證據 → 不動
DELETE FROM observations WHERE session_id LIKE 'sess-c-%';
DELETE FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-c-%';

INSERT INTO project_memories (id, project_id, type, summary, status, idempotency_key, metadata, created_at, updated_at) VALUES
 ('10000000-0000-0000-0000-000000000001', 'AI_Copilot', 'session', 'T1 target summary', 'active', 'capture:v05:AI_Copilot:sess-c-1',
  '{"capture":{"version":"0.5","session_id":"sess-c-1","observation_ids":["a1000000-0000-0000-0000-000000000001"],"spool_offsets":[{"start":0,"end":10}],"transcript_sources":[{"path_hash":"h1","start":100,"end":200}],"summarize_count":1,"discovery_tokens":5,"empty_observation_windows":[]},"embedding_policy":{"rules_version":"x"}}',
  '2026-09-03', '2020-01-01'),
 ('10000000-0000-0000-0000-000000000002', '__', 'session', 'O1 old summary', 'active', 'capture:v05:__:sess-c-1',
  '{"capture":{"version":"0.5","session_id":"sess-c-1","observation_ids":["e1000000-0000-0000-0000-000000000001","e1000000-0000-0000-0000-000000000002"],"spool_offsets":[{"start":0,"end":30}],"transcript_sources":[{"path_hash":"h1","start":0,"end":100}],"summarize_count":1,"discovery_tokens":7,"empty_observation_windows":[]}}',
  '2026-08-29', '2020-01-01'),
 ('10000000-0000-0000-0000-000000000003', '___', 'session', 'O2 old summary', 'active', 'capture:v05:___:sess-c-1',
  '{"capture":{"version":"0.5","session_id":"sess-c-1","observation_ids":["e1000000-0000-0000-0000-000000000003"],"spool_offsets":[{"start":0,"end":20}],"transcript_sources":[{"path_hash":"h1","start":50,"end":120}],"summarize_count":1,"discovery_tokens":3,"empty_observation_windows":[]}}',
  '2026-08-30', '2020-01-01'),
 ('10000000-0000-0000-0000-000000000004', '__', 'session', 'O3 old summary', 'active', 'capture:v05:__:sess-c-2',
  '{"capture":{"version":"0.5","session_id":"sess-c-2","observation_ids":["e1000000-0000-0000-0000-000000000004","e1000000-0000-0000-0000-000000000005"],"spool_offsets":[{"start":0,"end":30}],"transcript_sources":[{"path_hash":"h2","start":0,"end":50}],"summarize_count":1,"discovery_tokens":7,"empty_observation_windows":[]}}',
  '2026-08-29', '2020-01-01'),
 ('10000000-0000-0000-0000-000000000005', '___', 'session', 'O4 old summary', 'active', 'capture:v05:___:sess-c-2',
  '{"capture":{"version":"0.5","session_id":"sess-c-2","observation_ids":["e1000000-0000-0000-0000-000000000006"],"spool_offsets":[{"start":0,"end":20}],"transcript_sources":[{"path_hash":"h2","start":50,"end":90}],"summarize_count":1,"discovery_tokens":3,"empty_observation_windows":[]}}',
  '2026-08-30', '2020-01-01'),
 ('10000000-0000-0000-0000-000000000006', '__', 'session', 'O5 old summary', 'active', 'capture:v05:__:sess-c-3',
  '{"capture":{"version":"0.5","session_id":"sess-c-3","observation_ids":["e1000000-0000-0000-0000-000000000007"],"spool_offsets":[{"start":0,"end":20}],"transcript_sources":[{"path_hash":"h3","start":0,"end":40}],"summarize_count":1,"discovery_tokens":3,"empty_observation_windows":[]}}',
  '2026-08-30', '2020-01-01');

INSERT INTO observations (id, project_id, session_id, rollup_memory_id, type, title, narrative, discovery_tokens, source_hook, content_hash, writer_host, status, observed_at) VALUES
 ('a1000000-0000-0000-0000-000000000001', 'AI_Copilot', 'sess-c-1', '10000000-0000-0000-0000-000000000001', 'change', 'a1', 'a1', 1, 'r', 'hash-a1', 'r', 'active', '2026-09-03'),
 ('e1000000-0000-0000-0000-000000000001', '__',  'sess-c-1', '10000000-0000-0000-0000-000000000002', 'change', 'x1', 'x1', 1, 'r', 'hash-x1', 'r', 'active', '2026-08-29'),
 ('e1000000-0000-0000-0000-000000000002', '__',  'sess-c-1', '10000000-0000-0000-0000-000000000002', 'change', 'x2', 'x2', 1, 'r', 'hash-x2', 'r', 'active', '2026-08-29'),
 ('e1000000-0000-0000-0000-000000000003', '___', 'sess-c-1', '10000000-0000-0000-0000-000000000003', 'change', 'x3', 'x3', 1, 'r', 'hash-x3', 'r', 'active', '2026-08-30'),
 ('e1000000-0000-0000-0000-000000000004', '__',  'sess-c-2', '10000000-0000-0000-0000-000000000004', 'change', 'x4', 'x4', 1, 'r', 'hash-x4', 'r', 'active', '2026-08-29'),
 ('e1000000-0000-0000-0000-000000000005', '__',  'sess-c-2', '10000000-0000-0000-0000-000000000004', 'change', 'x5', 'x5', 1, 'r', 'hash-x5', 'r', 'active', '2026-08-29'),
 ('e1000000-0000-0000-0000-000000000006', '___', 'sess-c-2', '10000000-0000-0000-0000-000000000005', 'change', 'x6', 'x6', 1, 'r', 'hash-x6', 'r', 'active', '2026-08-30'),
 ('e1000000-0000-0000-0000-000000000007', '__',  'sess-c-3', '10000000-0000-0000-0000-000000000006', 'change', 'x7', 'x7', 1, 'r', 'hash-x7', 'r', 'active', '2026-08-30');
