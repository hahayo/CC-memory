// scripts/apply-migration.ts
// 手動套用單一 migration 檔。drizzle-kit push 對既有表有 drift 偵測問題，
// 純 additive 的 migration 直接走 psql 驅動較安全。
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: tsx scripts/apply-migration.ts <path-to-sql>');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL?.replace(/\r/g, '').replace(/^"|"$/g, '');
  if (!url) throw new Error('DATABASE_URL not set');

  const sql = readFileSync(resolve(file), 'utf8');
  const stmts = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const client = postgres(url, { max: 1 });

  console.error(`Applying ${stmts.length} statements from ${file}`);
  for (const [i, stmt] of stmts.entries()) {
    console.error(`  [${i + 1}/${stmts.length}] ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...`);
    await client.unsafe(stmt);
  }
  console.error('Done.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
