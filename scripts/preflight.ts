#!/usr/bin/env tsx
//
// scripts/preflight.ts — Phase 3 v0.4 獨立 personal DB 遷移 preflight（見 ADR-001）
// entry：parseArgs + reporter + exit code；各 mode 實作在 scripts/preflight/*.ts。
//
// 用法（docs 指令路徑不變）：
//   DATABASE_URL=<project> DATABASE_URL_PERSONAL=<personal> \
//     tsx scripts/preflight.ts --mode {pre-migration|post-copy|post-delete} \
//       [--manifest path]（post-delete D3 精確比對用）
//       [--skip-scope-tests]（e2e harness 用，避免 nested vitest，Codex B4）
//
// Case 編號（mode-prefixed；舊編號對照——舊 1-7/8-11/12-14 含 8b/9b 重號，全部重排）：
//   pre-migration  P1 URL 層 identity（舊 1）
//                  P2 DB 活體 probe：xact advisory lock + 0007 方向 + version major（新）
//                  P3/P4 personal / project current_database 一致（舊 2/3）
//                  P5 resolveDatabaseUrl 配對矩陣（舊 4-6 合併；import 純函式）
//                  P6 schema 比對 + expected-delta allowlist（舊 7 擴）
//                  P7 inventory assertion（新）
//   post-copy      C1 identity 重跑，FAIL → exit 2 abort（新）
//                  C2 row counts（舊 8/8b）   C3 checksums（舊 9/9b）
//                  C4 personal DB 無他 project（舊 10）
//                  C5 0007 CHECK 拒寫（舊 11）
//   post-delete    D1 identity 重跑 + 雙 URL 必填（新）
//                  D2 project DB 個人列全 0——4 predicate（舊 12 擴）
//                  D3 personal DB 列數 vs delete manifest（新）
//                  D4 0008 反向 CHECK 拒寫 probe（舊 13 重設計）
//                  D5 scope tests via vitest，test PG 不可達顯式 SKIP（舊 14 重設計）
//
// Env：DATABASE_URL / DATABASE_URL_PERSONAL（三個 mode 皆必填）
// Exit：0 全 PASS（SKIP 不算 FAIL）/ 1 任一 FAIL / 2 abort（C1/D1 FAIL 或參數錯）

import { preMigration } from './preflight/pre-migration.js';
import { postCopy } from './preflight/post-copy.js';
import { postDelete } from './preflight/post-delete.js';
import { PreflightAbort, type CaseResult } from './preflight/shared.js';

type Mode = 'pre-migration' | 'post-copy' | 'post-delete';

interface Args {
  mode: Mode;
  manifestPath?: string;
  skipScopeTests: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage =
    'Usage: tsx scripts/preflight.ts --mode {pre-migration|post-copy|post-delete} [--manifest path] [--skip-scope-tests]';
  const mi = argv.findIndex((a) => a === '--mode');
  const mode = mi >= 0 ? argv[mi + 1] : undefined;
  if (mode !== 'pre-migration' && mode !== 'post-copy' && mode !== 'post-delete') {
    console.error(usage);
    process.exit(2);
  }
  const fi = argv.findIndex((a) => a === '--manifest');
  const manifestPath = fi >= 0 ? argv[fi + 1] : undefined;
  if (fi >= 0 && !manifestPath) {
    console.error(usage);
    process.exit(2);
  }
  return { mode, manifestPath, skipScopeTests: argv.includes('--skip-scope-tests') };
}

function report(mode: string, results: CaseResult[]): number {
  let failed = 0;
  console.error(`\n=== Preflight ${mode} ===`);
  for (const r of results) {
    if (r.status === 'FAIL') failed++;
    console.error(`  [${r.status}] #${r.id} ${r.name}`);
    console.error(`         ${r.detail}`);
  }
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.error(
    `\nTotal: ${results.length}  PASS: ${results.length - failed - skipped}  FAIL: ${failed}` +
      (skipped > 0 ? `  SKIP: ${skipped}（SKIP 不算 FAIL；原因見上）` : '') +
      '\n'
  );
  return failed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let results: CaseResult[] = [];
  try {
    if (args.mode === 'pre-migration') results = await preMigration();
    else if (args.mode === 'post-copy') results = await postCopy();
    else {
      results = await postDelete({
        manifestPath: args.manifestPath,
        skipScopeTests: args.skipScopeTests,
      });
    }
  } catch (err) {
    if (err instanceof PreflightAbort) {
      report(args.mode, err.results);
      console.error(`ABORT: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const failed = report(args.mode, results);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('preflight aborted:', err);
  process.exit(2);
});
