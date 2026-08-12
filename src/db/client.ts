// src/db/client.ts
//
// Phase 3 v0.4：「一 process 一 scope 一 DB」原則（見 ADR-001）。
// 啟動期 `config.databaseUrl` 已由 `resolveDatabaseUrl()` 決策定一條 URL
// （forced-mode personal → DATABASE_URL_PERSONAL；其他 → DATABASE_URL），
// 此檔不做 request-level 切換，無 per-scope re-init。跨 scope 起兩個 cc-memory process。

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

const client = postgres(config.databaseUrl, {
  max: 5,
  idle_timeout: 300,
  connect_timeout: 10,
});
export const db = drizzle(client, { schema });

export async function closeDb(timeoutSeconds = 2): Promise<void> {
  await client.end({ timeout: timeoutSeconds });
}
