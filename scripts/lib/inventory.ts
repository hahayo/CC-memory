// scripts/lib/inventory.ts
//
// 遷移工具鏈 inventory 單一 SoT —— migrate / preflight / delete 三方共用，
// 防三邊各自 hard-code / 各自 query 漂移造成 false PASS（Phase 3 code review Batch 3）。
//
// 表分三類 filter：
//   project_id_eq     持 project_id 欄位（project_memories / tasks）— copy + delete
//   task_fk           經 FK 間接屬個人列（reminder_log → tasks）— copy + delete
//   feedback_personal search_feedback 特例：無 project_id 欄（query_project_id 可
//                     NULL、result_project_ids 是 array），一般 inventory query 抓
//                     不到，必須 special-case（Codex A6）。拍板「只刪不搬」（privacy
//                     優先、接受個人 retrieval telemetry 損失；混合列
//                     query_project_id IS NULL AND '__personal__'=ANY(result_project_ids)
//                     一併刪，見 ADR-001）→ 只進 DELETE_ORDER、不進 COPY_ORDER。
//
// bot_user_state 維持排除：user-level state（telegram_user_id PK、無 project_id 欄）。
// 既有 active_project_id='__personal__' 列的處置見 handback runbook（清掉或確認不需要）。

import { PERSONAL_PROJECT_ID } from '../../src/constants.js';
import { ident, type Queryable } from './clients.js';

export interface InventoryEntry {
  table: string;
  filter:
    | { kind: 'project_id_eq'; value: string }
    | { kind: 'task_fk'; refTable: string; fkColumn: string }
    | { kind: 'feedback_personal' };
}

/** discoverInventory 的預期結果——schema 漂移時 diffInventory 非空，工具鏈 abort。 */
export const EXPECTED_INVENTORY: InventoryEntry[] = [
  { table: 'project_memories', filter: { kind: 'project_id_eq', value: PERSONAL_PROJECT_ID } },
  { table: 'tasks', filter: { kind: 'project_id_eq', value: PERSONAL_PROJECT_ID } },
  { table: 'reminder_log', filter: { kind: 'task_fk', refTable: 'tasks', fkColumn: 'task_id' } },
  { table: 'reminder_delivery_queue', filter: { kind: 'task_fk', refTable: 'tasks', fkColumn: 'task_id' } },
  { table: 'search_feedback', filter: { kind: 'feedback_personal' } },
];

/** copy 順序（FK-safe：先父後子）。search_feedback 只刪不搬，不在此列。 */
export const COPY_ORDER = ['project_memories', 'tasks', 'reminder_log', 'reminder_delivery_queue'] as const;

/** delete 順序（FK-safe：先子後父；search_feedback 殿後，與其他表無 FK 關聯）。 */
export const DELETE_ORDER = ['reminder_delivery_queue', 'reminder_log', 'tasks', 'project_memories', 'search_feedback'] as const;

/** preflight P6 schema 比對範圍（0007/0008 為 expected-delta，見 preflight）。 */
export const SCHEMA_COMPARE_TABLES = [
  'project_memories',
  'tasks',
  'reminder_log',
  'search_feedback',
] as const;

const EXCLUDED_TABLES = ['search_feedback', 'bot_user_state'];

/**
 * 動態 inventory 探勘：
 *   (a) 持 project_id 欄位的表
 *   (b) FK 關聯到 (a) 的表（reminder_log → tasks）
 *   (c) search_feedback special-case（顯式 append，無法從 (a)(b) 探到）
 *
 * 顯式 throw 四條（探到工具鏈不支援的 schema 形狀就 fail-fast，不靜默跳過）：
 *   1. FK ref 欄位非 id（cursor 分頁 + checksum ORDER BY id 硬依賴）
 *   2. FK 表自身無 id 欄
 *   3. 存在二層 FK（有表 FK 參照到 FK 表）
 *   4. COPY_ORDER 表缺 id 的 PK/unique（cursor 分頁與 ON CONFLICT (id) 硬依賴，Codex B9）
 */
