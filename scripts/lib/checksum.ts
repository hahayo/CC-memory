// scripts/lib/checksum.ts
//
// per-table deterministic checksum（migrate post-copy / preflight C3 / delete 前
// 最後比對共用）。
//
// 設計重點：
//   - to_jsonb(t)（不是 row_to_jsonb——該函式不存在，Phase 3 review P1：原 preflight
//     的 checksum SQL 從未對真 DB 跑過）。
//   - 每次計算自含 `SET LOCAL TIME ZONE 'UTC'`（Codex B7）：to_jsonb 對 timestamptz
//     的文字化跟連線 TimeZone 走，兩連線 TZ 不同會 false-mismatch。*In 變體在 caller
//     的 tx 內也照樣 SET LOCAL（idempotent，作用到 tx 結束，無持久副作用）。
//   - jsonb key 序同 PG major 內一致；跨 major 無保證 → identity.ts 的
//     server_version major 弱檢查負責提醒。

import type postgres from 'postgres';
import { PERSONAL_PROJECT_ID } from '../../src/constants.js';
import { ident, type Queryable } from './clients.js';

/** tx 內版本：caller 已在 transaction 中（delete script 的不可逆關口用這個）。 */
export async function tableChecksumIn(tx: Queryable, table: string): Promise<string> {
  await tx`SET LOCAL TIME ZONE 'UTC'`;
  const r = await tx<{ checksum: string | null }[]>`
    SELECT MD5(string_agg(to_jsonb(t)::text, '|' ORDER BY id)) AS checksum
    FROM ${ident(tx, table)} t
    WHERE t.project_id = ${PERSONAL_PROJECT_ID}
  `;
  // 無個人列 → string_agg 回 NULL → 'empty' 哨兵（比 MD5('') 可讀；兩側皆空仍相等）
  return r[0].checksum ?? 'empty';
}

/** 自含 tx 版本：單獨呼叫用（preflight / migrate post-copy）。 */
export async function tableChecksum(sql: postgres.Sql<any>, table: string): Promise<string> {
  return sql.begin((tx) => tableChecksumIn(tx, table)) as Promise<string>;
}

/** reminder_log（無 project_id 欄，task_id FK-scoped）tx 內版本。 */
export async function reminderLogChecksumIn(tx: Queryable): Promise<string> {
  await tx`SET LOCAL TIME ZONE 'UTC'`;
  const r = await tx<{ checksum: string | null }[]>`
    SELECT MD5(string_agg(to_jsonb(rl)::text, '|' ORDER BY rl.id)) AS checksum
    FROM reminder_log rl
    JOIN tasks t ON t.id = rl.task_id
    WHERE t.project_id = ${PERSONAL_PROJECT_ID}
  `;
  return r[0].checksum ?? 'empty';
}

export async function reminderLogChecksum(sql: postgres.Sql<any>): Promise<string> {
  return sql.begin((tx) => reminderLogChecksumIn(tx)) as Promise<string>;
}
