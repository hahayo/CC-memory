// tests/services/reminders.test.ts
//
// Personal-Hub Phase 1b — reminders service 行為測試。
//
// 涵蓋（plan.md Service Layer + Data Model slot 三情況）：
//   mutation：setReminder（清 stale snooze）/ snoozeReminder / clearReminder + scope guard
//   getDueReminders：
//     - 一次性 due → 撈出 + log 一筆；再跑 → NOT EXISTS 排除（不重複、不進 batch）
//     - 不 starve（已投遞一次性塞滿 ≥limit + 1 新 due → 新 due 仍被處理）
//     - scope 隔離（別 project due 不撈）
//     - done/cancelled 不撈
//     - recurrence 不漂移（slot = anchor + (N-1)*interval）
//     - catch-up clamp（漏發多次 → 只一筆 log、remind_at 跳下一未來 slot）
//     - 一次性 snooze 投遞後不再響（不清 snooze 的關鍵測）
//     - setReminder 清 stale snooze → 新提醒在新時點 due
//     - ON CONFLICT DO NOTHING 不 abort 交易（同交易內其餘 row 仍處理 + commit）
//     - 併發兩連線同 due → 只一筆 reminder_log（SKIP LOCKED + unique）
//
// now 全程注入（advisor 第 3 點：比較 / 寫入 / advance 同一個值，不混 SQL now()）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { reminderLog } from '../../src/db/schema.js';
import {
  getDueReminders,
  setReminder,
  snoozeReminder,
  clearReminder,
} from '../../src/services/reminders.js';
import { NotFoundError, InvalidArgumentError } from '../../src/services/errors.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

// 固定基準時間；所有 now 注入，與 wall clock 無關。ms 精度（無 micros）確保 slot 比對一致。
const BASE = new Date('2026-06-01T12:00:00.000Z');
const at = (ms: number): Date => new Date(BASE.getTime() + ms);
const mins = (n: number): Date => at(n * 60_000);
const hours = (n: number): Date => at(n * 3_600_000);
const days = (n: number): Date => at(n * 86_400_000);

