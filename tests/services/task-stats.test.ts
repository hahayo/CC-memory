// tests/services/task-stats.test.ts
//
// getTaskStats — /hi 與 cron 取代 raw postgres 的結構化統計（plan 階段 0 (b)）。
//
// 契約重點（codex #P1-2）：
//   - 日界用 Asia/Taipei，不靠 server locale / LLM 自行推。
//   - date-only due_date 存成 UTC 午夜（= 台北當天 08:00），須用
//     (due_date AT TIME ZONE 'Asia/Taipei')::date 比較台北日期，避免當天上午被誤判逾期。
//   - today / overdue 只算 actionable（open / in_progress），排除 done / cancelled。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getTaskStats } from '../../src/services/tasks.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

describe('services/tasks — getTaskStats（Asia/Taipei 日界）', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const pid = `stats-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(postgres(TEST_DB_URL, { max: 1 }));
  });
  afterAll(async () => {
    if (sql) await sql.end();
  });
  afterEach(async () => {
    await sql`DELETE FROM tasks WHERE project_id = ${pid}`;
  });

  it('依台北日界正確分類 today / overdue / open / in_progress / completedRecently', async () => {
    // T1 open 今天到期（instant=now）→ today
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${pid}, 'T1 due today', 'open', now())`;
    // T2 open 兩天前到期 → overdue
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${pid}, 'T2 overdue', 'open', now() - interval '2 days')`;
    // T3 in_progress 兩天後到期 → 只算 in_progress
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${pid}, 'T3 future', 'in_progress', now() + interval '2 days')`;
    // T4 done 兩天前到期、剛完成 → 不算 overdue，算 completedRecently
    await sql`INSERT INTO tasks (project_id, title, status, due_date, completed_at) VALUES (${pid}, 'T4 done', 'done', now() - interval '2 days', now())`;
    // T5 cancelled → 全部排除
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${pid}, 'T5 cancelled', 'cancelled', now() - interval '2 days')`;
    // T6 date-only「今天」存成 UTC 午夜（= 台北 08:00）→ 必須算 today，不可 overdue
    await sql`INSERT INTO tasks (project_id, title, status, due_date) VALUES (${pid}, 'T6 date-only today', 'open', (((now() AT TIME ZONE 'Asia/Taipei')::date)::text || ' 00:00:00+00')::timestamptz)`;
    // T7 open 無到期日 → 算 open，不算 today/overdue
    await sql`INSERT INTO tasks (project_id, title, status) VALUES (${pid}, 'T7 no due', 'open')`;

    const stats = await getTaskStats(db, pid, { completedSinceDays: 7 });

    expect(stats.projectId).toBe(pid);
    expect(stats.today).toBe(2); // T1 + T6
    expect(stats.overdue).toBe(1); // T2（T6 不算、T4 done 不算）
    expect(stats.open).toBe(4); // T1 T2 T6 T7
    expect(stats.inProgress).toBe(1); // T3
    expect(stats.completedRecently).toBe(1); // T4
  });

  it('completedSinceDays 視窗外的 done 不計入 completedRecently', async () => {
    await sql`INSERT INTO tasks (project_id, title, status, completed_at) VALUES (${pid}, 'old done', 'done', now() - interval '30 days')`;
    const stats = await getTaskStats(db, pid, { completedSinceDays: 7 });
    expect(stats.completedRecently).toBe(0);
  });

  it('空專案 → 全 0', async () => {
    const stats = await getTaskStats(db, pid, { completedSinceDays: 7 });
    expect(stats).toMatchObject({ today: 0, overdue: 0, open: 0, inProgress: 0, completedRecently: 0 });
  });
});
