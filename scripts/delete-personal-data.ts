#!/usr/bin/env tsx
//
// scripts/delete-personal-data.ts — Phase 3 v0.4 maintenance window：從 project DB
// 刪除個人列（P0 修復核心；見 ADR-001 + docs/personal-hub/handback-A2-A4.md Step 5）。
//
// 為什麼存在這支 script：原設計「DELETE 後從另一終端跑 preflight 驗證、PASS 才
// COMMIT」在 MVCC 下結構性失效——其他連線看不到未 COMMIT 的刪除，閘門恆 PASS
// （P0）。改為：**同一 tx 內 DELETE → 驗證 → COMMIT**；preflight post-delete 降級
// 為 COMMIT 後的最終確認。
//
// 用法：
//   DATABASE_URL=<project> DATABASE_URL_PERSONAL=<personal> \
//     tsx scripts/delete-personal-data.ts [--execute] [--manifest-out path]
//
// 預設 dry-run：完整 identity / inventory / checksum 檢查 + 刪除計畫，零寫入。
// --execute 才真刪。DATABASE_URL_PERSONAL **必填**——identity guard（advisory probe
// + 0007 方向）與 checksum 比對都需要 personal 側。
//
// --execute 流程（單一 tx）：
//   1. LOCK TABLE（DELETE_ORDER 四表）IN SHARE ROW EXCLUSIVE MODE——擋住漏停的
//      writer，消滅「DELETE 後、COMMIT 前插入新個人列」的 race（Codex B3/A1；
//      不只依賴 maintenance window 紀律）
//   2. lock 之後同 tx 重新計數（lock 前的計數只當參考印出）
//   3. copied 三表 checksum 與 personal DB 精確比對——count 相等不代表內容一致；
//      這是最後不可逆關口，不依賴「人工有跑過 post-copy」（Codex A3）
//   4. DELETE 順序：reminder_log → tasks → project_memories → search_feedback
//      （search_feedback 含混合列 query_project_id IS NULL AND
//        '__personal__'=ANY(result_project_ids)，predicate 共用 inventory.personalWhere）
//   5. 同 tx 驗證：各 DELETE result.count == step 2 計數；各表 countPersonalRows == 0
//   6. 全過 → COMMIT → 印 manifest JSON；任一不符 → throw → ROLLBACK + exit 1，
//      project DB 原樣
//
// COMMIT 後接續：套 0008（反向 CHECK）→ preflight --mode post-delete --manifest <path>

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sanitizeUrl } from '../src/db/resolve-url.js';
import {
  assertDistinctDatabasesLive,
  connIdentity,
  samePhysicalDbUrls,
  type ConnIdentity,
  type DistinctDbDiagnostics,
} from '../src/db/identity.js';
import { adminClient, ident, type Queryable } from './lib/clients.js';
import {
  COPY_ORDER,
  DELETE_ORDER,
  EXPECTED_INVENTORY,
  countPersonalRows,
  diffInventory,
  discoverInventory,
  personalWhere,
  type InventoryEntry,
} from './lib/inventory.js';
import {
  reminderLogChecksum,
  reminderLogChecksumIn,
  tableChecksum,
  tableChecksumIn,
} from './lib/checksum.js';

export class DeleteAbortError extends Error {}

export interface DeleteManifest {
  executed: boolean;
  deletedAt: string;
  project: Pick<ConnIdentity, 'host' | 'port' | 'database'>;
  personal: Pick<ConnIdentity, 'host' | 'port' | 'database'>;
  /** counted = tx 內 lock 後計數（dry-run 時為參考計數）；deleted = DELETE result.count */
  tables: Record<string, { counted: number; deleted: number; copiedToPersonal: boolean }>;
  /** copied 三表的 checksum（project = tx 內 lock 後；personal = personal DB 側） */
  checksums: Record<string, { project: string; personal: string }>;
  diagnostics: DistinctDbDiagnostics;
}

export interface DeleteOptions {
  projectUrl: string;
  personalUrl: string;
  execute: boolean;
  manifestOut?: string;
  log?: (msg: string) => void;
  /** manifest JSON 印到 stdout（CLI 預設 true；integration test 直測時關掉）。 */
  printManifest?: boolean;
}

async function personalChecksums(sql: ReturnType<typeof adminClient>) {
  return {
    project_memories: await tableChecksum(sql, 'project_memories'),
    tasks: await tableChecksum(sql, 'tasks'),
    reminder_log: await reminderLogChecksum(sql),
  } as Record<string, string>;
}

async function projectChecksumsIn(tx: Queryable) {
  return {
    project_memories: await tableChecksumIn(tx, 'project_memories'),
    tasks: await tableChecksumIn(tx, 'tasks'),
    reminder_log: await reminderLogChecksumIn(tx),
  } as Record<string, string>;
}

