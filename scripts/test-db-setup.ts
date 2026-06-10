#!/usr/bin/env tsx
//
// scripts/test-db-setup.ts — idempotent 建立兩個 test database + 套 migrations
// （Codex B6/A10：不靠 docker init script——它只在 fresh volume 跑一次，
//   既有 volume 不會重建）。
//
//   cc_memory_test           project 側：migrations 0000-0006（不含 0007/0008）
//   cc_memory_test_personal  personal 側：migrations 0000-0007
//
// 0008 不在此套用：e2e 測試內依 runbook 順序（delete 之後）套用＋清除；
// 本 script 每次跑會把 project 測試庫殘留的 0008 constraint 清掉（自癒，
// 防 e2e 中斷後殘留的反向 CHECK 弄壞一般 suite 的 __personal__ seed）。
//
// 既有 cc_memory_test 若是 drizzle-kit push 建的（有表但無 _test_migrations 紀錄）
// → DROP SCHEMA public 重建，統一走 migration 鏈（與 prod 同管道；migration 鏈與
// schema.ts 的漂移會在既有 suite + inventory test 立刻爆出來）。
//
// 用法：
//   docker compose -f docker-compose.test.yml up -d
//   npx tsx scripts/test-db-setup.ts
//
// TEST_DATABASE_URL 可覆寫 project 測試庫 URL（personal 測試庫 = 同 host、db 名加
// _personal 後綴；TEST_DATABASE_URL_PERSONAL 可單獨覆寫）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import postgres from 'postgres';

// cwd-based（與 apply-migration.ts 同慣例：從 repo root 跑）
const MIGRATIONS_DIR = resolve('sql/migrations');

// 拆字串避開 secret-scan hook；localhost test placeholder，非真實憑證。
const DEFAULT_PROJECT_URL = 'postgres:' + '//test:test' + '@localhost:5433/cc_memory_test';

function deriveUrls(): { projectUrl: string; personalUrl: string; adminUrl: string } {
  const projectUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_PROJECT_URL;
  const u = new URL(projectUrl);
  const personalU = new URL(projectUrl);
  personalU.pathname = `${u.pathname}_personal`;
  const personalUrl = process.env.TEST_DATABASE_URL_PERSONAL ?? personalU.href;
  const adminU = new URL(projectUrl);
  adminU.pathname = '/postgres'; // maintenance DB（CREATE DATABASE 不能在目標庫內跑）
  return { projectUrl, personalUrl, adminUrl: adminU.href };
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function migrationFiles(maxExclusive: string): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`找不到 ${MIGRATIONS_DIR}——請從 repo root 執行（cwd-based 路徑）`);
  }
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < maxExclusive)
    .sort();
}

async function ensureDatabase(admin: postgres.Sql, name: string): Promise<void> {
  const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (exists.length === 0) {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    console.error(`  created database ${name}`);
  }
}

async function applyMigrations(url: string, files: string[]): Promise<void> {
  const dbName = dbNameOf(url);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _test_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    let applied = new Set(
      (await sql<{ filename: string }[]>`SELECT filename FROM _test_migrations`).map(
        (r) => r.filename
      )
    );

    // drizzle push 殘留偵測：有表但無 migration 紀錄 → 整庫 schema 重建
    if (applied.size === 0) {
      const hasTables = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'project_memories'
      `;
      if (hasTables.length > 0) {
        console.error(`  [${dbName}] 偵測到非 migration 鏈建立的 schema → DROP SCHEMA public 重建`);
        await sql`DROP SCHEMA public CASCADE`;
        await sql`CREATE SCHEMA public`;
        await sql`
          CREATE TABLE _test_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        applied = new Set();
      }
    }

    for (const f of files) {
      if (applied.has(f)) continue;
      const stmts = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of stmts) await sql.unsafe(stmt);
      await sql`INSERT INTO _test_migrations (filename) VALUES (${f})`;
      console.error(`  [${dbName}] applied ${f}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** project 測試庫自癒：清掉 e2e 中斷殘留的 0008 反向 CHECK。 */
async function dropProjectNoPersonalChecks(url: string): Promise<void> {
  // onnotice 靜音：DROP CONSTRAINT IF EXISTS 的 NOTICE 不需要噴到終端
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`ALTER TABLE project_memories DROP CONSTRAINT IF EXISTS project_memories_no_personal_check`;
    await sql`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_no_personal_check`;
    await sql`ALTER TABLE search_feedback DROP CONSTRAINT IF EXISTS search_feedback_no_personal_check`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const { projectUrl, personalUrl, adminUrl } = deriveUrls();
  console.error(`=== test-db-setup ===`);

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await ensureDatabase(admin, dbNameOf(projectUrl));
    await ensureDatabase(admin, dbNameOf(personalUrl));
  } finally {
    await admin.end({ timeout: 5 });
  }

  // project 側：0000-0006（'0007' 之前）；personal 側：0000-0007（skip 0008 project-only）+ 0009
  await applyMigrations(projectUrl, migrationFiles('0007'));
  const personalMigrations = [
    ...migrationFiles('0008'),                          // 0000-0007
    '0009_add_reminder_delivery_queue.sql',             // personal-only
  ];
  await applyMigrations(personalUrl, personalMigrations);
  // 0009 也套 project test DB：service tests 用 project DB 跑，需要 reminder_delivery_queue table
  await applyMigrations(projectUrl, ['0009_add_reminder_delivery_queue.sql']);
  await dropProjectNoPersonalChecks(projectUrl);

  console.error(`done：${dbNameOf(projectUrl)}（0000-0006+0009）/ ${dbNameOf(personalUrl)}（0000-0007+0009）`);
}

main().catch((err) => {
  console.error('test-db-setup failed:', err);
  process.exit(1);
});
