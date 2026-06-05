// src/services/reminders.ts
//
// Personal-Hub Phase 1 — reminder service。
//
// 設計重點（plan.md Data Model / Service Layer）：
//   1. 所有 mutation（set/snooze/clear）WHERE id=$id AND project_id=$projectId，
//      affected=0 → NotFoundError（mutation scope guard，防跨 namespace 用 UUID 改別人的 row，
//      與 tasks.ts updateTask Step1.5/Step6 同模式）。
//   2. getDueReminders 一個交易內：FOR UPDATE SKIP LOCKED 選列（NOT EXISTS 預過濾在 LIMIT 前）
//      → INSERT reminder_log ON CONFLICT DO NOTHING → 依 slot 三情況 advance。
//   3. 去重雙機制分工：
//      - NOT EXISTS（LIMIT 前）：把已投遞 slot 移出候選集，是「不 starve / 正確終止」主機制。
//      - reminder_log unique(task_id, scheduled_for) + ON CONFLICT DO NOTHING：併發 race 最後背線
//        （第二個 INSERT RETURNING 空 → 跳過、不丟錯、不 abort 交易）。
//   4. now 全程用同一個注入值（比較 / firedAt / recurrence advance），不混 SQL now()，
//      確保 recurrence 不漂移 / catch-up clamp 可決定性測試。
//   5. slot 精度不變式：remind_at / snooze_until 一律經 JS Date（ms 精度）寫入，
//      slot = row.snoozeUntil ?? row.remindAt 與 DB COALESCE 同值 → NOT EXISTS 比對一致。

import { and, eq, inArray, sql } from 'drizzle-orm';
import { tasks, reminderLog, type Task } from '../db/schema.js';
import type {
  DbClient,
  DueReminder,
  GetDueRemindersOptions,
  SetReminderInput,
} from './types.js';
import { NotFoundError, InvalidArgumentError } from './errors.js';
import { resolveWriterHost } from '../utils/writer-host.js';

const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;
const ACTIONABLE_STATUSES = ['open', 'in_progress'] as const;

function assertProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new InvalidArgumentError('reminders: projectId 不可為空（scope 隔離必要）', { projectId });
  }
}

function assertValidDate(d: unknown, field: string): asserts d is Date {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError(`${field} 必須為有效 Date`, { field });
  }
}

function normalizeRecurrence(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidArgumentError('recurrenceIntervalDays 必須為正整數或 null', {
      recurrenceIntervalDays: raw,
    });
  }
  return raw;
}

/**
 * recurrence advance：以 remind_at 網格錨點推下一未來 slot（不以實際投遞時間 → 不漂移）。
 * 從 anchor+step 起跳（至少推一步），漏發多次則持續加步直到 > now（catch-up clamp，只投本次一筆）。
 */
function computeNextRemindAt(anchor: Date, intervalDays: number, now: Date): Date {
  const stepMs = intervalDays * DAY_MS;
  let next = anchor.getTime() + stepMs;
  while (next <= now.getTime()) {
    next += stepMs;
  }
  return new Date(next);
}

// ---------------------------------------------------------------------------
// mutation：set / snooze / clear（皆帶 mutation scope guard）
// ---------------------------------------------------------------------------

/**
 * 共用 mutation scope guard：UPDATE ... WHERE id=$id AND project_id=$projectId RETURNING；
 * affected=0 → NotFoundError（防跨 namespace 用 UUID 改別人的 row，與 updateTask 同模式）。
 * updatedAt 一律刷新。
 */
