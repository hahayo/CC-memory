// tests/scripts/checksum.test.ts
//
// checksum lib 對真 DB 跑（最高價值：SQL 真跑才抓得到 row_to_jsonb 級錯誤——
// 原 preflight 的 checksum 用了不存在的 row_to_jsonb()，從未對真 DB 驗證過）。
//
// 兩連線「不同 TimeZone」下 checksum 不變性：to_jsonb 對 timestamptz 的文字化
// 跟連線 TZ 走；checksum 函式自含 SET LOCAL TIME ZONE 'UTC'（Codex B7）才不會
// false-mismatch。

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DB_URL, connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import {
  reminderLogChecksum,
  tableChecksum,
} from '../../scripts/lib/checksum.js';

const PERSONAL = '__personal__';

let db: Sql;
let connUtc: postgres.Sql;
let connTaipei: postgres.Sql;

beforeAll(async () => {
  db = await connectTestDb();
  await resetAllTables(db);
  // 兩條不同 TimeZone 的連線——模擬「兩個 admin 終端 TZ 設定不同」情境
  connUtc = postgres(TEST_DB_URL, { max: 1, connection: { TimeZone: 'UTC' } });
  connTaipei = postgres(TEST_DB_URL, { max: 1, connection: { TimeZone: 'Asia/Taipei' } });

  // seed：個人 task（微秒 timestamp）+ reminder_log + 個人 memory（非空 jsonb）
  const taskId = randomUUID();
  await db`
    INSERT INTO tasks (id, project_id, title, remind_at, metadata)
    VALUES (${taskId}, ${PERSONAL}, 'checksum probe task',
            '2026-06-01T12:34:56.123456+00'::timestamptz,
            '{"nested": {"deep": [1, 2, 3]}, "中文": "值"}'::jsonb)
  `;
  await db`
    INSERT INTO reminder_log (task_id, scheduled_for, channel)
    VALUES (${taskId}, '2026-06-01T12:34:56.654321+00'::timestamptz, 'hermes')
  `;
  await db`
    INSERT INTO project_memories (project_id, type, summary, metadata)
    VALUES (${PERSONAL}, 'session', 'checksum probe memory',
            '{"k": "v", "n": 1.5}'::jsonb)
  `;
});

afterAll(async () => {
  await resetAllTables(db);
  await connUtc.end({ timeout: 5 });
  await connTaipei.end({ timeout: 5 });
  await db.end({ timeout: 5 });
});

describe('tableChecksum', () => {
  it('SQL 真跑不炸（to_jsonb 存在；row_to_jsonb 級錯誤在此會浮現）', async () => {
    const ck = await tableChecksum(connUtc, 'tasks');
    expect(ck).toMatch(/^[0-9a-f]{32}$/); // MD5 hex
  });

  it('兩連線異 TimeZone 下 checksum 不變（函式自含 SET LOCAL UTC，Codex B7）', async () => {
    for (const table of ['tasks', 'project_memories']) {
      const a = await tableChecksum(connUtc, table);
      const b = await tableChecksum(connTaipei, table);
      expect(a, `table=${table}`).toBe(b);
    }
  });

  it('資料不同 → checksum 不同（sanity：不是回傳常數）', async () => {
    const before = await tableChecksum(connUtc, 'tasks');
    const extraId = randomUUID();
    await db`
      INSERT INTO tasks (id, project_id, title) VALUES (${extraId}, ${PERSONAL}, 'extra row')
    `;
    const after = await tableChecksum(connUtc, 'tasks');
    expect(after).not.toBe(before);
    await db`DELETE FROM tasks WHERE id = ${extraId}`;
    expect(await tableChecksum(connUtc, 'tasks')).toBe(before);
  });

  it('空結果集 → "empty" 哨兵值', async () => {
    await db`CREATE TABLE IF NOT EXISTS tmp_checksum_empty (id uuid PRIMARY KEY, project_id text NOT NULL)`;
    try {
      const ck = await tableChecksum(connUtc, 'tmp_checksum_empty');
      expect(ck).toBe('empty');
    } finally {
      await db`DROP TABLE IF EXISTS tmp_checksum_empty`;
    }
  });
});

describe('reminderLogChecksum', () => {
  it('FK-scoped checksum SQL 真跑 + 異 TZ 不變', async () => {
    const a = await reminderLogChecksum(connUtc);
    const b = await reminderLogChecksum(connTaipei);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
  });
});
