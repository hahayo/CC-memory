// scripts/create-missing-indexes.ts
// drizzle-kit push 因既有表 drift 中斷，未建新表的 non-PK indexes。此處補建。
import 'dotenv/config';
import postgres from 'postgres';

const INDEXES = [
  {
    name: 'tasks_project_status_created_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "tasks_project_status_created_idx"
          ON "tasks" USING btree ("project_id","status","created_at" DESC NULLS LAST)`,
  },
  {
    name: 'tasks_due_date_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "tasks_due_date_idx"
          ON "tasks" USING btree ("due_date")
          WHERE "tasks"."due_date" IS NOT NULL AND "tasks"."status" <> 'done'`,
  },
  {
    name: 'tasks_idempotency_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "tasks_idempotency_idx"
          ON "tasks" USING btree ("idempotency_key")
          WHERE "tasks"."idempotency_key" IS NOT NULL`,
  },
  {
    name: 'search_feedback_created_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "search_feedback_created_idx"
          ON "search_feedback" USING btree ("created_at" DESC NULLS LAST)`,
  },
  {
    name: 'search_feedback_mode_idx',
    ddl: `CREATE INDEX IF NOT EXISTS "search_feedback_mode_idx"
          ON "search_feedback" USING btree ("mode","thumbs")`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL?.replace(/\r/g, '').replace(/^"|"$/g, '');
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { max: 1 });

  for (const { name, ddl } of INDEXES) {
    console.error(`Creating ${name}...`);
    await sql.unsafe(ddl);
  }
  console.error('Done.');
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
