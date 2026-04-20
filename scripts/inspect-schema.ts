// scripts/inspect-schema.ts — 檢查 DB 現狀
import 'dotenv/config';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL?.replace(/\r/g, '').replace(/^"|"$/g, '');
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { max: 1 });

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;
  console.log('Tables:', tables.map((t) => t.table_name).join(', '));

  for (const t of ['tasks', 'search_feedback', 'bot_user_state']) {
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = ${t} ORDER BY ordinal_position
    `;
    const constraints = await sql<{ constraint_name: string; constraint_type: string }[]>`
      SELECT constraint_name, constraint_type FROM information_schema.table_constraints
      WHERE table_name = ${t}
    `;
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${t}
    `;
    console.log(`\n=== ${t} ===`);
    console.log('cols:', cols.length, cols.map((c) => c.column_name).join(','));
    console.log('constraints:', constraints.map((c) => `${c.constraint_name}(${c.constraint_type})`).join(', '));
    console.log('indexes:', indexes.map((i) => i.indexname).join(', '));
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
