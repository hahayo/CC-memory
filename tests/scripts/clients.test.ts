// tests/scripts/clients.test.ts
//
// adminClient raw-text 直通契約（對真 DB 跑）：
//   - timestamptz 微秒原文 round-trip（JS Date 只有毫秒，預設 client 會靜默截斷——P1）
//   - 非空 jsonb metadata round-trip（JS object 經 sql() helper 序列化路徑會壞——Codex B1）
// 驗證方式 mirror migrate 的 copy 路徑：SELECT * → 換 id → INSERT ${sql(row, ...cols)}
// → SQL 端 to_jsonb 比對兩列除 id 外完全相等。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DB_URL, connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { adminClient, type AdminSql } from '../../scripts/lib/clients.js';

const PERSONAL = '__personal__';

let db: Sql;
let admin: AdminSql;

beforeAll(async () => {
  db = await connectTestDb();
  await resetAllTables(db);
  admin = adminClient(TEST_DB_URL);
});

afterAll(async () => {
  await resetAllTables(db);
  await admin.end({ timeout: 5 });
  await db.end({ timeout: 5 });
});

describe('adminClient raw-text 直通', () => {
  it('timestamptz 解析回原文 string（含微秒），不是 JS Date', async () => {
    const id = randomUUID();
    await db`
      INSERT INTO tasks (id, project_id, title, remind_at)
      VALUES (${id}, ${PERSONAL}, 'ts probe', '2026-06-01T12:34:56.123456+00'::timestamptz)
    `;
    const [row] = await admin`SELECT remind_at FROM tasks WHERE id = ${id}`;
    expect(typeof row.remind_at).toBe('string');
    expect(row.remind_at).toContain('.123456');
  });

  it('jsonb 解析回原文 string，不是 JS object', async () => {
    const id = randomUUID();
    await db`
      INSERT INTO tasks (id, project_id, title, metadata)
      VALUES (${id}, ${PERSONAL}, 'jsonb probe',
              '{"nested": {"arr": [1, 2.5, null]}, "中文": "值", "b": true}'::jsonb)
    `;
    const [row] = await admin`SELECT metadata FROM tasks WHERE id = ${id}`;
    expect(typeof row.metadata).toBe('string');
    expect(JSON.parse(row.metadata)).toEqual({
      nested: { arr: [1, 2.5, null] },
      中文: '值',
      b: true,
    });
  });

  it('copy 路徑 round-trip：tasks 全列（微秒 ts + 非空 jsonb + text[] + int）無失真', async () => {
    const srcId = randomUUID();
    await db`
      INSERT INTO tasks (id, project_id, title, description, status, priority,
                         due_date, tags, remind_at, snooze_until, recurrence_interval_days, metadata)
      VALUES (${srcId}, ${PERSONAL}, 'copy probe', '描述 with unicode ✓', 'in_progress', 'high',
              '2026-07-01T00:00:00.000001+00'::timestamptz,
              ARRAY['tag-a','tag-b','中文標籤'],
              '2026-06-15T08:09:10.999999+00'::timestamptz,
              '2026-06-16T01:02:03.111111+00'::timestamptz,
              7,
              '{"source": {"todoist": {"id": 12345}}, "score": 0.123456789}'::jsonb)
    `;

    // mirror migrate copyTable：SELECT * → 換 id → sql(row, ...cols) INSERT
    const [src] = await admin`SELECT * FROM tasks WHERE id = ${srcId}`;
    const copyId = randomUUID();
    const copy: Record<string, unknown> = { ...src, id: copyId };
    const cols = Object.keys(copy);
    await admin`INSERT INTO tasks ${admin(copy as never, ...(cols as never[]))} ON CONFLICT (id) DO NOTHING`;

    // SQL 端比對：除 id 外完全相等（to_jsonb 含全部欄位——微秒、jsonb、array、int）
    const [cmp] = await admin`
      SELECT (to_jsonb(a) - 'id' = to_jsonb(b) - 'id') AS equal
      FROM tasks a, tasks b
      WHERE a.id = ${srcId} AND b.id = ${copyId}
    `;
    expect(cmp.equal).toBe(true);
  });

  it('copy 路徑 round-trip：project_memories（jsonb metadata + keywords array）無失真', async () => {
    const srcId = randomUUID();
    await db`
      INSERT INTO project_memories (id, project_id, type, summary, keywords, decisions, metadata)
      VALUES (${srcId}, ${PERSONAL}, 'decision', 'memory copy probe',
              ARRAY['kw1','kw2'], ARRAY['決策一'],
              '{"refs": [{"file": "a.ts", "line": 42}], "深": {"層": "值"}}'::jsonb)
    `;
    const [src] = await admin`SELECT * FROM project_memories WHERE id = ${srcId}`;
    const copyId = randomUUID();
    const copy: Record<string, unknown> = { ...src, id: copyId };
    const cols = Object.keys(copy);
    await admin`INSERT INTO project_memories ${admin(copy as never, ...(cols as never[]))} ON CONFLICT (id) DO NOTHING`;

    const [cmp] = await admin`
      SELECT (to_jsonb(a) - 'id' = to_jsonb(b) - 'id') AS equal
      FROM project_memories a, project_memories b
      WHERE a.id = ${srcId} AND b.id = ${copyId}
    `;
    expect(cmp.equal).toBe(true);
  });
});