export async function discoverInventory(sql: Queryable): Promise<InventoryEntry[]> {
  // (a) 持 project_id 欄位的表
  const projectIdTables = await sql<{ table_name: string }[]>`
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'project_id'
    ORDER BY table_name
  `;
  const projectIdNames = projectIdTables
    .map((r) => r.table_name)
    .filter((t) => !EXCLUDED_TABLES.includes(t));

  // (b) FK 關聯到 (a) 的表；補抓 ccu.column_name = 參照欄位（throw 1 需要）
  const fkRefs = await sql<
    { table_name: string; column_name: string; ref_table: string; ref_column: string }[]
  >`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = ANY(${projectIdNames})
      AND tc.table_name <> ccu.table_name
  `;

  // throw 1：FK ref 欄位非 id
  for (const fk of fkRefs) {
    if (fk.ref_column !== 'id') {
      throw new Error(
        `discoverInventory: ${fk.table_name}.${fk.column_name} FK 參照 ` +
          `${fk.ref_table}.${fk.ref_column}（非 id）——遷移工具鏈僅支援參照 id 的一層 FK`
      );
    }
  }

  const fkTableNames = [...new Set(fkRefs.map((r) => r.table_name))].filter(
    (t) => !EXCLUDED_TABLES.includes(t)
  );

  // throw 2：FK 表自身無 id 欄（cursor 分頁需要）
  for (const t of fkTableNames) {
    const idCol = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${t} AND column_name = 'id'
    `;
    if (idCol.length === 0) {
      throw new Error(`discoverInventory: FK 表 ${t} 無 id 欄——cursor 分頁無法工作`);
    }
  }

  // throw 3：二層 FK（有表 FK 參照到 FK 表）
  if (fkTableNames.length > 0) {
    const secondLevel = await sql<{ table_name: string; ref_table: string }[]>`
      SELECT tc.table_name, ccu.table_name AS ref_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = ANY(${fkTableNames})
        AND tc.table_name <> ccu.table_name
    `;
    if (secondLevel.length > 0) {
      const desc = secondLevel.map((r) => `${r.table_name}→${r.ref_table}`).join(', ');
      throw new Error(
        `discoverInventory: 存在二層 FK（${desc}）——遷移工具鏈只支援一層 FK，` +
          `copy/delete 順序無法保證 FK-safe`
      );
    }
  }

  // throw 4（Codex B9）：COPY_ORDER 表必須有 id 的 PK 或全表 unique
  await assertCopyTablesHaveUniqueId(sql);

  return [
    ...projectIdNames.map(
      (t): InventoryEntry => ({
        table: t,
        filter: { kind: 'project_id_eq', value: PERSONAL_PROJECT_ID },
      })
    ),
    ...fkRefs
      .filter((r) => !EXCLUDED_TABLES.includes(r.table_name))
      .map(
        (r): InventoryEntry => ({
          table: r.table_name,
          filter: { kind: 'task_fk', refTable: r.ref_table, fkColumn: r.column_name },
        })
      ),
    { table: 'search_feedback', filter: { kind: 'feedback_personal' } },
  ];
}

async function assertCopyTablesHaveUniqueId(sql: Queryable): Promise<void> {
  // indpred IS NULL：partial unique（如 idempotency partial index）不保證全表唯一，不算。
  const rows = await sql<{ relname: string }[]>`
    SELECT DISTINCT t.relname
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = ANY(${[...COPY_ORDER]})
      AND (i.indisprimary OR i.indisunique)
      AND i.indnkeyatts = 1
      AND i.indpred IS NULL
      AND (SELECT attname FROM pg_attribute WHERE attrelid = t.oid AND attnum = i.indkey[0]) = 'id'
  `;
  const ok = new Set(rows.map((r) => r.relname));
  for (const t of COPY_ORDER) {
    if (!ok.has(t)) {
      throw new Error(
        `discoverInventory: ${t} 缺 id 的 PK/unique——cursor 分頁與 ON CONFLICT (id) 都硬依賴它（Codex B9）`
      );
    }
  }
}

function entryKey(e: InventoryEntry): string {
  switch (e.filter.kind) {
    case 'project_id_eq':
      return `${e.table}|project_id_eq|${e.filter.value}`;
    case 'task_fk':
      return `${e.table}|task_fk|${e.filter.fkColumn}→${e.filter.refTable}.id`;
    case 'feedback_personal':
      return `${e.table}|feedback_personal`;
  }
}

/** set-wise 比對（順序由 COPY_ORDER/DELETE_ORDER 管，不在此比）。空陣列 = 一致。 */
export function diffInventory(actual: InventoryEntry[], expected: InventoryEntry[]): string[] {
  const a = new Set(actual.map(entryKey));
  const b = new Set(expected.map(entryKey));
  const diffs: string[] = [];
  for (const k of a) if (!b.has(k)) diffs.push(`unexpected: ${k}`);
  for (const k of b) if (!a.has(k)) diffs.push(`missing: ${k}`);
  return diffs;
}

/**
 * 「這張表的個人列」WHERE 條件 fragment——count / fetch / DELETE 三方共用同一 predicate，
 * 防手寫 SQL 漂移（特別是 search_feedback 混合列，Codex B10 最易漏刪的 case）。
 */
export function personalWhere(sql: Queryable, entry: InventoryEntry) {
  const f = entry.filter;
  if (f.kind === 'project_id_eq') {
    return sql`${ident(sql, entry.table)}.project_id = ${f.value}`;
  }
  if (f.kind === 'task_fk') {
    return sql`EXISTS (
      SELECT 1 FROM ${ident(sql, f.refTable)} r
      WHERE r.id = ${ident(sql, entry.table)}.${ident(sql, f.fkColumn)}
        AND r.project_id = ${PERSONAL_PROJECT_ID}
    )`;
  }
  // feedback_personal：query 端打過 personal、或結果集含 personal 列（混合列）皆算
  return sql`(${ident(sql, entry.table)}.query_project_id = ${PERSONAL_PROJECT_ID}
    OR ${PERSONAL_PROJECT_ID} = ANY(${ident(sql, entry.table)}.result_project_ids))`;
}

export async function countPersonalRows(sql: Queryable, entry: InventoryEntry): Promise<number> {
  const r = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM ${ident(sql, entry.table)}
    WHERE ${personalWhere(sql, entry)}
  `;
  return parseInt(r[0].count, 10);
}
