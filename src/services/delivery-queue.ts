// src/services/delivery-queue.ts
//
// Personal-Hub Phase 3 — reminder_delivery_queue service。
//
// at-least-once durable queue：
//   - enqueueDue：批量 INSERT ON CONFLICT DO NOTHING（冪等）
//   - claimDeliverable：FOR UPDATE SKIP LOCKED 選列（poller-vs-poller 防重投）
//   - markDelivered：標記成功
//   - markFailed：指數退避（4/8/16/32 min），第 5 次失敗 → dead
//
// 退避序列（attempts 從 0 開始計，0→1 = 第 1 次失敗）：
//   attempts 0 → +4min
//   attempts 1 → +8min
//   attempts 2 → +16min
//   attempts 3 → +32min
//   attempts ≥ 4 → dead（第 5 次失敗）

import { and, eq, lte, sql } from 'drizzle-orm';
import { reminderDeliveryQueue } from '../db/schema.js';
import type { DbClient } from './types.js';

// 退避間隔序列（毫秒）：attempts=0→4min, 1→8min, 2→16min, 3→32min
const BACKOFF_MS: readonly number[] = [
  4 * 60_000,
  8 * 60_000,
  16 * 60_000,
  32 * 60_000,
];

export interface QueueRow {
  id: string;
  taskId: string;
  payload: string;
  attempts: number;
}

/**
 * 批量 enqueue：INSERT ON CONFLICT (task_id, scheduled_for) DO NOTHING。
 * 回傳實際插入的列數（0 = 全部已存在，冪等）。
 */
export async function enqueueDue(
  db: DbClient,
  items: { taskId: string; scheduledFor: Date; payload: string }[]
): Promise<number> {
  if (items.length === 0) return 0;

  const rows = await db
    .insert(reminderDeliveryQueue)
    .values(
      items.map((item) => ({
        taskId: item.taskId,
        scheduledFor: item.scheduledFor,
        payload: item.payload,
      }))
    )
    .onConflictDoNothing({
      target: [reminderDeliveryQueue.taskId, reminderDeliveryQueue.scheduledFor],
    })
    .returning({ id: reminderDeliveryQueue.id });

  return rows.length;
}

/**
 * Claim deliverable rows：
 *   WHERE status='pending' AND next_attempt_at <= now()
 *   ORDER BY next_attempt_at
 *   FOR UPDATE SKIP LOCKED
 *   LIMIT limit
 *
 * FOR UPDATE SKIP LOCKED 讓多個 poller 不互搶同一列。
 */
export async function claimDeliverable(db: DbClient, limit: number): Promise<QueueRow[]> {
  const rows = await db
    .select({
      id: reminderDeliveryQueue.id,
      taskId: reminderDeliveryQueue.taskId,
      payload: reminderDeliveryQueue.payload,
      attempts: reminderDeliveryQueue.attempts,
    })
    .from(reminderDeliveryQueue)
    .where(
      and(
        eq(reminderDeliveryQueue.status, 'pending'),
        lte(reminderDeliveryQueue.nextAttemptAt, sql`NOW()`)
      )
    )
    .orderBy(reminderDeliveryQueue.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  return rows;
}

/**
 * 標記成功投遞：status='delivered', delivered_at=NOW()。
 */
export async function markDelivered(db: DbClient, id: string): Promise<void> {
  await db
    .update(reminderDeliveryQueue)
    .set({
      status: 'delivered',
      deliveredAt: sql`NOW()`,
    })
    .where(eq(reminderDeliveryQueue.id, id));
}

/**
 * 標記失敗並設定指數退避。
 * - attempts < 4（即 0,1,2,3）→ 仍 'pending'，設 next_attempt_at = now + BACKOFF_MS[attempts]，回 'retry'
 * - attempts >= 4（第 5 次失敗）→ status='dead'，回 'dead'
 */
export async function markFailed(
  db: DbClient,
  id: string,
  error: string
): Promise<'retry' | 'dead'> {
  // 先讀目前 attempts
  const current = await db
    .select({ attempts: reminderDeliveryQueue.attempts })
    .from(reminderDeliveryQueue)
    .where(eq(reminderDeliveryQueue.id, id));

  const currentAttempts: number = current[0]?.attempts ?? 0;
  const newAttempts = currentAttempts + 1;

  if (currentAttempts >= 4) {
    // 第 5 次（或更多）→ dead
    await db
      .update(reminderDeliveryQueue)
      .set({
        status: 'dead',
        attempts: newAttempts,
        lastError: error,
      })
      .where(eq(reminderDeliveryQueue.id, id));
    return 'dead';
  }

  // retry with backoff
  const backoffMs = BACKOFF_MS[currentAttempts] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  const nextAttemptAt = new Date(Date.now() + backoffMs);

  await db
    .update(reminderDeliveryQueue)
    .set({
      status: 'pending',
      attempts: newAttempts,
      nextAttemptAt,
      lastError: error,
    })
    .where(eq(reminderDeliveryQueue.id, id));

  return 'retry';
}