describe('services/reminders', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  const tp = `rem-svc-${randomUUID().slice(0, 8)}`;
  const other = `rem-other-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    pg = postgres(TEST_DB_URL, { max: 4 });
    db = drizzle(pg);
  });

  afterAll(async () => {
    if (pg) await pg.end();
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (${tp}, ${other}))`;
    await sql`DELETE FROM tasks WHERE project_id IN (${tp}, ${other})`;
  });

  // ----- helpers -----
  async function makeTask(opts: {
    projectId?: string;
    status?: string;
    remindAt?: Date | null;
    snoozeUntil?: Date | null;
    recurrence?: number | null;
    lastNotifiedAt?: Date | null;
  } = {}): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO tasks
        (project_id, title, status, remind_at, snooze_until, recurrence_interval_days, last_notified_at)
      VALUES
        (${opts.projectId ?? tp}, 'reminder task', ${opts.status ?? 'open'},
         ${opts.remindAt ?? null}, ${opts.snoozeUntil ?? null},
         ${opts.recurrence ?? null}, ${opts.lastNotifiedAt ?? null})
      RETURNING id`;
    return rows[0].id;
  }

  async function countLog(taskId: string): Promise<number> {
    const r = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM reminder_log WHERE task_id = ${taskId}`;
    return r[0].c;
  }

  async function logSlots(taskId: string): Promise<Date[]> {
    const r = await sql<{ scheduled_for: Date }[]>`
      SELECT scheduled_for FROM reminder_log WHERE task_id = ${taskId} ORDER BY scheduled_for ASC`;
    return r.map((x) => x.scheduled_for);
  }

  async function taskRow(taskId: string): Promise<{
    remind_at: Date | null;
    snooze_until: Date | null;
    last_notified_at: Date | null;
    recurrence_interval_days: number | null;
  }> {
    const r = await sql<
      {
        remind_at: Date | null;
        snooze_until: Date | null;
        last_notified_at: Date | null;
        recurrence_interval_days: number | null;
      }[]
    >`SELECT remind_at, snooze_until, last_notified_at, recurrence_interval_days FROM tasks WHERE id = ${taskId}`;
    return r[0];
  }

  // =========================================================================
  // mutation: setReminder / snoozeReminder / clearReminder
  // =========================================================================

  describe('setReminder', () => {
    it('sets remind_at + recurrence and clears stale snooze_until + last_notified_at', async () => {
      const id = await makeTask({
        remindAt: days(-2),
        snoozeUntil: days(-1),
        lastNotifiedAt: days(-1),
        recurrence: null,
      });
      const task = await setReminder(db, id, tp, { remindAt: days(1), recurrenceIntervalDays: 7 });
      expect(new Date(task.remindAt as Date).getTime()).toBe(days(1).getTime());
      expect(task.recurrenceIntervalDays).toBe(7);
      expect(task.snoozeUntil).toBeNull();
      expect(task.lastNotifiedAt).toBeNull();
    });

    it('defaults recurrence to null (one-shot) when omitted', async () => {
      const id = await makeTask();
      const task = await setReminder(db, id, tp, { remindAt: days(1) });
      expect(task.recurrenceIntervalDays).toBeNull();
    });

    it('rejects cross-project task id with NotFoundError (mutation scope guard)', async () => {
      const id = await makeTask({ projectId: other });
      await expect(setReminder(db, id, tp, { remindAt: days(1) })).rejects.toThrow(NotFoundError);
    });

    it('rejects recurrence <= 0 with InvalidArgumentError', async () => {
      const id = await makeTask();
      await expect(
        setReminder(db, id, tp, { remindAt: days(1), recurrenceIntervalDays: 0 })
      ).rejects.toThrow(InvalidArgumentError);
    });
  });

  describe('snoozeReminder', () => {
    it('sets snooze_until', async () => {
      const id = await makeTask({ remindAt: days(-1) });
      const task = await snoozeReminder(db, id, tp, hours(2));
      expect(new Date(task.snoozeUntil as Date).getTime()).toBe(hours(2).getTime());
    });

    it('rejects cross-project task id with NotFoundError', async () => {
      const id = await makeTask({ projectId: other });
      await expect(snoozeReminder(db, id, tp, hours(2))).rejects.toThrow(NotFoundError);
    });
  });

  describe('clearReminder', () => {
    it('nulls remind_at / snooze_until / recurrence', async () => {
      const id = await makeTask({ remindAt: days(-1), snoozeUntil: hours(1), recurrence: 7 });
      const task = await clearReminder(db, id, tp);
      expect(task.remindAt).toBeNull();
      expect(task.snoozeUntil).toBeNull();
      expect(task.recurrenceIntervalDays).toBeNull();
    });

    it('rejects cross-project task id with NotFoundError', async () => {
      const id = await makeTask({ projectId: other });
      await expect(clearReminder(db, id, tp)).rejects.toThrow(NotFoundError);
    });
  });

  // =========================================================================
  // getDueReminders
  // =========================================================================

  it('validates projectId (blank → InvalidArgumentError)', async () => {
    await expect(
      getDueReminders(db, { projectId: '   ', channel: 'cli', now: BASE })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('one-shot due → returned once + 1 log; rerun → excluded, still 1 log', async () => {
    const id = await makeTask({ remindAt: mins(-1), recurrence: null });
    const first = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(first.map((r) => r.task.id)).toContain(id);
    expect(first.find((r) => r.task.id === id)!.slot.getTime()).toBe(mins(-1).getTime());
    expect(await countLog(id)).toBe(1);

    // 一次性投遞後保留 remind_at；只更新 last_notified_at
    const row = await taskRow(id);
    expect(new Date(row.remind_at as Date).getTime()).toBe(mins(-1).getTime());
    expect(row.last_notified_at).not.toBeNull();

    const second = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(second.map((r) => r.task.id)).not.toContain(id);
    expect(await countLog(id)).toBe(1);
  });

  it('does NOT starve: K(≥limit) already-fired one-shots + 1 fresh due → fresh is processed', async () => {
    // 3 已投遞一次性（slot 較早且已 log）+ 1 新 due（slot 較晚、未 log）。limit=3。
    // 若 NOT EXISTS 在 LIMIT 之後（bug），3 個較早的已投遞會塞滿 batch、starve 新 due。
    const firedSlots = [hours(-3), hours(-2), hours(-1)];
    for (const slot of firedSlots) {
      const fid = await makeTask({ remindAt: slot, recurrence: null });
      await sql`INSERT INTO reminder_log (task_id, scheduled_for, channel) VALUES (${fid}, ${slot}, 'seed')`;
    }
    const fresh = await makeTask({ remindAt: mins(-30), recurrence: null });

    const due = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE, limit: 3 });
    expect(due.map((r) => r.task.id)).toContain(fresh);
  });

  it('scope isolation: due task in another project is not fetched', async () => {
    const mine = await makeTask({ remindAt: mins(-1) });
    await makeTask({ projectId: other, remindAt: mins(-1) });
    const due = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    const ids = due.map((r) => r.task.id);
    expect(ids).toContain(mine);
    expect(ids.length).toBe(1);
  });

  it('done / cancelled tasks are not fetched', async () => {
    await makeTask({ status: 'done', remindAt: mins(-1) });
    await makeTask({ status: 'cancelled', remindAt: mins(-1) });
    const open = await makeTask({ status: 'open', remindAt: mins(-1) });
    const due = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(due.map((r) => r.task.id)).toEqual([open]);
  });

  it('recurrence does not drift: Nth slot = anchor + (N-1)*interval (grid-anchored)', async () => {
    // anchor remind_at = BASE，interval = 1 day。注入 now 推進三輪。
    const id = await makeTask({ remindAt: BASE, recurrence: 1 });

    await getDueReminders(db, { projectId: tp, channel: 'cli', now: at(60_000) }); // BASE + 1min
    await getDueReminders(db, { projectId: tp, channel: 'cli', now: new Date(days(1).getTime() + 60_000) });
    await getDueReminders(db, { projectId: tp, channel: 'cli', now: new Date(days(2).getTime() + 60_000) });

    const slots = await logSlots(id);
    expect(slots.map((s) => s.getTime())).toEqual([
      BASE.getTime(),
      days(1).getTime(),
      days(2).getTime(),
    ]);
    // 投遞三次後 remind_at 落在下一未來網格 = BASE + 3 day
    const row = await taskRow(id);
    expect(new Date(row.remind_at as Date).getTime()).toBe(days(3).getTime());
  });

  it('catch-up clamps: missed multiple cycles → only 1 log, remind_at jumps to next future slot', async () => {
    // anchor BASE，interval 1 day，now = BASE + 3.5 day（漏發 3+ 次）
    const id = await makeTask({ remindAt: BASE, recurrence: 1 });
    const now = new Date(days(3).getTime() + 43_200_000); // BASE + 3.5 day
    const due = await getDueReminders(db, { projectId: tp, channel: 'cli', now });
    expect(due.map((r) => r.task.id)).toContain(id);
    expect(await countLog(id)).toBe(1);
    // 本次 slot = anchor（BASE）；remind_at clamp 到下一未來 = BASE + 4 day
    expect((await logSlots(id))[0].getTime()).toBe(BASE.getTime());
    expect(new Date((await taskRow(id)).remind_at as Date).getTime()).toBe(days(4).getTime());
  });

  it('one-shot snooze: fires at snooze slot, then NOT re-fires (snooze_until retained)', async () => {
    // 一次性，remind_at 過去，snooze_until 過去（snooze 為有效 due 時點）
    const id = await makeTask({ remindAt: mins(-10), snoozeUntil: mins(-1), recurrence: null });
    const first = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(first.find((r) => r.task.id === id)!.slot.getTime()).toBe(mins(-1).getTime()); // slot = snooze
    expect(await countLog(id)).toBe(1);

    // 一次性不清 snooze；下輪 COALESCE = snooze（已 log）→ NOT EXISTS 排除 → 不再響
    const row = await taskRow(id);
    expect(new Date(row.snooze_until as Date).getTime()).toBe(mins(-1).getTime());
    const second = await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(second.map((r) => r.task.id)).not.toContain(id);
    expect(await countLog(id)).toBe(1);
  });

  it('setReminder clears stale snooze so the new remind_at fires', async () => {
    // 先製造已投遞的 stale snooze（slot=snooze 已入 log）
    const id = await makeTask({ remindAt: mins(-10), snoozeUntil: mins(-1), recurrence: null });
    await getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE });
    expect(await countLog(id)).toBe(1);

    // 重設 remind_at（清 stale snooze）；新時點應再 due
    await setReminder(db, id, tp, { remindAt: hours(1) });
    const now2 = new Date(hours(1).getTime() + 60_000);
    const due = await getDueReminders(db, { projectId: tp, channel: 'cli', now: now2 });
    expect(due.map((r) => r.task.id)).toContain(id);
    expect(due.find((r) => r.task.id === id)!.slot.getTime()).toBe(hours(1).getTime());
  });

  it('ON CONFLICT DO NOTHING does not abort the transaction (other ops still commit)', async () => {
    // 確定性驗證 getDueReminders 賴以避免 abort 的 SQL primitive：
    // 同交易內，撞 unique 的 insert 走 ON CONFLICT → RETURNING 空、交易存活、後續 insert 成功 + commit。
    const a = await makeTask({ remindAt: mins(-1) });
    const b = await makeTask({ remindAt: mins(-2) });
    const slotA = mins(-1);
    const slotB = mins(-2);
    await sql`INSERT INTO reminder_log (task_id, scheduled_for, channel) VALUES (${a}, ${slotA}, 'pre')`;

    await db.transaction(async (tx: typeof db) => {
      const conflict = await tx
        .insert(reminderLog)
        .values({ taskId: a, scheduledFor: slotA, channel: 'cli' })
        .onConflictDoNothing({ target: [reminderLog.taskId, reminderLog.scheduledFor] })
        .returning({ id: reminderLog.id });
      expect(conflict.length).toBe(0); // race 沒搶到

      const ok = await tx
        .insert(reminderLog)
        .values({ taskId: b, scheduledFor: slotB, channel: 'cli' })
        .onConflictDoNothing({ target: [reminderLog.taskId, reminderLog.scheduledFor] })
        .returning({ id: reminderLog.id });
      expect(ok.length).toBe(1); // 交易未 abort，後續 insert 正常
    });

    expect(await countLog(a)).toBe(1); // 仍只有 pre-seed 那筆
    expect(await countLog(b)).toBe(1); // commit 成功
  });

  it('concurrency: two connections on the same due task → exactly one reminder_log', async () => {
    const id = await makeTask({ remindAt: mins(-1), recurrence: null });
    const pg2 = postgres(TEST_DB_URL, { max: 1 });
    const db2 = drizzle(pg2);
    try {
      const [r1, r2] = await Promise.all([
        getDueReminders(db, { projectId: tp, channel: 'cli', now: BASE }),
        getDueReminders(db2, { projectId: tp, channel: 'cli', now: BASE }),
      ]);
      const total =
        r1.filter((r) => r.task.id === id).length + r2.filter((r) => r.task.id === id).length;
      expect(total).toBe(1); // SKIP LOCKED：只有一條連線拿到
      expect(await countLog(id)).toBe(1); // unique backstop：只一筆 log
    } finally {
      await pg2.end();
    }
  });
});
