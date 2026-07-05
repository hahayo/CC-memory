// scripts/run-auto-capture.ts — hermes `--no-agent` auto-capture worker.
//
// One tick: health check project DB, harvest local spool, call injected/default
// capture LLM, write rollup + observations, then print a concise stdout summary.

import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { config } from '../src/config.js';
import { createCaptureLlmAdapter } from '../src/services/capture-llm.js';
import { runCaptureWorkerOnce, type CaptureWorkerResult } from '../src/services/capture-worker.js';
import { generateEmbedding } from '../src/utils/embedding.js';

async function dbHealthCheck(db: { execute(query: unknown): Promise<unknown> }): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`[cc-memory] auto-capture skipped: DB health check failed: ${message}\n`);
    return false;
  }
}

export async function runAutoCaptureTick(): Promise<CaptureWorkerResult> {
  const client = postgres(config.databaseUrl, { max: 1, connect_timeout: 2, idle_timeout: 2 });
  const db = drizzle(client);
  try {
    const llm = createCaptureLlmAdapter({ env: process.env, stdout: process.stdout });
    const result = await runCaptureWorkerOnce({
      db,
      llm,
      dbHealthCheck: () => dbHealthCheck(db),
      generateEmbedding,
      stdout: process.stdout,
    });
    process.stdout.write(
      `[cc-memory] auto-capture summary: processed=${result.processed} skipped=${result.skipped} dead-letter=${result.deadLettered}\n`
    );
    return result;
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'run-auto-capture';

if (isMain) {
  runAutoCaptureTick().catch((error) => {
    console.error('[run-auto-capture] failed:', error);
    process.exitCode = 1;
  });
}
