-- Step B 彩排 fixture（只在本機測試 PG 5438 跑）
DELETE FROM observations WHERE session_id LIKE 'sess-rehearsal-%';
DELETE FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%';
INSERT INTO project_memories (id, project_id, type, status, summary, idempotency_key)
VALUES
  ('11111111-1111-1111-1111-111111111111', '__', 'session', 'active', 'old rollup 1', 'capture:v05:__:sess-rehearsal-1'),
  ('22222222-2222-2222-2222-222222222222', '__', 'session', 'active', 'old rollup 2', 'capture:v05:__:sess-rehearsal-2'),
  ('33333333-3333-3333-3333-333333333333', 'AI_Copilot', 'session', 'active', 'new rollup 2 already exists', 'capture:v05:AI_Copilot:sess-rehearsal-2');
INSERT INTO observations (id, project_id, session_id, rollup_memory_id, type, title, narrative, observed_at, status, discovery_tokens, source_hook, content_hash, writer_host)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '__', 'sess-rehearsal-1', '11111111-1111-1111-1111-111111111111', 'decision', 'o1', 'n1', now(), 'active', 1, 'rehearsal', 'hash-o1', 'rehearsal'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '__', 'sess-rehearsal-2', '22222222-2222-2222-2222-222222222222', 'decision', 'o2', 'n2', now(), 'active', 1, 'rehearsal', 'hash-o2', 'rehearsal'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '__', 'sess-rehearsal-2', '22222222-2222-2222-2222-222222222222', 'decision', 'o3', 'n3', now(), 'active', 1, 'rehearsal', 'hash-o3', 'rehearsal'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9', '__', 'sess-rehearsal-9', NULL, 'decision', 'o9', 'n9', now(), 'active', 1, 'rehearsal', 'hash-o9', 'rehearsal');
SELECT 'before' AS phase, id, project_id, idempotency_key, status FROM project_memories WHERE idempotency_key LIKE 'capture:v05:%:sess-rehearsal-%' ORDER BY id;
SELECT 'before' AS phase, id, project_id, rollup_memory_id FROM observations WHERE session_id LIKE 'sess-rehearsal-%' ORDER BY id;