async function updateReminderScoped(
  db: DbClient,
  taskId: string,
  projectId: string,
  setPayload: Record<string, unknown>
): Promise<Task> {
  const updated = await db
    .update(tasks)
    .set({ ...setPayload, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .returning();
  if (updated.length === 0) {
    throw new NotFoundError('Task not found', { id: taskId });
  }
  return updated[0] as Task;
}

export async function setReminder(
  db: DbClient,
  taskId: string,
  projectId: string,
  opts: SetReminderInput
): Promise<Task> {
  assertProjectId(projectId);
  assertValidDate(opts.remindAt, 'remindAt');
  const recurrence = normalizeRecurrence(opts.recurrenceIntervalDays);

  // reschedule 必清 snooze_until + last_notified_at：殘留舊 snooze 經 COALESCE 會蓋過新
  // remind_at，或舊 slot 已 log 被 NOT EXISTS 排除 → 新提醒永不 due（plan slot 表）。
  return updateReminderScoped(db, taskId, projectId, {
    remindAt: opts.remindAt,
    recurrenceIntervalDays: recurrence,
    snoozeUntil: null,
    lastNotifiedAt: null,
  });
}

export async function snoozeReminder(
  db: DbClient,
  taskId: string,
  projectId: string,
  until: Date
): Promise<Task> {
  assertProjectId(projectId);
  assertValidDate(until, 'until');
  return updateReminderScoped(db, taskId, projectId, { snoozeUntil: until });
}

export async function clearReminder(
  db: DbClient,
  taskId: string,
  projectId: string
): Promise<Task> {
  assertProjectId(projectId);
  return updateReminderScoped(db, taskId, projectId, {
    remindAt: null,
    snoozeUntil: null,
    recurrenceIntervalDays: null,
    lastNotifiedAt: null,
  });
}

// ---------------------------------------------------------------------------
// getDueReminders：撈 due + claim + 去重 + advance
// ---------------------------------------------------------------------------

export async function getDueReminders(
  db: DbClient,
  opts: GetDueRemindersOptions
): Promise<DueReminder[]> {
  assertProjectId(opts.projectId);
  const { projectId, channel } = opts;
  const now = opts.now ?? new Date();
  assertValidDate(now, 'now');
  const writerHost = opts.writerHost ?? resolveWriterHost();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new InvalidArgumentError('reminders: limit 必須為非負整數', { limit });
  }

  return db.transaction(async (tx: DbClient) => {
    // 1. 篩選 + claim：scope 隔離 + NOT EXISTS 預過濾（LIMIT 前）+ FOR UPDATE SKIP LOCKED。
    const candidates = (await tx
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, [...ACTIONABLE_STATUSES]),
          eq(tasks.projectId, projectId),
          sql`${tasks.remindAt} IS NOT NULL`,
          // now 以 ISO 字串 + ::timestamptz cast 傳入：raw sql 片段無 column type context，
          // 直接內嵌 JS Date 會讓 postgres-js 用 text serializer 噴 ERR_INVALID_ARG_TYPE。
          sql`COALESCE(${tasks.snoozeUntil}, ${tasks.remindAt}) <= ${now.toISOString()}::timestamptz`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${reminderLog} rl
            WHERE rl.task_id = ${tasks.id}
              AND rl.scheduled_for = COALESCE(${tasks.snoozeUntil}, ${tasks.remindAt})
          )`
        )
      )
      .orderBy(sql`COALESCE(${tasks.snoozeUntil}, ${tasks.remindAt})`)
      .limit(limit)
      .for('update', { skipLocked: true })) as Task[];

    const result: DueReminder[] = [];
    for (const row of candidates) {
      const slot = (row.snoozeUntil ?? row.remindAt) as Date;
      // 2. INSERT reminder_log ON CONFLICT DO NOTHING（不可 catch unique_violation → 會 abort 交易）。
      const inserted = await tx
        .insert(reminderLog)
        .values({ taskId: row.id, scheduledFor: slot, firedAt: now, channel, writerHost })
        .onConflictDoNothing({ target: [reminderLog.taskId, reminderLog.scheduledFor] })
        .returning({ id: reminderLog.id });
      if (inserted.length === 0) {
        continue; // 同輪併發 race：別連線搶先入此 slot → 跳過不 advance、不計回傳（交易仍存活）。
      }
      // 3. advance（依 slot 三情況，見 plan Data Model）。
      if (row.recurrenceIntervalDays === null) {
        // 一次性（含 snooze）：保留 remind_at / snooze_until；下輪該 slot 已入 log → NOT EXISTS 排除。
        await tx.update(tasks).set({ lastNotifiedAt: now }).where(eq(tasks.id, row.id));
      } else {
        // recurrence：從 remind_at 錨點推下一未來 slot、清 snooze、更新 last_notified。
        const next = computeNextRemindAt(row.remindAt as Date, row.recurrenceIntervalDays, now);
        await tx
          .update(tasks)
          .set({ remindAt: next, snoozeUntil: null, lastNotifiedAt: now })
          .where(eq(tasks.id, row.id));
      }
      result.push({ task: row, slot });
    }
    return result;
  });
}
