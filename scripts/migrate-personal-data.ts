#!/usr/bin/env tsx
//
// scripts/migrate-personal-data.ts — Phase 3 v0.4 personal data 跨 DB 遷移（見 ADR-001）
//
// 從 project DB 複製個人列到 personal DB。**只做 copy，不做 DELETE**——DELETE 由
// scripts/delete-personal-data.ts 負責（dry-run 預設 + tx 內驗證，見該檔）。
//
// 流程：
//   1. sanitize env URLs → URL 層 samePhysicalDb abort
//   2. adminClient 連線（timestamp/jsonb raw-text 直通，防微秒截斷與 jsonb 失真）
//   3. assertDistinctDatabasesLive（advisory-lock probe + 0007 方向檢查 + 診斷）
//   4. discoverInventory == EXPECTED_INVENTORY，diff 非空 abort（schema 漂移防護）
//   5. 按 COPY_ORDER copy（cursor 分頁 + ON CONFLICT (id) DO NOTHING）
//   6. post-copy 驗證：逐表 target personal count == source count，不等 exit 1
//
// rerun 語意（Codex A9）：允許重跑——id 冪等（ON CONFLICT DO NOTHING），重跑時
// skipped>0 屬正常；「內容一致性」由 post-copy checksum（preflight C3）與 delete 前
// checksum 雙重把關——target 上 stale 的同 id 列不會被本 script 更新，會在 C3 爆。
//
// copy 範圍不含 search_feedback（拍板：只刪不搬，privacy 優先；見 inventory.ts）。
//
// Env：
//   DATABASE_URL           project DB（source）
//   DATABASE_URL_PERSONAL  personal DB（target）
//
// Flags：
//   --dry-run     僅跑 identity/inventory 檢查 + row count 計畫，不 INSERT
//   --batch=N     每批 INSERT 列數（預設 500）

import { sanitizeUrl } from '../src/db/resolve-url.js';
import {
  assertDistinctDatabasesLive,
  connIdentity,
  samePhysicalDbUrls,
} from '../src/db/identity.js';
import { adminClient, ident, type AdminSql } from './lib/clients.js';
import {
  COPY_ORDER,
  EXPECTED_INVENTORY,
  countPersonalRows,
  diffInventory,
  discoverInventory,
  personalWhere,
  type InventoryEntry,
} from './lib/inventory.js';

interface CopyResult {
  table: string;
  source: number;
  fetched: number;
  inserted: number;
  skipped: number;
}

function parseArgs(argv: string[]): { dryRun: boolean; batch: number } {
  const dryRun = argv.includes('--dry-run');
  const b = argv.find((a) => a.startsWith('--batch='));
  const batch = b ? parseInt(b.split('=')[1], 10) : 500;
  if (!Number.isInteger(batch) || batch < 1) {
    console.error(`invalid --batch value: ${b}`);
    process.exit(2);
  }
  return { dryRun, batch };
}

async function fetchBatch(
  sql: AdminSql,
  entry: InventoryEntry,
  batchSize: number,
  afterId: string | null
): Promise<Record<string, unknown>[]> {
  const t = ident(sql, entry.table);
  const whereId = afterId ? sql`AND ${t}.id > ${afterId}` : sql``;
  return await sql`
    SELECT ${t}.* FROM ${t}
    WHERE ${personalWhere(sql, entry)} ${whereId}
    ORDER BY ${t}.id LIMIT ${batchSize}
  `;
}

async function insertBatch(
  sql: AdminSql,
  table: string,
  rows: Record<string, unknown>[]
): Promise<number> {
  if (rows.length === 0) return 0;
  // 取第一筆 keys 當欄位（同表所有 row schema 相同）；值已是 raw-text（adminClient 直通）
  const cols = Object.keys(rows[0]);
  const result = await sql`
    INSERT INTO ${ident(sql, table)} ${sql(rows as never, ...(cols as never[]))}
    ON CONFLICT (id) DO NOTHING
  `;
  return result.count;
}

async function copyTable(
  source: AdminSql,
  target: AdminSql,
  entry: InventoryEntry,
  batchSize: number,
  dryRun: boolean
): Promise<CopyResult> {
  const sourceCount = await countPersonalRows(source, entry);
  if (dryRun || sourceCount === 0) {
    return { table: entry.table, source: sourceCount, fetched: 0, inserted: 0, skipped: 0 };
  }

  let fetched = 0;
  let inserted = 0;
  let lastId: string | null = null;
  for (;;) {
    const rows = await fetchBatch(source, entry, batchSize, lastId);
    if (rows.length === 0) break;
    fetched += rows.length;
    inserted += await insertBatch(target, entry.table, rows);
    lastId = String(rows[rows.length - 1].id);
  }
  return { table: entry.table, source: sourceCount, fetched, inserted, skipped: fetched - inserted };
}

