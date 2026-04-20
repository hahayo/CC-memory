// drizzle.test.config.ts — TDD 用：指向本機 docker postgres
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './tests/tmp-migrations',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: 'postgres://test:test@localhost:5433/cc_memory_test',
  },
});
