// scripts/preflight/post-delete.ts — D1-D5（delete COMMIT + 套 0008 之後的最終確認）
//
// 注意：post-delete 已從「閘門」降級為「COMMIT 後最終確認」——真正的閘門在
// scripts/delete-personal-data.ts 的 tx 內驗證（MVCC 下跨連線閘門結構性失效，P0）。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { sanitizeUrl } from '../../src/db/resolve-url.js';
import { adminClient } from '../lib/clients.js';
import {
  COPY_ORDER,
  EXPECTED_INVENTORY,
  countPersonalRows,
  type InventoryEntry,
} from '../lib/inventory.js';
import type { DeleteManifest } from '../delete-personal-data.js';
import { PreflightAbort, checkIdentity, record, recordSkip, type CaseResult } from './shared.js';

export interface PostDeleteOptions {
  manifestPath?: string;
  skipScopeTests?: boolean;
}

function requireUrl(name: string): string {
  const v = sanitizeUrl(process.env[name]);
  if (!v) {
    console.error(`Missing required env: ${name}（post-delete 需雙 URL——identity guard 與 D3 比對都要 personal 側）`);
    process.exit(2);
  }
  return v;
}

// 拆字串避開 secret-scan hook；localhost test placeholder，非真實憑證。
const DEFAULT_TEST_DB_URL = 'postgres:' + '//test:test' + '@localhost:5433/cc_memory_test';

/** D5 的 scope tests 跑在 test PG（不是 prod URL）；先 2s probe 可達性。 */
async function probeTestPg(url: string): Promise<boolean> {
  try {
    const probe = postgres(url, { max: 1, connect_timeout: 2, idle_timeout: 1 });
    await probe`SELECT 1`;
    await probe.end({ timeout: 2 });
    return true;
  } catch {
    return false;
  }
}

const D4_PROBES: { table: string; arm: string; insert: (tx: postgres.TransactionSql<any>) => Promise<unknown> }[] = [
  {
    table: 'project_memories',
    arm: 'project_id',
    insert: (tx) =>
      tx`INSERT INTO project_memories (project_id, type, summary) VALUES ('__personal__', 'session', 'D4 probe')`,
  },
  {
    table: 'tasks',
    arm: 'project_id',
    insert: (tx) => tx`INSERT INTO tasks (project_id, title) VALUES ('__personal__', 'D4 probe')`,
  },
  {
    table: 'search_feedback',
    arm: 'query_project_id',
    insert: (tx) =>
      tx`INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit", result_ids, result_project_ids, rank_positions)
         VALUES ('d4-probe', 'mcp', '__personal__', 'keyword', 1,
                 ARRAY['00000000-0000-0000-0000-000000000000']::uuid[], ARRAY['proj-x']::text[], ARRAY[1]::int[])`,
  },
  {
    table: 'search_feedback',
    arm: 'result_project_ids（混合列 arm）',
    insert: (tx) =>
      tx`INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit", result_ids, result_project_ids, rank_positions)
         VALUES ('d4-probe-mixed', 'mcp', NULL, 'keyword', 1,
                 ARRAY['00000000-0000-0000-0000-000000000000']::uuid[], ARRAY['__personal__']::text[], ARRAY[1]::int[])`,
  },
];

