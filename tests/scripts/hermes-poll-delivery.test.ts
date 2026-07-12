// tests/scripts/hermes-poll-delivery.test.ts
//
// at-least-once delivery poller 行為測試。
//
// 使用 Node.js http.createServer 建立 mock Telegram server，覆寫
// TELEGRAM_API_BASE 讓 runOneTick 打到 mock server 而非真實 Telegram API。
//
// 測試場景：
//   1. 成功送出：mock server 回 200 → queue status='delivered'
//   2. 失敗一次後成功：第 1 次 500、第 2 次 200 → 第 2 次 status='delivered'
//   3. dead-letter：連續 500 五次 → status='dead'，stdout 含 ⚠️

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import http from 'node:http';
import { connectTestDb, TEST_DB_URL, type Sql } from '../helpers/db.js';
import { runOneTick } from '../../scripts/hermes-reminder-poll.js';

// ---------------------------------------------------------------------------
// mock Telegram server helpers
// ---------------------------------------------------------------------------

interface MockServerState {
  server: http.Server;
  port: number;
  /** 依序回的 status codes（FIFO）；空了就一直回 200 */
  responseQueue: number[];
  /** 收到的請求記錄 */
  requests: { url: string; body: string }[];
}

function createMockTelegramServer(): MockServerState {
  const state: MockServerState = { server: null!, port: 0, responseQueue: [], requests: [] };

  state.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      state.requests.push({ url: req.url ?? '', body });
      const statusCode = state.responseQueue.shift() ?? 200;
      const payload =
        statusCode === 200
          ? JSON.stringify({ ok: true, result: { message_id: 1 } })
          : JSON.stringify({ ok: false, description: 'mock error' });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });

  return state;
}

async function startServer(state: MockServerState): Promise<number> {
  return new Promise((resolve, reject) => {
    state.server.listen(0, '127.0.0.1', () => {
      const addr = state.server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      state.port = addr.port;
      resolve(addr.port);
    });
    state.server.on('error', reject);
  });
}

async function stopServer(state: MockServerState): Promise<void> {
  return new Promise((resolve) => {
    state.server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const PERSONAL = '__personal__';

async function makeTaskWithReminder(
  sql: Sql,
  title: string
): Promise<{ taskId: string; slot: Date }> {
  const slot = new Date(Date.now() - 60_000); // -1 min (already due)
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tasks (project_id, title, status, remind_at)
    VALUES (${PERSONAL}, ${title}, 'open', ${slot})
    RETURNING id`;
  return { taskId: rows[0].id, slot };
}

async function getQueueRow(
  sql: Sql,
  taskId: string
): Promise<{ status: string; attempts: number } | null> {
  const rows = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts
    FROM reminder_delivery_queue
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('scripts/hermes-poll-delivery — at-least-once delivery', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  let mockServer: MockServerState;

  beforeAll(async () => {
    sql = await connectTestDb();
    pg = postgres(TEST_DB_URL, { max: 4 });
    db = drizzle(pg);

    mockServer = createMockTelegramServer();
    await startServer(mockServer);
  });

  afterAll(async () => {
    await stopServer(mockServer);
    if (pg) await pg.end();
    if (sql) await sql.end();
  });

  afterEach(async () => {
    // 清順序：reminder_delivery_queue → reminder_log → tasks（FK chain）
    await sql`DELETE FROM reminder_delivery_queue`;
    await sql`DELETE FROM reminder_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ${PERSONAL})`;
    await sql`DELETE FROM tasks WHERE project_id = ${PERSONAL}`;
    mockServer.requests = [];
    mockServer.responseQueue = [];
  });

  // 共用 opts（打 mock server，而非真實 Telegram）
  function tickOpts() {
    return {
      telegramApiBase: `http://127.0.0.1:${mockServer.port}`,
      token: 'test-token',
      chatId: '12345',
      projectId: PERSONAL,
    };
  }

  // =========================================================================
  // 場景 1：成功送出
  // =========================================================================

  it('成功送出：mock server 回 200 → queue status=delivered', async () => {
    const { taskId } = await makeTaskWithReminder(sql, '提醒A');
    // mock server 預設回 200（responseQueue 空即 200）

    const result = await runOneTick(db, tickOpts());

    expect(result.dead).toHaveLength(0);

    const row = await getQueueRow(sql, taskId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('delivered');
  });

  // =========================================================================
  // 場景 2：失敗一次後成功
  // =========================================================================

  it('失敗一次後成功：第 1 次 500、第 2 次 200 → 最終 status=delivered', async () => {
    const { taskId } = await makeTaskWithReminder(sql, '提醒B');

    // Tick 1：mock server 回 500 → attempts=1, status=pending（退避中）
    mockServer.responseQueue.push(500);
    const result1 = await runOneTick(db, tickOpts());
    expect(result1.dead).toHaveLength(0);

    const rowAfterFail = await getQueueRow(sql, taskId);
    expect(rowAfterFail!.status).toBe('pending');
    expect(rowAfterFail!.attempts).toBe(1);

    // 手動把 next_attempt_at 拉到過去，讓 Tick 2 能再度 claim
    await sql`UPDATE reminder_delivery_queue
              SET next_attempt_at = NOW() - INTERVAL '1 second'
              WHERE task_id = ${taskId}`;

    // Tick 2：mock server 回 200 → delivered
    const result2 = await runOneTick(db, tickOpts());
    expect(result2.dead).toHaveLength(0);

    const rowAfterDelivery = await getQueueRow(sql, taskId);
    expect(rowAfterDelivery!.status).toBe('delivered');
  });

  // =========================================================================
  // 場景 3：dead-letter（連續 500 五次）
  // =========================================================================

  it('dead-letter：mock server 連續 500 五次 → status=dead，dead[] 含標題', async () => {
    const { taskId } = await makeTaskWithReminder(sql, '致命提醒C');

    // 跑 5 輪，每輪前把 next_attempt_at 設成過去（讓 claimDeliverable 撈得到）。
    // 保留每輪結果，第 5 輪（最後一輪）的 dead[] 應含任務標題。
    let lastResult = { dead: [] as string[] };
    for (let i = 0; i < 5; i++) {
      mockServer.responseQueue.push(500);
      if (i > 0) {
        await sql`UPDATE reminder_delivery_queue
                  SET next_attempt_at = NOW() - INTERVAL '1 second'
                  WHERE task_id = ${taskId}`;
      }
      lastResult = await runOneTick(db, tickOpts());
    }

    // 第 5 輪回傳 dead[]（attempts 0→4 完成後 → dead）
    expect(lastResult.dead).toHaveLength(1);
    expect(lastResult.dead[0]).toContain('致命提醒C');

    const row = await getQueueRow(sql, taskId);
    expect(row!.status).toBe('dead');
  });

  // =========================================================================
  // 邊界：無到期提醒時安靜退出
  // =========================================================================

  it('無到期提醒：runOneTick 回 {dead: []}，不打 mock server', async () => {
    const result = await runOneTick(db, tickOpts());
    expect(result.dead).toHaveLength(0);
    expect(mockServer.requests).toHaveLength(0);
  });
});
