// tests/helpers/db.ts
//
// 測試 DB 連線 + cleanup 共用 helper。
// Cleanup 順序：reminder_delivery_queue → reminder_log → tasks → search_feedback → observations → project_memories → bot_user_state
// （reminder_delivery_queue/reminder_log FK→tasks，observations FK→project_memories，先子後父避免 FK violation）。

import postgres from 'postgres';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

/** personal 側 test DB（Phase 3 遷移工具鏈測試用）；由 scripts/test-db-setup.ts 建立。 */
export const TEST_PERSONAL_DB_URL =
  process.env.TEST_DATABASE_URL_PERSONAL ??
  TEST_DB_URL.replace(/\/cc_memory_test$/, '/cc_memory_test_personal');

export type Sql = ReturnType<typeof postgres>;

/**
 * 建立任意 test PG 連線；連不上就 fail-loud（不要 silent skip）。
 */
export async function connectDb(url: string): Promise<Sql> {
  try {
    const probe = postgres(url, { max: 1, idle_timeout: 2, connect_timeout: 2 });
    await probe`SELECT 1`;
    await probe.end();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\nTest PostgreSQL is not reachable at ${url}.\n` +
        `啟動本機 test DB：\n` +
        `  docker compose -f docker-compose.test.yml up -d\n` +
        `  npx tsx scripts/test-db-setup.ts\n\n` +
        `或指定現有 test PG（例如 CI）：\n` +
        `  export TEST_DATABASE_URL=postgres://user:pass@host:port/db\n\n` +
        `原始錯誤：${cause}`
    );
  }
  return postgres(url, { max: 1 });
}

/** 建立測試 PG 連線（project 側預設 test DB）。 */
export async function connectTestDb(): Promise<Sql> {
  return connectDb(TEST_DB_URL);
}

/**
 * 清空七張表；順序：reminder_delivery_queue → reminder_log → tasks → search_feedback → observations → project_memories → bot_user_state。
 * FK child tables 必須先刪，避免 FK violation。
 */
export async function resetAllTables(sql: Sql): Promise<void> {
  await sql`DELETE FROM reminder_delivery_queue`;
  await sql`DELETE FROM reminder_log`;
  await sql`DELETE FROM tasks`;
  await sql`DELETE FROM search_feedback`;
  await sql`DELETE FROM observations`;
  await sql`DELETE FROM project_memories`;
  await sql`DELETE FROM bot_user_state`;
}

/**
 * 只清 project_memories（保留 tasks / search_feedback）。
 */
export async function resetProjectMemories(sql: Sql): Promise<void> {
  await sql`DELETE FROM project_memories`;
}