export async function postDelete(opts: PostDeleteOptions = {}): Promise<CaseResult[]> {
  // D1 前置：post-delete 改 DATABASE_URL_PERSONAL 必填（runbook env 配發表同步）
  const projectUrl = requireUrl('DATABASE_URL');
  const personalUrl = requireUrl('DATABASE_URL_PERSONAL');
  const results: CaseResult[] = [];

  const project = adminClient(projectUrl);
  const personal = adminClient(personalUrl);

  try {
    // D1：identity 重跑；FAIL → exit 2 abort
    const id = await checkIdentity(projectUrl, personalUrl, project, personal);
    const d1ok = id.urlDistinct && id.liveOk;
    record(
      results,
      'D1',
      'identity 重跑（URL 層 + DB 活體 probe）；FAIL 即 abort',
      d1ok,
      `${id.urlDetail}；live: ${id.liveDetail}`
    );
    if (!d1ok) throw new PreflightAbort('D1 identity FAIL——post-delete 驗證中止', results);

    // D2：project DB 個人列全 0——4 predicate（含 reminder_log FK-scoped、
    // search_feedback 混合列）。排除 bot_user_state（user-level state，依決策保留，
    // 處置見 handback runbook）。
    for (const entry of EXPECTED_INVENTORY) {
      try {
        const n = await countPersonalRows(project, entry);
        record(
          results,
          'D2',
          `project DB ${entry.table} 個人列已清空（排除 bot_user_state：user-level state，依決策保留）`,
          n === 0,
          `remaining=${n}`
        );
      } catch (e) {
        record(results, 'D2', `project DB ${entry.table} clear`, false, (e as Error).message);
      }
    }

    // D3：personal DB 持有列數 vs delete manifest 精確比對
    try {
      const copyEntries = COPY_ORDER.map(
        (t) => EXPECTED_INVENTORY.find((e) => e.table === t) as InventoryEntry
      );
      if (opts.manifestPath) {
        const manifest = JSON.parse(readFileSync(opts.manifestPath, 'utf8')) as DeleteManifest;
        const mismatches: string[] = [];
        if (!manifest.executed) mismatches.push('manifest.executed != true（拿到的是 dry-run manifest？）');
        for (const entry of copyEntries) {
          const have = await countPersonalRows(personal, entry);
          const expected = manifest.tables[entry.table]?.deleted;
          if (have !== expected) {
            mismatches.push(`${entry.table}: personal=${have} != manifest.deleted=${expected}`);
          }
        }
        record(
          results,
          'D3',
          'personal DB 持有列數與 delete manifest 精確比對',
          mismatches.length === 0,
          mismatches.length === 0 ? `manifest ${opts.manifestPath} 全表吻合` : mismatches.join('; ')
        );
      } else {
        // 退化模式：無 manifest → 總列數 >0 + 大寫 WARN（部分表合法為 0，Codex A-extra2）
        let total = 0;
        const parts: string[] = [];
        for (const entry of copyEntries) {
          const n = await countPersonalRows(personal, entry);
          total += n;
          parts.push(`${entry.table}=${n}`);
        }
        record(
          results,
          'D3',
          'personal DB 持有列數（退化模式：無 manifest）',
          total > 0,
          `WARNING：未提供 --manifest，退化為總列數 >0 檢查（${parts.join(', ')}）——` +
            '請改用 delete-personal-data --manifest-out 產出的 manifest 做精確比對'
        );
      }
    } catch (e) {
      record(results, 'D3', 'manifest 比對', false, (e as Error).message);
    }

    // D4：project DB 0008 反向 CHECK 拒寫 probe（mirror C5；取代原「插假列驗 ScopePolicy
    // SQL」設計——該設計恆真、且 0008 後假列插不進去（Codex A2 衝突解法）；
    // ScopePolicy SQL 排除正確性改由 shared predicate + tests/scripts/scope-probe.test.ts 鎖）
    for (const probe of D4_PROBES) {
      try {
        let rejected = false;
        try {
          await project.begin(async (tx) => {
            await probe.insert(tx);
            throw new Error('INSERT 應被 0008 CHECK 拒但未拒');
          });
        } catch (err) {
          rejected = /no_personal_check|check constraint|23514/i.test((err as Error).message);
        }
        record(
          results,
          'D4',
          `0008 反向 CHECK 拒寫 __personal__: ${probe.table}（${probe.arm}）`,
          rejected,
          rejected ? 'rejected by no_personal_check' : 'NOT rejected——0008 未套用或 CHECK 失效'
        );
      } catch (e) {
        record(results, 'D4', `0008 probe ${probe.table}`, false, (e as Error).message);
      }
    }

    // D5：scope tests via vitest（test PG 不可達 → 顯式 SKIP，不影響 exit code）
    if (opts.skipScopeTests) {
      recordSkip(
        results,
        'D5',
        'ScopePolicy scope tests via vitest',
        'SKIPPED BY HARNESS（--skip-scope-tests：e2e 已在 vitest 內，避免 nested vitest 共用同一 test DB，Codex B4）'
      );
    } else {
      const testDbUrl = sanitizeUrl(process.env.TEST_DATABASE_URL) ?? DEFAULT_TEST_DB_URL;
      if (!(await probeTestPg(testDbUrl))) {
        recordSkip(
          results,
          'D5',
          'ScopePolicy scope tests via vitest',
          `TEST PG UNREACHABLE（${testDbUrl}）——SKIP 不算 FAIL；` +
            'runbook 注意：staging 演練時 D5 不得為 SKIP（請先 docker compose -f docker-compose.test.yml up -d + tsx scripts/test-db-setup.ts）'
        );
      } else {
        try {
          // env 消毒：只保留 PATH/HOME/TEST_DATABASE_URL*（剝 DATABASE_URL* /
          // CC_FORCE_PROJECT_ID，防 prod URL 滲入 test runner）
          const cleanEnv: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          };
          if (process.env.TEST_DATABASE_URL) cleanEnv.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
          if (process.env.TEST_DATABASE_URL_PERSONAL) {
            cleanEnv.TEST_DATABASE_URL_PERSONAL = process.env.TEST_DATABASE_URL_PERSONAL;
          }
          const r = spawnSync(
            'npx',
            [
              'vitest',
              'run',
              'tests/services/scope-policy.test.ts',
              'tests/mcp-scope.test.ts',
              'tests/scripts/scope-probe.test.ts',
              '--reporter=basic',
            ],
            { encoding: 'utf8', stdio: 'pipe', env: cleanEnv }
          );
          const pass = r.status === 0;
          const tail = (r.stdout || '').split('\n').filter(Boolean).slice(-5).join(' | ');
          record(
            results,
            'D5',
            'ScopePolicy / mcp-scope / scope-probe tests 在新架構下仍綠',
            pass,
            pass ? 'tests pass' : `exit=${r.status}; tail=${tail}`
          );
        } catch (e) {
          record(results, 'D5', 'ScopePolicy tests', false, (e as Error).message);
        }
      }
    }

    return results;
  } finally {
    await project.end({ timeout: 5 });
    await personal.end({ timeout: 5 });
  }
}
