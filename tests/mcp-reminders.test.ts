// tests/mcp-reminders.test.ts
//
// Personal-Hub Phase 1c — MCP reminder tool dispatch（cc_task_set_reminder / cc_task_snooze）。
//   - happy path（project-mode + forced-mode）
//   - mutation scope guard（跨 project → NOT_FOUND）
//   - ISO 驗證（壞值 / 缺值 → INVALID_ARGUMENT）
//
// 既有 task tool 契約不動（regression 由全套測試保障）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { handleToolCall } from '../src/index.js';
import { connectTestDb, type Sql } from './helpers/db.js';
import { PERSONAL_PROJECT_ID } from '../src/services/scope-policy.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

const FORCED_PERSONAL = { forcedProjectId: PERSONAL_PROJECT_ID };

function errCode(res: Awaited<ReturnType<typeof handleToolCall>>): string | undefined {
  if (res.isError !== true) return undefined;
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text).error.code as string;
}

describe('MCP reminder tools (Phase 1c)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let testDb: any;
  const tp = `mcp-rem-${randomUUID().slice(0, 8)}`;
  const other = `mcp-rem-other-${randomUUID().slice(0, 8)}`;
  const personalIds: string[] = [];

  async function makeTask(projectId = tp): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO tasks (project_id, title) VALUES (${projectId}, 'mcp reminder task') RETURNING id`;
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = await connectTestDb();
    testDb = drizzle(postgres(TEST_DB_URL, { max: 2 }));
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (${tp}, ${other}))`;
    await sql`DELETE FROM tasks WHERE project_id IN (${tp}, ${other})`;
    // forced-mode 測試用的 __personal__ row 只按 id 清，避免動到真實個人資料
    if (personalIds.length > 0) {
      await sql`DELETE FROM reminder_log WHERE task_id = ANY(${personalIds})`;
      await sql`DELETE FROM tasks WHERE id = ANY(${personalIds})`;
      personalIds.length = 0;
    }
  });

  // ---------- cc_task_set_reminder ----------

  it('set_reminder happy path persists remind_at', async () => {
    const id = await makeTask();
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: '2026-07-01T09:00:00Z' },
      testDb
    );
    expect(res.isError).not.toBe(true);
    const rows = await sql<{ remind_at: Date }[]>`SELECT remind_at FROM tasks WHERE id = ${id}`;
    expect(new Date(rows[0].remind_at).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  it('set_reminder with recurrence_interval_days persists recurrence', async () => {
    const id = await makeTask();
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: '2026-07-01T09:00:00Z', recurrence_interval_days: 7 },
      testDb
    );
    expect(res.isError).not.toBe(true);
    const rows = await sql<{ recurrence_interval_days: number }[]>`
      SELECT recurrence_interval_days FROM tasks WHERE id = ${id}`;
    expect(rows[0].recurrence_interval_days).toBe(7);
  });

  it('set_reminder cross-project id → NOT_FOUND (mutation scope guard)', async () => {
    const id = await makeTask(other);
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: '2026-07-01T09:00:00Z' },
      testDb
    );
    expect(errCode(res)).toBe('NOT_FOUND');
  });

  it('set_reminder invalid remind_at → INVALID_ARGUMENT', async () => {
    const id = await makeTask();
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: 'not-a-date' },
      testDb
    );
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('set_reminder missing remind_at → INVALID_ARGUMENT', async () => {
    const id = await makeTask();
    const res = await handleToolCall('cc_task_set_reminder', { project_id: tp, id }, testDb);
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('set_reminder rejects impossible calendar date with time (no silent rollover)', async () => {
    // 2026-02-31T10:00:00Z 經 new Date() 會靜默 rollover 成 2026-03-03 → 提醒響在錯的時點。
    // reminder 是「時間」語意，必須拒絕不可能日期，而非 rollover。
    const id = await makeTask();
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: '2026-02-31T10:00:00Z' },
      testDb
    );
    expect(errCode(res)).toBe('INVALID_ARGUMENT');
  });

  it('set_reminder forced-mode without selector resolves to __personal__', async () => {
    const id = await makeTask(PERSONAL_PROJECT_ID);
    personalIds.push(id);
    const res = await handleToolCall(
      'cc_task_set_reminder',
      { id, remind_at: '2026-07-01T09:00:00Z' },
      testDb,
      FORCED_PERSONAL
    );
    expect(res.isError).not.toBe(true);
    const rows = await sql<{ remind_at: Date }[]>`SELECT remind_at FROM tasks WHERE id = ${id}`;
    expect(rows[0].remind_at).not.toBeNull();
  });

  // ---------- cc_task_snooze ----------

  it('snooze happy path persists snooze_until', async () => {
    const id = await makeTask();
    await handleToolCall(
      'cc_task_set_reminder',
      { project_id: tp, id, remind_at: '2026-07-01T09:00:00Z' },
      testDb
    );
    const res = await handleToolCall(
      'cc_task_snooze',
      { project_id: tp, id, snooze_until: '2026-07-02T09:00:00Z' },
      testDb
    );
    expect(res.isError).not.toBe(true);
    const rows = await sql<{ snooze_until: Date }[]>`SELECT snooze_until FROM tasks WHERE id = ${id}`;
    expect(new Date(rows[0].snooze_until).toISOString()).toBe('2026-07-02T09:00:00.000Z');
  });

  it('snooze cross-project id → NOT_FOUND', async () => {
    const id = await makeTask(other);
    const res = await handleToolCall(
      'cc_task_snooze',
      { project_id: tp, id, snooze_until: '2026-07-02T09:00:00Z' },
      testDb
    );
    expect(errCode(res)).toBe('NOT_FOUND');
  });
});
