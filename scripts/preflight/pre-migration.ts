// scripts/preflight/pre-migration.ts — P1-P7（遷移前環境/設定/schema 驗證）

import { sanitizeUrl, resolveDatabaseUrl } from '../../src/db/resolve-url.js';
import { connIdentity } from '../../src/db/identity.js';
import { PERSONAL_PROJECT_ID } from '../../src/constants.js';
import { adminClient, type AdminSql } from '../lib/clients.js';
import {
  EXPECTED_INVENTORY,
  SCHEMA_COMPARE_TABLES,
  diffInventory,
  discoverInventory,
} from '../lib/inventory.js';
import { checkIdentity, record, type CaseResult } from './shared.js';

// P6 expected-delta allowlist（Codex A8+B5）：0007 為 personal-only、0008 為
// project-only 的合法差異——比對前剔除，方向正確性由 P2（0007）/D4（0008）另行把關。
const EXPECTED_DELTA_CONSTRAINTS = new Set([
  'project_memories_personal_only_check', // 0007
  'tasks_personal_only_check', // 0007
  'project_memories_no_personal_check', // 0008
  'tasks_no_personal_check', // 0008
  'search_feedback_no_personal_check', // 0008
]);

function requireUrl(name: string): string {
  const v = sanitizeUrl(process.env[name]);
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

interface SchemaFingerprint {
  keys: Set<string>;
}

async function schemaFingerprint(sql: AdminSql): Promise<SchemaFingerprint> {
  const tables = [...SCHEMA_COMPARE_TABLES];
  const keys = new Set<string>();

  const columns = await sql<
    { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  >`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${tables})
  `;
  for (const c of columns) {
    keys.add(`col|${c.table_name}.${c.column_name}|${c.data_type}|${c.is_nullable}|${c.column_default ?? ''}`);
  }

  // 具名 constraint（含 CHECK / FK / PK / UNIQUE，帶完整定義）
  const constraints = await sql<{ table_name: string; conname: string; def: string }[]>`
    SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ANY(${tables})
  `;
  for (const c of constraints) {
    if (EXPECTED_DELTA_CONSTRAINTS.has(c.conname)) continue;
    keys.add(`con|${c.table_name}|${c.conname}|${c.def}`);
  }

  const indexes = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ANY(${tables})
  `;
  for (const i of indexes) {
    keys.add(`idx|${i.tablename}|${i.indexname}|${i.indexdef}`);
  }

  return { keys };
}

function diffFingerprints(project: SchemaFingerprint, personal: SchemaFingerprint): string[] {
  const diffs: string[] = [];
  for (const k of project.keys) if (!personal.keys.has(k)) diffs.push(`project-only: ${k}`);
  for (const k of personal.keys) if (!project.keys.has(k)) diffs.push(`personal-only: ${k}`);
  return diffs;
}

export async function preMigration(): Promise<CaseResult[]> {
  const projectUrl = requireUrl('DATABASE_URL');
  const personalUrl = requireUrl('DATABASE_URL_PERSONAL');
  const results: CaseResult[] = [];

  const project = adminClient(projectUrl);
  const personal = adminClient(personalUrl);

  try {
    // P1 / P2：URL 層 + DB 活體層 identity
    const id = await checkIdentity(projectUrl, personalUrl, project, personal);
    record(results, 'P1', 'URL 層 identity：兩 URL 指向不同物理 DB（host+port+database）', id.urlDistinct, id.urlDetail);
    record(results, 'P2', 'DB 活體 probe：xact advisory lock + 0007 方向 + version major', id.liveOk, id.liveDetail);

    // P3 / P4：current_database 與 URL pathname 一致
    for (const [caseId, label, sql, url] of [
      ['P3', 'personal', personal, personalUrl],
      ['P4', 'project', project, projectUrl],
    ] as const) {
      try {
        const r = await sql<{ current_database: string }[]>`SELECT current_database()`;
        const current = r[0].current_database.toLowerCase();
        const expected = connIdentity(url).database;
        record(
          results,
          caseId,
          `${label} URL 連到的 current_database 與 URL pathname 一致`,
          current === expected,
          `current_database=${current}; URL pathname db=${expected}`
        );
      } catch (e) {
        record(results, caseId, `${label} URL 連線`, false, `connect failed: ${(e as Error).message}`);
      }
    }

    // P5：resolveDatabaseUrl 配對矩陣（純函式 import——src/db/resolve-url.js，
    // 驗收點：import 不產生 console 輸出）
    try {
      const failures: string[] = [];

      const a = resolveDatabaseUrl({
        databaseUrl: projectUrl,
        databaseUrlPersonal: personalUrl,
        forcedProjectId: PERSONAL_PROJECT_ID,
      });
      if (a !== personalUrl) failures.push('forced+both 應回 personal URL');

      let threw = false;
      try {
        resolveDatabaseUrl({ databaseUrl: projectUrl, databaseUrlPersonal: null, forcedProjectId: PERSONAL_PROJECT_ID });
      } catch {
        threw = true;
      }
      if (!threw) failures.push('forced+缺 personal URL 應 throw');

      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.join(' '));
      let c = '';
      try {
        c = resolveDatabaseUrl({ databaseUrl: projectUrl, databaseUrlPersonal: personalUrl, forcedProjectId: null });
      } finally {
        console.warn = orig;
      }
      if (c !== projectUrl) failures.push('非 forced+personal URL 應回 project URL');
      if (!warns.some((w) => /DATABASE_URL_PERSONAL/.test(w))) failures.push('非 forced+personal URL 應 warn');

      const d = resolveDatabaseUrl({
        databaseUrl: null,
        databaseUrlPersonal: personalUrl,
        forcedProjectId: PERSONAL_PROJECT_ID,
      });
      if (d !== personalUrl) failures.push('forced+只有 personal URL 應回 personal URL（B8）');

      record(
        results,
        'P5',
        'resolveDatabaseUrl 配對矩陣（forced+both / forced 缺 personal / 非 forced warn / forced 單 personal）',
        failures.length === 0,
        failures.length === 0 ? '4/4 矩陣項通過' : failures.join('; ')
      );
    } catch (e) {
      record(results, 'P5', 'resolveDatabaseUrl 配對矩陣', false, (e as Error).message);
    }

    // P6：schema 比對（columns + 具名 constraint/index/FK；0007/0008 expected-delta）
    try {
      const diffs = diffFingerprints(await schemaFingerprint(project), await schemaFingerprint(personal));
      record(
        results,
        'P6',
        'schema 比對：columns/constraints/indexes/FK 一致（0007/0008 為 expected-delta）',
        diffs.length === 0,
        diffs.length === 0
          ? `identical（範圍 ${SCHEMA_COMPARE_TABLES.join(', ')}；allowlist ${EXPECTED_DELTA_CONSTRAINTS.size} 個 per-DB constraint）`
          : `differ:\n         ${diffs.join('\n         ')}`
      );
    } catch (e) {
      record(results, 'P6', 'schema 比對', false, (e as Error).message);
    }

    // P7：inventory assertion（兩側 discoverInventory == EXPECTED_INVENTORY）
    try {
      const diffs: string[] = [];
      for (const [label, sql] of [
        ['project', project],
        ['personal', personal],
      ] as const) {
        for (const d of diffInventory(await discoverInventory(sql), EXPECTED_INVENTORY)) {
          diffs.push(`${label}: ${d}`);
        }
      }
      record(
        results,
        'P7',
        'inventory assertion：discoverInventory == EXPECTED_INVENTORY（兩側）',
        diffs.length === 0,
        diffs.length === 0 ? 'inventory 一致' : diffs.join('; ')
      );
    } catch (e) {
      record(results, 'P7', 'inventory assertion', false, (e as Error).message);
    }

    return results;
  } finally {
    await project.end({ timeout: 5 });
    await personal.end({ timeout: 5 });
  }
}
