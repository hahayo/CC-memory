// tests/db/reminders-schema.test.ts
//
// Personal-Hub Phase 1a — reminder schema 兩層 gate：
//   1. Unit 反射（不連 DB）：tasks 新 4 欄 + reminderLog 表物件本身帶正確欄位。
//   2. Integration（連 test PG，驗 migration 實際生效）：
//      - reminder 欄位可寫讀
//      - reminder_log unique(task_id, scheduled_for) 去重硬背線
//      - tasks_recurrence_interval_check（=0 / 負數 擋；正數 / NULL 放行）
//      - reminders_due_idx 是 COALESCE(snooze_until, remind_at) 的 partial functional index
//        （advisor 第 1 點：此 index 純效能、correctness 靠 service 的 NOT EXISTS，
//         無行為測試會抓壞掉的 index → 用 pg_indexes.indexdef 斷言守住 generate 保真度）

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tasks, reminderLog } from '../../src/db/schema.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

// ---------------------------------------------------------------------------
// 1. Unit 反射
// ---------------------------------------------------------------------------

describe('Phase 1a schema (unit): tasks reminder columns', () => {
  const timestampCols = ['remindAt', 'lastNotifiedAt', 'snoozeUntil'] as const;

  for (const name of timestampCols) {
    it(`has ${name} column (timestamptz, nullable)`, () => {
      const cols = Object.keys(tasks);
      expect(cols).toContain(name);
      const col = (tasks as Record<string, unknown>)[name] as {
        dataType: string;
        notNull?: boolean;
      };
      expect(col).toBeDefined();
      expect(col.dataType).toBe('date');
      expect(col.notNull).toBeFalsy();
    });
  }

  it('has recurrenceIntervalDays column (integer, nullable)', () => {
    const cols = Object.keys(tasks);
    expect(cols).toContain('recurrenceIntervalDays');
    const col = (tasks as Record<string, unknown>).recurrenceIntervalDays as {
      dataType: string;
      notNull?: boolean;
    };
    expect(col).toBeDefined();
    expect(col.dataType).toBe('number');
    expect(col.notNull).toBeFalsy();
  });
});

describe('Phase 1a schema (unit): reminderLog table', () => {
  it('exports reminderLog with expected columns', () => {
    expect(reminderLog).toBeDefined();
    const cols = Object.keys(reminderLog);
    for (const name of ['id', 'taskId', 'scheduledFor', 'firedAt', 'channel', 'writerHost']) {
      expect(cols).toContain(name);
    }
  });

  it('scheduledFor / taskId are notNull; writerHost nullable', () => {
    const r = reminderLog as Record<string, { notNull?: boolean }>;
    expect(r.scheduledFor.notNull).toBe(true);
    expect(r.taskId.notNull).toBe(true);
    expect(r.writerHost.notNull).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 2. Integration（連 test PG）
// ---------------------------------------------------------------------------

describe('Phase 1a schema (integration) — reminder columns / reminder_log / CHECK / index', () => {
  let sql: Sql;
  const tp = `rem-sch-${randomUUID().slice(0, 8)}`;

  async function newTask(): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO tasks (project_id, title) VALUES (${tp}, 'reminder task')
      RETURNING id
    `;
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = await connectTestDb();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    // reminder_log 經 FK 參照 tasks → 先刪 log 再刪 task
    await sql`DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ${tp})`;
    await sql`DELETE FROM tasks WHERE project_id = ${tp}`;
  });

  it('tasks reminder columns persist (remind_at / last_notified_at / snooze_until / recurrence_interval_days)', async () => {
    const id = await newTask();
    await sql`
      UPDATE tasks SET
        remind_at = '2026-06-05T00:00:00Z',
        last_notified_at = '2026-06-04T00:00:00Z',
        snooze_until = '2026-06-06T00:00:00Z',
        recurrence_interval_days = 7
      WHERE id = ${id}
    `;
    const rows = await sql<
      { recurrence_interval_days: number; remind_at: Date }[]
    >`SELECT recurrence_interval_days, remind_at FROM tasks WHERE id = ${id}`;
    expect(rows[0].recurrence_interval_days).toBe(7);
    expect(rows[0].remind_at).toBeInstanceOf(Date);
  });

  it('reminder_log rejects duplicate (task_id, scheduled_for) — unique hard backstop', async () => {
    const id = await newTask();
    const slot = '2026-06-05T09:00:00Z';
    await sql`
      INSERT INTO reminder_log (task_id, scheduled_for, channel)
      VALUES (${id}, ${slot}, 'cli')
    `;
    await expect(
      sql`
        INSERT INTO reminder_log (task_id, scheduled_for, channel)
        VALUES (${id}, ${slot}, 'cli')
      `
    ).rejects.toThrow(/reminder_log_task_slot_uniq|duplicate key/);
  });

  it('reminder_log allows same task different slot', async () => {
    const id = await newTask();
    await sql`INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${id}, '2026-06-05T09:00:00Z')`;
    await sql`INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${id}, '2026-06-06T09:00:00Z')`;
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM reminder_log WHERE task_id = ${id}
    `;
    expect(rows[0].c).toBe(2);
  });

  it('reminder_log channel defaults to unknown when omitted', async () => {
    const id = await newTask();
    await sql`INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${id}, '2026-06-05T09:00:00Z')`;
    const rows = await sql<{ channel: string }[]>`
      SELECT channel FROM reminder_log WHERE task_id = ${id}
    `;
    expect(rows[0].channel).toBe('unknown');
  });

  it('tasks_recurrence_interval_check rejects 0', async () => {
    const id = await newTask();
    await expect(
      sql`UPDATE tasks SET recurrence_interval_days = 0 WHERE id = ${id}`
    ).rejects.toThrow(/tasks_recurrence_interval_check|violates check/);
  });

  it('tasks_recurrence_interval_check rejects negative', async () => {
    const id = await newTask();
    await expect(
      sql`UPDATE tasks SET recurrence_interval_days = -1 WHERE id = ${id}`
    ).rejects.toThrow(/tasks_recurrence_interval_check|violates check/);
  });

  it('tasks_recurrence_interval_check allows positive and NULL', async () => {
    const id = await newTask();
    await sql`UPDATE tasks SET recurrence_interval_days = 1 WHERE id = ${id}`;
    await sql`UPDATE tasks SET recurrence_interval_days = NULL WHERE id = ${id}`;
    const rows = await sql<{ recurrence_interval_days: number | null }[]>`
      SELECT recurrence_interval_days FROM tasks WHERE id = ${id}
    `;
    expect(rows[0].recurrence_interval_days).toBeNull();
  });

  it('reminders_due_idx is a COALESCE(snooze_until, remind_at) partial functional index', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'reminders_due_idx'
    `;
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef.toLowerCase();
    // functional expression：COALESCE(snooze_until, remind_at)
    expect(def).toContain('coalesce');
    expect(def).toContain('snooze_until');
    expect(def).toContain('remind_at');
    // partial：WHERE remind_at IS NOT NULL AND status IN ('open','in_progress')
    expect(def).toContain('where');
    expect(def).toContain("status");
    expect(def).toContain('open');
    expect(def).toContain('in_progress');
  });
});
