// tests/services/delivery-queue.test.ts
//
// Personal-Hub Phase 3 — reminder_delivery_queue service 行為測試。
//
// 涵蓋：
//   - enqueueDue 冪等（ON CONFLICT DO NOTHING）
//   - enqueueDue 批量插入
//   - claimDeliverable：不撈未到期 / 撈到期
//   - markDelivered：status→delivered, delivered_at 非 null
//   - markFailed backoff：指數退避（4/8/16/32 分鐘），第 5 次→dead
//   - delivered 不重撈

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { connectTestDb, TEST_DB_URL, type Sql } from '../helpers/db.js';
import {
  enqueueDue,
  claimDeliverable,
  markDelivered,
  markFailed,
} from '../../src/services/delivery-queue.js';

describe('services/delivery-queue', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;

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
    await sql`DELETE FROM reminder_delivery_queue`;
    await sql`DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 'test-project')`;
    await sql`DELETE FROM tasks WHERE project_id = 'test-project'`;
  });

  // ----- helpers -----

  async function makeTask(): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, status)
      VALUES ('test-project', 'delivery queue test task', 'open')
      RETURNING id`;
    return rows[0].id;
  }

  async function countQueue(): Promise<number> {
    const r = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM reminder_delivery_queue`;
    return r[0].c;
  }

  async function getRow(id: string): Promise<{
    status: string;
    attempts: number;
    next_attempt_at: Date;
    delivered_at: Date | null;
    last_error: string | null;
  }> {
    const r = await sql<{
      status: string;
      attempts: number;
      next_attempt_at: Date;
      delivered_at: Date | null;
      last_error: string | null;
    }[]>`SELECT status, attempts, next_attempt_at, delivered_at, last_error
         FROM reminder_delivery_queue WHERE id = ${id}`;
    return r[0];
  }

  const SLOT = new Date('2026-06-01T12:00:00.000Z');

  // =========================================================================
  // enqueueDue
  // =========================================================================

  it('enqueueDue 冪等：相同 (task_id, scheduled_for) 插兩次，DB 只有 1 列', async () => {
    const taskId = await makeTask();
    const item = { taskId, scheduledFor: SLOT, payload: 'test payload' };

    const n1 = await enqueueDue(db, [item]);
    const n2 = await enqueueDue(db, [item]);

    expect(n1).toBe(1);
    expect(n2).toBe(0); // ON CONFLICT DO NOTHING
    expect(await countQueue()).toBe(1);
  });

  it('enqueueDue 批量：3 筆不同 task/slot → DB 3 列', async () => {
    const t1 = await makeTask();
    const t2 = await makeTask();
    const t3 = await makeTask();

    const items = [
      { taskId: t1, scheduledFor: SLOT, payload: 'p1' },
      { taskId: t2, scheduledFor: SLOT, payload: 'p2' },
      { taskId: t3, scheduledFor: SLOT, payload: 'p3' },
    ];

    const n = await enqueueDue(db, items);
    expect(n).toBe(3);
    expect(await countQueue()).toBe(3);
  });

  // =========================================================================
  // claimDeliverable
  // =========================================================================

  it('claimDeliverable 不撈未到期：next_attempt_at = far future → 回空陣列', async () => {
    const taskId = await makeTask();
    const futureSlot = new Date(Date.now() + 86_400_000); // +1 day
    await sql`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', ${futureSlot})`;

    const rows = await claimDeliverable(db, 10);
    expect(rows).toHaveLength(0);
  });

  it('claimDeliverable 撈到期：next_attempt_at = past + status=pending → 回 1 筆', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000); // -1 min
    await sql`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'my payload', 'pending', ${pastTime})`;

    const rows = await claimDeliverable(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe(taskId);
    expect(rows[0].payload).toBe('my payload');
  });

  // =========================================================================
  // markDelivered
  // =========================================================================

  it('markDelivered：status 變 delivered，delivered_at 非 null', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    await markDelivered(db, id);

    const row = await getRow(id);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  // =========================================================================
  // markFailed backoff
  // =========================================================================

  it('markFailed 第 1 次：attempts→1, status 仍 pending, next_attempt_at ≈ now+4min', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    const before = Date.now();
    const result = await markFailed(db, id, 'error msg 1');
    const after = Date.now();

    expect(result).toBe('retry');
    const row = await getRow(id);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('error msg 1');

    // next_attempt_at ≈ now + 4 min (±5s)
    const expectedMin = before + 4 * 60_000 - 5_000;
    const expectedMax = after + 4 * 60_000 + 5_000;
    const actual = row.next_attempt_at.getTime();
    expect(actual).toBeGreaterThanOrEqual(expectedMin);
    expect(actual).toBeLessThanOrEqual(expectedMax);
  });

  it('markFailed 第 2 次：attempts→2, next_attempt_at ≈ now+8min', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, attempts, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', 1, ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    const before = Date.now();
    const result = await markFailed(db, id, 'error 2');
    const after = Date.now();

    expect(result).toBe('retry');
    const row = await getRow(id);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('pending');

    const actual = row.next_attempt_at.getTime();
    expect(actual).toBeGreaterThanOrEqual(before + 8 * 60_000 - 5_000);
    expect(actual).toBeLessThanOrEqual(after + 8 * 60_000 + 5_000);
  });

  it('markFailed 第 3 次：attempts→3, next_attempt_at ≈ now+16min', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, attempts, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', 2, ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    const before = Date.now();
    const result = await markFailed(db, id, 'error 3');
    const after = Date.now();

    expect(result).toBe('retry');
    const row = await getRow(id);
    expect(row.attempts).toBe(3);

    const actual = row.next_attempt_at.getTime();
    expect(actual).toBeGreaterThanOrEqual(before + 16 * 60_000 - 5_000);
    expect(actual).toBeLessThanOrEqual(after + 16 * 60_000 + 5_000);
  });

  it('markFailed 第 4 次：attempts→4, next_attempt_at ≈ now+32min', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, attempts, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', 3, ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    const before = Date.now();
    const result = await markFailed(db, id, 'error 4');
    const after = Date.now();

    expect(result).toBe('retry');
    const row = await getRow(id);
    expect(row.attempts).toBe(4);

    const actual = row.next_attempt_at.getTime();
    expect(actual).toBeGreaterThanOrEqual(before + 32 * 60_000 - 5_000);
    expect(actual).toBeLessThanOrEqual(after + 32 * 60_000 + 5_000);
  });

  it('markFailed 第 5 次（dead）：status→dead', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, attempts, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', 4, ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    const result = await markFailed(db, id, 'fatal error');

    expect(result).toBe('dead');
    const row = await getRow(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(5);
  });

  // =========================================================================
  // delivered 不重撈
  // =========================================================================

  it('delivered 不重撈：markDelivered 後再 claimDeliverable → 回空', async () => {
    const taskId = await makeTask();
    const pastTime = new Date(Date.now() - 60_000);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO reminder_delivery_queue (task_id, scheduled_for, payload, status, next_attempt_at)
      VALUES (${taskId}, ${SLOT}, 'payload', 'pending', ${pastTime})
      RETURNING id`;
    const id = inserted[0].id;

    await markDelivered(db, id);
    const rows = await claimDeliverable(db, 10);
    expect(rows).toHaveLength(0);
  });
});
