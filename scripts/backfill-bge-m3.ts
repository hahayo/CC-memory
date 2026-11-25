#!/usr/bin/env npx tsx
/**
 * Idempotent bge-m3 embedding backfill for active project memories and observations.
 * Fills the 1024-dim `embedding_bge_m3` column via the local embed-service.
 * Defaults to dry-run; pass --execute to call the service and update rows.
 *
 * 刻意不 import src/config.js／src/utils/embedding.js：config 在模組載入時
 * resolve DATABASE_URL，此 script 的 DSN 來自 --dsn-file。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import {
  composeEmbeddingText,
  composeObservationEmbeddingText,
  prepareEmbeddingText,
} from '../src/utils/embedding-text.js';
import {
  LOCAL_EMBEDDING_MAX_BATCH,
  requestLocalEmbeddings,
} from '../src/utils/local-embedding.js';
import { LOCAL_EMBEDDING_DIMENSIONS } from '../src/utils/embedding-provider.js';

export type BgeM3BackfillTarget = 'project_memories' | 'observations';

export interface BgeM3MemoryRow {
  id: string;
  content_hash: string | null;
  summary: string;
  keywords: string[] | null;
  decisions: string[] | null;
}

export interface BgeM3ObservationRow {
  id: string;
  content_hash: string | null;
  title: string;
  facts: string[];
  narrative: string;
}

export type BgeM3Row = BgeM3MemoryRow | BgeM3ObservationRow;

export interface BgeM3BackfillStore {
  fetchPage(input: {
    target: BgeM3BackfillTarget;
    afterId?: string;
    limit: number;
  }): Promise<BgeM3Row[]>;
  updateBatch(input: {
    target: BgeM3BackfillTarget;
    rows: { id: string; contentHash: string | null; embedding: number[] }[];
  }): Promise<number>;
}

export interface BgeM3BackfillOptions {
  targets: BgeM3BackfillTarget[];
  dryRun: boolean;
  pageSize: number;
  batchSize: number;
  limit?: number;
  maxConsecutiveFailures: number;
}

export interface BgeM3TableResult {
  scanned: number;
  updated: number;
  skipped_changed: number;
  failed_rows: number;
  failed_batches: number;
  batches: number;
}

export interface BgeM3BackfillResult {
  status: 'completed' | 'aborted' | 'interrupted';
  dryRun: boolean;
  tables: Record<BgeM3BackfillTarget, BgeM3TableResult>;
  total: BgeM3TableResult;
}

export interface BgeM3BackfillDeps {
  store: BgeM3BackfillStore;
  embed: (texts: string[]) => Promise<number[][] | null>;
  sleep?: (ms: number) => Promise<void>;
  report?: (line: string) => void;
  now?: () => number;
  shouldStop?: () => boolean;
}

interface BgeM3CliOptions extends BgeM3BackfillOptions {
  dsnFile: string;
  serviceUrl: string;
  timeoutMs: number;
}

const RETRY_SLEEP_MS = 5000;
// server.py request body 上限 2 MiB；批次 body 留 0.5 MiB 餘量
const MAX_BATCH_BODY_BYTES = 1.5 * 1024 * 1024;

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseBgeM3BackfillArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): BgeM3CliOptions {
  const dsnFile = optionValue(args, '--dsn-file');
  if (!dsnFile) {
    throw new Error('--dsn-file is required');
  }
  const table = optionValue(args, '--table') ?? 'all';
  const targets: BgeM3BackfillTarget[] = table === 'all'
    ? ['project_memories', 'observations']
    : table === 'project_memories' || table === 'observations'
      ? [table]
      : (() => { throw new Error('--table must be project_memories, observations, or all'); })();
  const batchSize = positiveInteger(optionValue(args, '--batch-size') ?? '32', '--batch-size');
  if (batchSize > LOCAL_EMBEDDING_MAX_BATCH) {
    throw new Error(`--batch-size must be <= ${LOCAL_EMBEDDING_MAX_BATCH}`);
  }
  const limitRaw = optionValue(args, '--limit');

  return {
    targets,
    dryRun: !args.includes('--execute'),
    pageSize: positiveInteger(optionValue(args, '--page-size') ?? '512', '--page-size'),
    batchSize,
    limit: limitRaw === undefined ? undefined : positiveInteger(limitRaw, '--limit'),
    maxConsecutiveFailures: 5,
    dsnFile,
    serviceUrl: optionValue(args, '--service-url') ?? env.EMBEDDING_LOCAL_URL ?? 'http://127.0.0.1:8790',
    timeoutMs: positiveInteger(optionValue(args, '--timeout-ms') ?? '120000', '--timeout-ms'),
  };
}

export function readDsnFile(dsnFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(dsnFile, 'utf8');
  } catch {
    throw new Error(`cannot read --dsn-file at ${dsnFile}`);
  }
  const dsn = raw.trim();
  if (!dsn) {
    throw new Error(`--dsn-file at ${dsnFile} is empty`);
  }
  return dsn;
}

function composeRowText(target: BgeM3BackfillTarget, row: BgeM3Row): string {
  if (target === 'project_memories') {
    const memory = row as BgeM3MemoryRow;
    return prepareEmbeddingText(
      composeEmbeddingText(memory.summary, memory.keywords ?? undefined, memory.decisions ?? undefined)
    ).text;
  }
  const observation = row as BgeM3ObservationRow;
  return prepareEmbeddingText(
    composeObservationEmbeddingText({
      title: observation.title,
      facts: observation.facts,
      narrative: observation.narrative,
    })
  ).text;
}

function requestBodyBytes(texts: string[]): number {
  return Buffer.byteLength(JSON.stringify({ inputs: texts }));
}

function splitIntoBatches(texts: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const text of texts) {
    const candidate = [...current, text];
    if (current.length > 0 &&
        (candidate.length > batchSize || requestBodyBytes(candidate) > MAX_BATCH_BODY_BYTES)) {
      batches.push(current);
      current = [text];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 單一 UPDATE：VALUES 帶 content_hash，只有 id 對上、embedding_bge_m3 仍為 NULL
 * 且 content_hash 未變（IS NOT DISTINCT FROM 處理 NULL）的列才寫入。
 */