async function main() {
  const { dryRun, batch } = parseArgs(process.argv.slice(2));

  const projectUrl = sanitizeUrl(process.env.DATABASE_URL);
  const personalUrl = sanitizeUrl(process.env.DATABASE_URL_PERSONAL);
  if (!projectUrl || !personalUrl) {
    console.error('Missing DATABASE_URL or DATABASE_URL_PERSONAL');
    process.exit(2);
  }
  if (samePhysicalDbUrls(projectUrl, personalUrl)) {
    console.error(
      'DATABASE_URL 與 DATABASE_URL_PERSONAL 指向同一物理 DB（host+port+database），' +
        'refusing to migrate——遷移會 copy 到自己，後續 delete 會把唯一一份個人列刪掉。' +
        '見 ADR-001 / preflight P1。'
    );
    process.exit(2);
  }

  const source = adminClient(projectUrl);
  const target = adminClient(personalUrl);

  try {
    console.error(`\n=== Personal data migration ${dryRun ? '[DRY-RUN] ' : ''}===`);
    const srcId = connIdentity(projectUrl);
    const tgtId = connIdentity(personalUrl);
    console.error(`source: project DB  ${srcId.host}:${srcId.port}/${srcId.database}`);
    console.error(`target: personal DB ${tgtId.host}:${tgtId.port}/${tgtId.database}`);

    // DB 活體層檢查（advisory probe + 0007 方向；host alias 繞過 URL 層比對在此被抓）
    const diag = await assertDistinctDatabasesLive(source, target);
    console.error(
      `identity: distinct OK（system_id project=${diag.systemIdentifier.project ?? 'n/a'} ` +
        `personal=${diag.systemIdentifier.personal ?? 'n/a'}; ` +
        `pg ${diag.serverVersion.project} / ${diag.serverVersion.personal}）`
    );

    // inventory 漂移防護：兩側都比（source 決定 copy 範圍；target schema 必須跟上）
    for (const [label, sql] of [
      ['source', source],
      ['target', target],
    ] as const) {
      const diff = diffInventory(await discoverInventory(sql), EXPECTED_INVENTORY);
      if (diff.length > 0) {
        console.error(`\nINVENTORY DRIFT (${label})——abort：\n  ${diff.join('\n  ')}`);
        console.error('schema 已偏離工具鏈預期；更新 scripts/lib/inventory.ts 並補測試後再跑。');
        process.exit(2);
      }
    }

    const copyEntries = COPY_ORDER.map(
      (t) => EXPECTED_INVENTORY.find((e) => e.table === t) as InventoryEntry
    );
    console.error(`\nCopy plan（FK-safe order；search_feedback 只刪不搬，不在 copy 範圍）:`);
    for (const e of copyEntries) console.error(`  - ${e.table}`);

    const results: CopyResult[] = [];
    for (const entry of copyEntries) {
      console.error(`  copying ${entry.table}…`);
      const r = await copyTable(source, target, entry, batch, dryRun);
      results.push(r);
      console.error(
        dryRun
          ? `    source=${r.source}（dry-run，未 INSERT）`
          : `    source=${r.source} fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`
      );
    }

    console.error(`\n=== Summary ===`);
    let failed = false;
    let anySkipped = false;
    for (const r of results) {
      console.error(
        `  ${r.table}: source=${r.source}` +
          (dryRun ? '' : `  fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`)
      );
      if (!dryRun && r.fetched !== r.source) {
        console.error(
          `    ✗ fetched(${r.fetched}) != source(${r.source})——copy 期間 source 有寫入或分頁異常`
        );
        failed = true;
      }
      if (r.skipped > 0) anySkipped = true;
    }

    if (!dryRun) {
      // post-copy 驗證：target personal count 必須等於 source（rerun 也必須收斂到相等）
      for (const entry of copyEntries) {
        const s = await countPersonalRows(source, entry);
        const t = await countPersonalRows(target, entry);
        if (s !== t) {
          console.error(`  ✗ ${entry.table}: target personal count(${t}) != source(${s})`);
          failed = true;
        }
      }
      if (anySkipped) {
        console.error(
          '\n  ⚠️  SKIPPED > 0：target 已存在同 id 列（重跑屬正常）。' +
            '內容一致性由 POST-COPY CHECKSUM（preflight post-copy C3）與 DELETE 前 CHECKSUM 雙重把關——' +
            'STALE 的同 id 列會在 C3 爆，請務必跑 preflight。'
        );
      }
    }

    if (failed) {
      console.error('\nmigration FAILED——見上方 ✗ 項目；本 script 可安全重跑（id 冪等）。');
      process.exit(1);
    }
    if (!dryRun) {
      console.error(
        `\n下一步：DATABASE_URL=<project> DATABASE_URL_PERSONAL=<personal> ` +
          `tsx scripts/preflight.ts --mode post-copy`
      );
    }
  } finally {
    await source.end({ timeout: 5 });
    await target.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('migrate aborted:', err);
  process.exit(1);
});
