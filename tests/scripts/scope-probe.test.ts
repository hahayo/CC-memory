// tests/scripts/scope-probe.test.ts
//
// shared scope predicate（reservedExclusionCondition，Codex A7）的 control+treatment
// 直測——取代原 preflight「插假 __personal__ 列驗 ScopePolicy SQL」設計（該設計在
// 0008 之後插不進去、且驗證條件恆真，Codex A2 衝突解法）。
//
//   treatment：帶排除條件 → 個人列不得出現在 cross-project 結果
//   control  ：不帶排除條件 → 個人列必須出現（證明 treatment 的排除真的在作用，
//              不是「資料剛好不存在」造成的恆真 PASS）

import { randomUUID } from 'node:crypto';
import { and, eq, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import { projectMemories } from '../../src/db/schema.js';
import {
  PERSONAL_PROJECT_ID,
  reservedExclusionCondition,
} from '../../src/services/scope-policy.js';

let sql: Sql;
let db: ReturnType<typeof drizzle>;
const probeTag = `scope-probe-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  sql = await connectTestDb();
  await resetAllTables(sql);
  db = drizzle(sql);
  await sql`
    INSERT INTO project_memories (project_id, type, summary)
    VALUES (${PERSONAL_PROJECT_ID}, 'session', ${`${probeTag} personal row`})
  `;
  await sql`
    INSERT INTO project_memories (project_id, type, summary)
    VALUES ('proj-x', 'session', ${`${probeTag} project row`})
  `;
});

afterAll(async () => {
  await resetAllTables(sql);
  await sql.end({ timeout: 5 });
});

async function crossProjectSearch(excludeReserved: boolean) {
  // mirror searchMemories 的 cross-project 分支：status=active + 排除條件進 WHERE
  const conditions: SQL[] = [eq(projectMemories.status, 'active')];
  const reserved = reservedExclusionCondition(excludeReserved);
  if (reserved) conditions.push(reserved);
  return db
    .select({ projectId: projectMemories.projectId, summary: projectMemories.summary })
    .from(projectMemories)
    .where(conditions.length > 1 ? and(...conditions) : conditions[0]);
}

describe('reservedExclusionCondition（shared predicate，service 與驗證共用 SoT）', () => {
  it('treatment：排除條件生效 → cross-project 結果不含 __personal__ 列', async () => {
    const rows = await crossProjectSearch(true);
    expect(rows.some((r) => r.projectId === PERSONAL_PROJECT_ID)).toBe(false);
    expect(rows.some((r) => r.projectId === 'proj-x')).toBe(true); // 合法列仍在
  });

  it('control：無排除條件 → 個人列出現（證明 treatment 不是恆真 PASS）', async () => {
    const rows = await crossProjectSearch(false);
    expect(rows.some((r) => r.projectId === PERSONAL_PROJECT_ID)).toBe(true);
  });
});