export function buildBgeM3UpdateStatement(
  target: BgeM3BackfillTarget,
  rows: { id: string; contentHash: string | null; embedding: number[] }[],
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    params.push(row.id, row.contentHash, JSON.stringify(row.embedding));
    const base = params.length - 3;
    return `($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::text)`;
  });
  const text =
    `UPDATE ${target} AS t SET embedding_bge_m3 = v.embedding::vector ` +
    `FROM (VALUES ${tuples.join(', ')}) AS v(id, content_hash, embedding) ` +
    'WHERE t.id = v.id AND t.embedding_bge_m3 IS NULL ' +
    'AND t.content_hash IS NOT DISTINCT FROM v.content_hash';
  return { text, params };
}

function emptyTableResult(): BgeM3TableResult {
  return {
    scanned: 0,
    updated: 0,
    skipped_changed: 0,
    failed_rows: 0,
    failed_batches: 0,
    batches: 0,
  };
}

export async function runBgeM3Backfill(
  options: BgeM3BackfillOptions,
  deps: BgeM3BackfillDeps,
): Promise<BgeM3BackfillResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const tables: Record<BgeM3BackfillTarget, BgeM3TableResult> = {
    project_memories: emptyTableResult(),
    observations: emptyTableResult(),
  };
  const total = emptyTableResult();
  let consecutiveFailures = 0;
  let status: BgeM3BackfillResult['status'] = 'completed';

  const progress = (target: BgeM3BackfillTarget, counters: BgeM3TableResult) => {
    const elapsedSec = Math.max((now() - startedAt) / 1000, 0.001);
    const rate = (options.dryRun ? counters.scanned : counters.updated) / elapsedSec;
    deps.report?.(
      `[backfill-bge-m3] table=${target} scanned=${counters.scanned} ` +
      `updated=${counters.updated} skipped_changed=${counters.skipped_changed} ` +
      `failed_batches=${counters.failed_batches} rows_per_s=${rate.toFixed(1)}`
    );
  };

  outer:
  for (const target of options.targets) {
    const counters = tables[target];
    let afterId: string | undefined;
    while (options.limit === undefined || total.scanned < options.limit) {
      const remaining = options.limit === undefined
        ? options.pageSize
        : Math.min(options.pageSize, options.limit - total.scanned);
      if (remaining <= 0) break;
      const page = await deps.store.fetchPage({ target, afterId, limit: remaining });
      if (page.length === 0) break;

      afterId = page[page.length - 1].id;
      counters.scanned += page.length;
      total.scanned += page.length;

      // 依文字長度升冪（stable sort），短文本先送、長文本集中在一起
      const sorted = page
        .map((row) => ({ row, text: composeRowText(target, row) }))
        .sort((a, b) => a.text.length - b.text.length);
      const batches = splitIntoBatches(sorted.map((entry) => entry.text), options.batchSize);

      if (options.dryRun) {
        counters.batches += batches.length;
        total.batches += batches.length;
      } else {
        let textIndex = 0;
        for (const batchTexts of batches) {
          const batchEntries = sorted.slice(textIndex, textIndex + batchTexts.length);
          textIndex += batchTexts.length;
          counters.batches += 1;
          total.batches += 1;

          let embeddings: number[][] | null = null;
          try {
            embeddings = await deps.embed(batchTexts);
          } catch {
            embeddings = null;
          }
          if (embeddings === null) {
            await sleep(RETRY_SLEEP_MS);
            try {
              embeddings = await deps.embed(batchTexts);
            } catch {
              embeddings = null;
            }
          }

          if (embeddings === null) {
            counters.failed_batches += 1;
            counters.failed_rows += batchTexts.length;
            total.failed_batches += 1;
            total.failed_rows += batchTexts.length;
            consecutiveFailures += 1;
            if (consecutiveFailures >= options.maxConsecutiveFailures) {
              status = 'aborted';
              progress(target, counters);
              break outer;
            }
          } else {
            const updated = await deps.store.updateBatch({
              target,
              rows: batchEntries.map((entry, index) => ({
                id: entry.row.id,
                contentHash: entry.row.content_hash,
                embedding: embeddings![index],
              })),
            });
            counters.updated += updated;
            counters.skipped_changed += batchTexts.length - updated;
            total.updated += updated;
            total.skipped_changed += batchTexts.length - updated;
            consecutiveFailures = 0;
          }

          if (deps.shouldStop?.()) {
            status = 'interrupted';
            progress(target, counters);
            break outer;
          }
        }
      }

      progress(target, counters);
      if (deps.shouldStop?.()) {
        status = 'interrupted';
        break outer;
      }
    }
  }

  return { status, dryRun: options.dryRun, tables, total };
}

