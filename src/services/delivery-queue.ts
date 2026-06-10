// src/services/delivery-queue.ts
//
// Personal-Hub Phase 3 — reminder_delivery_queue service。
//
// at-least-once durable queue：
//   - enqueueDue：批量 INSERT ON CONFLICT DO NOTHING（冪等）
//   - claimDeliverable：原子 UPDATE + lease（poller-vs-poller 防重投，撐過 statement）
//   - markDelivered：標記成功
//   - markFailed：指數退避（4/8/16/32 min），第 5 次失敗 → dead
//
// 退避序列（attempts 從 0 開始計，0→1 = 第 1 次失敗）：
//   attempts 0 → +4min
//   attempts 1 → +8min
//   attempts 2 → +16min
//   attempts 3 → +32min
//   attempts ≥ 4 → dead（第 5 次失敗）

import { and, eq, sql } from 'drizzle-orm';
import { reminderDeliveryQueue } from '../db/schema.js';
import type { DbClient } from './types.js';

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

// claim 租約長度：必須 > 最壞批次投遞時間（CLAIM_LIMIT 20 × 10s timeout ≈ 200s）。
// poller crash 後租約到期，列自動重新可投遞（at-least-once）。
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Claim deliverable rows（durable lease）：
 *   單一原子 UPDATE 把 next_attempt_at 推進 NOW()+lease，
 *   子查詢用 FOR UPDATE SKIP LOCKED 防多 poller 同 statement 互搶。
 *
 * 純 SELECT ... FOR UPDATE 不夠：row lock 在 statement 結束即釋放，撐不到
 * HTTP 投遞完成。lease 讓 claim 持久化——另一個 poller 在租約內看不到該列；
 * crash 則租約到期自動重新可投遞，不需額外 status（保持 CHECK 三態不變）。
 */
export async function claimDeliverable(db: DbClient, limit: number): Promise<QueueRow[]> {
  const rows = await db.execute(sql`
    UPDATE reminder_delivery_queue
    SET next_attempt_at = NOW() + make_interval(secs => ${CLAIM_LEASE_MS / 1000})
    WHERE id IN (
      SELECT id FROM reminder_delivery_queue
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, task_id AS "taskId", payload, attempts
  `);

  return rows as unknown as QueueRow[];
}

/**
 * 標記成功投遞：status='delivered', delivered_at=NOW()。
 * status guard：只轉換 pending 列，不覆寫 dead/delivered。
 */
export async function markDelivered(db: DbClient, id: string): Promise<void> {
  await db
    .update(reminderDeliveryQueue)
    .set({
      status: 'delivered',
      deliveredAt: sql`NOW()`,
    })
    .where(and(eq(reminderDeliveryQueue.id, id), eq(reminderDeliveryQueue.status, 'pending')));
}

/**
 * 標記失敗並設定指數退避（原子 UPDATE，無 TOCTOU）。
 *
 * 單一 UPDATE ... RETURNING：DB 端計算 attempts+1 與 status，避免 SELECT→UPDATE 競態。
 * 間隔序列（attempts 0-3）：4/8/16/32 min。attempts+1 >= 5 → status='dead'。
 */
export async function markFailed(
  db: DbClient,
  id: string,
  error: string
): Promise<'retry' | 'dead'> {
  // 原子：attempts+1 並依新值決定 status 和 next_attempt_at。
  // BACKOFF_MS 陣列以 SQL CASE 展開（避免 JS 端讀舊值後競態）。
  const updated = await db.execute(sql`
    UPDATE reminder_delivery_queue
    SET
      attempts        = attempts + 1,
      last_error      = ${error},
      status          = CASE WHEN attempts + 1 >= 5 THEN 'dead' ELSE 'pending' END,
      next_attempt_at = CASE
        WHEN attempts + 1 >= 5 THEN next_attempt_at
        WHEN attempts = 0 THEN NOW() + INTERVAL '4 minutes'
        WHEN attempts = 1 THEN NOW() + INTERVAL '8 minutes'
        WHEN attempts = 2 THEN NOW() + INTERVAL '16 minutes'
        ELSE                    NOW() + INTERVAL '32 minutes'
      END
    WHERE id = ${id} AND status = 'pending'
    RETURNING attempts, status
  `);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (updated as any)[0] as { attempts: number; status: string } | undefined;
  return row?.status === 'dead' ? 'dead' : 'retry';
}