export async function runDeletePersonalData(opts: DeleteOptions): Promise<DeleteManifest> {
  const log = opts.log ?? ((m: string) => console.error(m));

  const projectUrl = sanitizeUrl(opts.projectUrl);
  const personalUrl = sanitizeUrl(opts.personalUrl);
  if (!projectUrl || !personalUrl) {
    throw new DeleteAbortError(
      'DATABASE_URL 與 DATABASE_URL_PERSONAL 皆必填——identity guard 與 checksum 比對都需要 personal 側'
    );
  }
  if (samePhysicalDbUrls(projectUrl, personalUrl)) {
    throw new DeleteAbortError(
      'DATABASE_URL 與 DATABASE_URL_PERSONAL 指向同一物理 DB（host+port+database）——' +
        'delete 會把唯一一份個人列刪掉。中止。'
    );
  }

  const project = adminClient(projectUrl);
  const personal = adminClient(personalUrl);

  try {
    log(`\n=== Delete personal data from project DB ${opts.execute ? '[EXECUTE]' : '[DRY-RUN]'} ===`);
    const projId = connIdentity(projectUrl);
    const persId = connIdentity(personalUrl);
    log(`project:  ${projId.host}:${projId.port}/${projId.database}`);
    log(`personal: ${persId.host}:${persId.port}/${persId.database}`);

    // DB 活體檢查（advisory probe + 0007 方向：project 端帶 0007 = URL 對調，throw）
    const diagnostics = await assertDistinctDatabasesLive(project, personal);

    // inventory 漂移防護
    for (const [label, sql] of [
      ['project', project],
      ['personal', personal],
    ] as const) {
      const diff = diffInventory(await discoverInventory(sql), EXPECTED_INVENTORY);
      if (diff.length > 0) {
        throw new DeleteAbortError(
          `INVENTORY DRIFT (${label})：\n  ${diff.join('\n  ')}\n` +
            'schema 已偏離工具鏈預期；更新 scripts/lib/inventory.ts 並補測試後再跑。'
        );
      }
    }

    const entries = DELETE_ORDER.map(
      (t) => EXPECTED_INVENTORY.find((e) => e.table === t) as InventoryEntry
    );
    const copiedSet = new Set<string>([...COPY_ORDER]);

    // 參考計數（lock 前——僅印出；execute 會在 tx 內 lock 後重新計數）
    const refCounts: Record<string, number> = {};
    log(`\nDelete plan（FK-safe order）:`);
    for (const e of entries) {
      refCounts[e.table] = await countPersonalRows(project, e);
      log(
        `  - ${e.table}: ${refCounts[e.table]} 列` +
          (copiedSet.has(e.table) ? '' : '（delete-only，未 copy——拍板只刪不搬）')
      );
    }

    // personal 側 checksum（copied 三表）
    const personalCk = await personalChecksums(personal);

    if (!opts.execute) {
      // dry-run：印 checksum 預覽（不阻擋——execute 在 tx 內 lock 後做精確比對）
      const projectCkPreview = {
        project_memories: await tableChecksum(project, 'project_memories'),
        tasks: await tableChecksum(project, 'tasks'),
        reminder_log: await reminderLogChecksum(project),
      } as Record<string, string>;
      log(`\nChecksum 預覽（無 lock，僅參考；execute 時 tx 內精確比對）:`);
      for (const t of COPY_ORDER) {
        const match = projectCkPreview[t] === personalCk[t];
        log(`  ${match ? '✓' : '✗'} ${t}: project=${projectCkPreview[t].slice(0, 12)}… personal=${personalCk[t].slice(0, 12)}…`);
      }
      log(`\nDRY-RUN 完成（零寫入）。確認無誤後加 --execute 真刪。`);
      return {
        executed: false,
        deletedAt: new Date().toISOString(),
        project: { host: projId.host, port: projId.port, database: projId.database },
        personal: { host: persId.host, port: persId.port, database: persId.database },
        tables: Object.fromEntries(
          entries.map((e) => [
            e.table,
            { counted: refCounts[e.table], deleted: 0, copiedToPersonal: copiedSet.has(e.table) },
          ])
        ),
        checksums: Object.fromEntries(
          [...COPY_ORDER].map((t) => [t, { project: projectCkPreview[t], personal: personalCk[t] }])
        ),
        diagnostics,
      };
    }

    // ---- --execute：單一 tx ----
    let manifest: DeleteManifest | null = null;
    await project.begin(async (tx) => {
      // 1) LOCK：擋漏停的 writer（SHARE ROW EXCLUSIVE 阻擋 INSERT/UPDATE/DELETE，允許讀）
      for (const t of DELETE_ORDER) {
        await tx`LOCK TABLE ${ident(tx, t)} IN SHARE ROW EXCLUSIVE MODE`;
      }

      // 2) lock 之後重新計數
      const counted: Record<string, number> = {};
      for (const e of entries) counted[e.table] = await countPersonalRows(tx, e);

      // 3) checksum 精確比對（copied 三表；tx 內 = lock 後快照）
      const projectCk = await projectChecksumsIn(tx);
      for (const t of COPY_ORDER) {
        if (projectCk[t] !== personalCk[t]) {
          throw new DeleteAbortError(
            `checksum mismatch: ${t}（project=${projectCk[t]} personal=${personalCk[t]}）——` +
              'personal DB 內容與 project DB 個人列不一致，拒絕刪除。' +
              '請重跑 migrate（id 冪等）+ preflight post-copy 釐清差異。'
          );
        }
      }

      // 4) DELETE（FK-safe order；predicate 共用 personalWhere）
      const deleted: Record<string, number> = {};
      for (const e of entries) {
        const result = await tx`
          DELETE FROM ${ident(tx, e.table)} WHERE ${personalWhere(tx, e)}
        `;
        deleted[e.table] = result.count;
      }

      // 5) 同 tx 驗證
      for (const e of entries) {
        if (deleted[e.table] !== counted[e.table]) {
          throw new DeleteAbortError(
            `delete count mismatch: ${e.table} deleted=${deleted[e.table]} != counted=${counted[e.table]}——ROLLBACK`
          );
        }
        const remaining = await countPersonalRows(tx, e);
        if (remaining !== 0) {
          throw new DeleteAbortError(
            `post-delete 殘留: ${e.table} 仍有 ${remaining} 列個人資料——ROLLBACK`
          );
        }
      }

      manifest = {
        executed: true,
        deletedAt: new Date().toISOString(),
        project: { host: projId.host, port: projId.port, database: projId.database },
        personal: { host: persId.host, port: persId.port, database: persId.database },
        tables: Object.fromEntries(
          entries.map((e) => [
            e.table,
            {
              counted: counted[e.table],
              deleted: deleted[e.table],
              copiedToPersonal: copiedSet.has(e.table),
            },
          ])
        ),
        checksums: Object.fromEntries(
          [...COPY_ORDER].map((t) => [t, { project: projectCk[t], personal: personalCk[t] }])
        ),
        diagnostics,
      };
    }); // ← 走到這裡 = COMMIT 成功；callback 內 throw = ROLLBACK

    const m = manifest as unknown as DeleteManifest;
    log(`\nCOMMIT 完成。manifest:`);
    const json = JSON.stringify(m, null, 2);
    if (opts.printManifest !== false) {
      console.log(json); // manifest 走 stdout（log 走 stderr），方便 pipe / --manifest-out
    }
    if (opts.manifestOut) {
      writeFileSync(opts.manifestOut, json + '\n', 'utf8');
      log(`manifest 已寫入 ${opts.manifestOut}`);
    }
    log(
      `\n下一步：① 套 0008 反向 CHECK：DATABASE_URL=<project> tsx scripts/apply-migration.ts ` +
        `sql/migrations/0008_project_db_no_personal_check.sql\n` +
        `② preflight 最終確認：tsx scripts/preflight.ts --mode post-delete --manifest <path>`
    );
    return m;
  } finally {
    await project.end({ timeout: 5 });
    await personal.end({ timeout: 5 });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const mi = argv.findIndex((a) => a === '--manifest-out');
  const manifestOut = mi >= 0 ? argv[mi + 1] : undefined;
  if (mi >= 0 && !manifestOut) {
    console.error('--manifest-out 需要路徑參數');
    process.exit(2);
  }

  const projectUrl = process.env.DATABASE_URL ?? '';
  const personalUrl = process.env.DATABASE_URL_PERSONAL ?? '';

  try {
    await runDeletePersonalData({ projectUrl, personalUrl, execute, manifestOut });
  } catch (err) {
    if (err instanceof DeleteAbortError) {
      console.error(`\ndelete aborted（project DB 原樣）: ${err.message}`);
      process.exit(1);
    }
    console.error('\ndelete failed（unexpected）:', err);
    process.exit(1);
  }
}

// 直接執行才跑 main；被 import（integration test 直測 runDeletePersonalData）時不跑。
// 用 argv[1] 檔名判定（import.meta 在 NodeNext CJS 推定下不可用；tsx 執行時 argv[1]
// 即本檔路徑，vitest import 時 argv[1] 是 test runner）。
const isMain =
  typeof process.argv[1] === 'string' &&
  basename(process.argv[1]).replace(/\.(ts|js)$/, '') === 'delete-personal-data';
if (isMain) {
  void main();
}