function createSqlBackfillStore(client: postgres.Sql): BgeM3BackfillStore {
  return {
    async fetchPage({ target, afterId, limit }) {
      if (target === 'project_memories') {
        return afterId === undefined
          ? client<BgeM3MemoryRow[]>`
              SELECT id, content_hash, summary, keywords, decisions
              FROM project_memories
              WHERE status = 'active' AND embedding_bge_m3 IS NULL
              ORDER BY id LIMIT ${limit}`
          : client<BgeM3MemoryRow[]>`
              SELECT id, content_hash, summary, keywords, decisions
              FROM project_memories
              WHERE status = 'active' AND embedding_bge_m3 IS NULL AND id > ${afterId}
              ORDER BY id LIMIT ${limit}`;
      }
      return afterId === undefined
        ? client<BgeM3ObservationRow[]>`
            SELECT id, content_hash, title, facts, narrative
            FROM observations
            WHERE status = 'active' AND embedding_bge_m3 IS NULL
            ORDER BY id LIMIT ${limit}`
        : client<BgeM3ObservationRow[]>`
            SELECT id, content_hash, title, facts, narrative
            FROM observations
            WHERE status = 'active' AND embedding_bge_m3 IS NULL AND id > ${afterId}
            ORDER BY id LIMIT ${limit}`;
    },

    async updateBatch({ target, rows }) {
      const statement = buildBgeM3UpdateStatement(target, rows);
      const result = await client.unsafe(statement.text, statement.params as never[]);
      return result.count;
    },
  };
}

async function checkServiceHealth(serviceUrl: string): Promise<void> {
  const url = `${serviceUrl.replace(/\/+$/, '')}/health`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`embed-service health check failed: ${url} unreachable`);
  }
  if (!response.ok) {
    throw new Error(`embed-service health check failed: ${url} returned HTTP ${response.status}`);
  }
  const payload = await response.json() as { ok?: unknown; model?: unknown; dimensions?: unknown };
  if (payload.ok !== true || payload.model !== 'BAAI/bge-m3' || payload.dimensions !== LOCAL_EMBEDDING_DIMENSIONS) {
    throw new Error(`embed-service health check failed: unexpected payload from ${url}`);
  }
}

let dsnForSanitize: string | undefined;

async function main(): Promise<void> {
  const options = parseBgeM3BackfillArgs(process.argv.slice(2));
  // 先驗 embed-service 健康再連 DB，避免服務沒起來時白跑
  await checkServiceHealth(options.serviceUrl);
  const dsn = readDsnFile(options.dsnFile);
  dsnForSanitize = dsn;

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
  });

  const client = postgres(dsn, { max: 1, connect_timeout: 15 });
  try {
    const result = await runBgeM3Backfill(options, {
      store: createSqlBackfillStore(client),
      embed: (texts) => requestLocalEmbeddings(
        texts,
        { url: options.serviceUrl, timeoutMs: options.timeoutMs },
      ),
      report: (line) => { process.stderr.write(`${line}\n`); },
      shouldStop: () => interrupted,
    });
    const status = interrupted && result.status === 'completed' ? 'interrupted' : result.status;
    process.stderr.write(
      `[backfill-bge-m3] done status=${status} dry_run=${result.dryRun} ` +
      `scanned=${result.total.scanned} updated=${result.total.updated} ` +
      `skipped_changed=${result.total.skipped_changed} ` +
      `failed_rows=${result.total.failed_rows} failed_batches=${result.total.failed_batches}\n`
    );
    process.stdout.write(`${JSON.stringify({ ...result, status })}\n`);
    if (status === 'interrupted') {
      process.exitCode = 130;
    } else if (status === 'aborted') {
      process.exitCode = 1;
    } else if (result.total.failed_batches > 0) {
      process.stderr.write('[backfill-bge-m3] rerun to retry failed rows\n');
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'backfill-bge-m3';

if (isMain) {
  main().catch((error) => {
    // 不輸出 error.message 以外的東西；DSN 若出現在訊息中一律遮罩
    let message = error instanceof Error ? error.message : String(error);
    if (dsnForSanitize) {
      message = message.split(dsnForSanitize).join('[dsn]');
    }
    process.stderr.write(`[backfill-bge-m3] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
