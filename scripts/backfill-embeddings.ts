#!/usr/bin/env npx tsx
/**
 * Idempotent embedding backfill for active project memories and observations.
 * Defaults to dry-run; pass --execute to call Gemini and update rows.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { observations, projectMemories } from '../src/db/schema.js';
import {
  prepareEmbeddingText,
  type EmbeddingPolicyEvidence,
} from '../src/utils/embedding.js';
import {
  isolateBenchmarkEmbeddingEnvironment,
  loadBenchmarkEmbeddingCredential,
  type EmbeddingCredentialEvidence,
} from './lib/benchmark-runner.js';

export type EmbeddingBackfillTarget = 'project_memories' | 'observations';

export type EmbeddingBackfillRecord =
  | {
      target: 'project_memories';
      id: string;
      summary: string;
      keywords: string[] | null;
      decisions: string[] | null;
    }
  | {
      target: 'observations';
      id: string;
      title: string;
      facts: string[];
      narrative: string;
    };

export interface EmbeddingBackfillStore {
  fetchBatch(input: {
    target: EmbeddingBackfillTarget;
    afterId?: string;
    limit: number;
  }): Promise<EmbeddingBackfillRecord[]>;
  updateEmbedding(input: {
    target: EmbeddingBackfillTarget;
    id: string;
    embedding: number[];
    embeddingPolicy: EmbeddingPolicyEvidence;
  }): Promise<void>;
}

export interface EmbeddingBackfillOptions {
  targets: EmbeddingBackfillTarget[];
  dryRun: boolean;
  batchSize: number;
  requestsPerMinute: number;
  maxConsecutiveFailures: number;
  limit?: number;
}

export interface EmbeddingBackfillResult {
  scanned: number;
  attempted: number;
  updated: number;
  failed: number;
}

export interface EmbeddingBackfillDeps {
  store: EmbeddingBackfillStore;
  generateEmbedding: (text: string) => Promise<number[] | null>;
  sleep?: (ms: number) => Promise<void>;
  report?: (line: string) => void;
}

interface EmbeddingBackfillCliOptions extends EmbeddingBackfillOptions {
  keyFile: string;
}

function composeBackfillText(record: EmbeddingBackfillRecord): string {
  if (record.target === 'project_memories') {
    const parts = [record.summary];
    if (record.keywords && record.keywords.length > 0) {
      parts.push(`關鍵字: ${record.keywords.join(', ')}`);
    }
    if (record.decisions && record.decisions.length > 0) {
      parts.push(`決策: ${record.decisions.join('; ')}`);
    }
    return parts.join('\n');
  }
  return [record.title, record.facts.join(' '), record.narrative].join('\n');
}

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

export function parseEmbeddingBackfillArgs(args: string[]): EmbeddingBackfillCliOptions {
  const dryRun = !args.includes('--execute');
  const explicitKeyFile = optionValue(args, '--key-file');
  if (!dryRun && !explicitKeyFile) {
    throw new Error('--key-file is required with --execute');
  }
  const table = optionValue(args, '--table') ?? 'project_memories';
  const targets: EmbeddingBackfillTarget[] = table === 'all'
    ? ['project_memories', 'observations']
    : table === 'project_memories' || table === 'observations'
      ? [table]
      : (() => { throw new Error('--table must be project_memories, observations, or all'); })();
  const limitRaw = optionValue(args, '--limit');

  return {
    targets,
    dryRun,
    batchSize: positiveInteger(
      optionValue(args, '--batch-size') ?? (dryRun ? '1000' : '10'),
      '--batch-size'
    ),
    requestsPerMinute: positiveInteger(optionValue(args, '--rpm') ?? '60', '--rpm'),
    maxConsecutiveFailures: positiveInteger(
      optionValue(args, '--max-consecutive-failures') ?? '20',
      '--max-consecutive-failures'
    ),
    limit: limitRaw === undefined ? undefined : positiveInteger(limitRaw, '--limit'),
    keyFile: explicitKeyFile ?? path.join(homedir(), '.gemini-api-key'),
  };
}

export async function loadEmbeddingBackfillCredential(
  keyFile: string,
  userHome: string,
): Promise<{ apiKey: string; evidence: EmbeddingCredentialEvidence }> {
  return loadBenchmarkEmbeddingCredential(keyFile, userHome);
}

export function isolateEmbeddingBackfillEnvironment(env: NodeJS.ProcessEnv): void {
  isolateBenchmarkEmbeddingEnvironment(env);
}

type EmbeddingModule = Pick<typeof import('../src/utils/embedding.js'), 'generateEmbedding'>;

export async function loadIsolatedEmbeddingGenerator(
  env: NodeJS.ProcessEnv,
  importEmbedding: () => Promise<EmbeddingModule> = () => import('../src/utils/embedding.js'),
): Promise<EmbeddingModule['generateEmbedding']> {
  isolateEmbeddingBackfillEnvironment(env);
  return (await importEmbedding()).generateEmbedding;
}

export async function runEmbeddingBackfill(
  options: EmbeddingBackfillOptions,
  deps: EmbeddingBackfillDeps
): Promise<EmbeddingBackfillResult> {
  const result: EmbeddingBackfillResult = { scanned: 0, attempted: 0, updated: 0, failed: 0 };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const requestIntervalMs = Math.ceil(60_000 / options.requestsPerMinute);
  let consecutiveFailures = 0;
  let hasAttemptedRequest = false;

  for (const target of options.targets) {
    let afterId: string | undefined;
    while (options.limit === undefined || result.scanned < options.limit) {
      const remaining = options.limit === undefined
        ? options.batchSize
        : Math.min(options.batchSize, options.limit - result.scanned);
      if (remaining <= 0) break;
      const batch = await deps.store.fetchBatch({ target, afterId, limit: remaining });
      if (batch.length === 0) break;

      for (const record of batch) {
        result.scanned += 1;
        afterId = record.id;
        if (options.dryRun) continue;

        if (hasAttemptedRequest) await sleep(requestIntervalMs);
        hasAttemptedRequest = true;
        result.attempted += 1;

        let embedding: number[] | null = null;
        const prepared = prepareEmbeddingText(composeBackfillText(record));
        try {
          embedding = await deps.generateEmbedding(prepared.text);
        } catch {
          embedding = null;
        }

        if (!embedding) {
          result.failed += 1;
          consecutiveFailures += 1;
          deps.report?.(
            `[backfill-embeddings] embedding-failed target=${record.target} id=${record.id} ` +
            `consecutive_failures=${consecutiveFailures}`
          );
          if (consecutiveFailures >= options.maxConsecutiveFailures) {
            throw new Error(
              `embedding backfill stopped after ${consecutiveFailures} consecutive embedding failures`
            );
          }
          if (result.attempted % options.batchSize === 0) {
            deps.report?.(
              `[backfill-embeddings] progress scanned=${result.scanned} attempted=${result.attempted} ` +
              `updated=${result.updated} failed=${result.failed}`
            );
          }
          continue;
        }

        await deps.store.updateEmbedding({
          target,
          id: record.id,
          embedding,
          embeddingPolicy: prepared.evidence,
        });
        result.updated += 1;
        consecutiveFailures = 0;
        if (result.attempted % options.batchSize === 0) {
          deps.report?.(
            `[backfill-embeddings] progress scanned=${result.scanned} attempted=${result.attempted} ` +
            `updated=${result.updated} failed=${result.failed}`
          );
        }
      }
    }
  }

  return result;
}

function createDrizzleBackfillStore(
  db: ReturnType<typeof drizzle>
): EmbeddingBackfillStore {
  return {
    async fetchBatch({ target, afterId, limit }) {
      if (target === 'project_memories') {
        const rows = await db
          .select({
            id: projectMemories.id,
            summary: projectMemories.summary,
            keywords: projectMemories.keywords,
            decisions: projectMemories.decisions,
          })
          .from(projectMemories)
          .where(and(
            eq(projectMemories.status, 'active'),
            isNull(projectMemories.embedding),
            afterId ? gt(projectMemories.id, afterId) : undefined
          ))
          .orderBy(asc(projectMemories.id))
          .limit(limit);
        return rows.map((row) => ({ target, ...row }));
      }

      const rows = await db
        .select({
          id: observations.id,
          title: observations.title,
          facts: observations.facts,
          narrative: observations.narrative,
        })
        .from(observations)
        .where(and(
          eq(observations.status, 'active'),
          isNull(observations.embedding),
          afterId ? gt(observations.id, afterId) : undefined
        ))
        .orderBy(asc(observations.id))
        .limit(limit);
      return rows.map((row) => ({ target, ...row }));
    },

    async updateEmbedding({ target, id, embedding, embeddingPolicy }) {
      const metadataPatch = JSON.stringify({ embedding_policy: embeddingPolicy });
      if (target === 'project_memories') {
        await db
          .update(projectMemories)
          .set({
            embedding,
            metadata: sql`coalesce(${projectMemories.metadata}, '{}'::jsonb) || ${metadataPatch}::jsonb`,
          })
          .where(eq(projectMemories.id, id));
        return;
      }
      await db
        .update(observations)
        .set({
          embedding,
          metadata: sql`coalesce(${observations.metadata}, '{}'::jsonb) || ${metadataPatch}::jsonb`,
        })
        .where(eq(observations.id, id));
    },
  };
}

async function main(): Promise<void> {
  const options = parseEmbeddingBackfillArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const generateEmbedding = await loadIsolatedEmbeddingGenerator(process.env);
  const credential = options.dryRun
    ? undefined
    : await loadEmbeddingBackfillCredential(options.keyFile, homedir());

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  try {
    const result = await runEmbeddingBackfill(options, {
      store: createDrizzleBackfillStore(db),
      generateEmbedding: (text) => generateEmbedding(text, { apiKey: credential?.apiKey }),
      report: (line) => { process.stderr.write(`${line}\n`); },
    });
    if (result.failed > 0) {
      process.stderr.write(
        `[backfill-embeddings] ${result.failed} rows failed; rerun the same command to retry them\n`
      );
    }
    process.stdout.write(`${JSON.stringify({
      dryRun: options.dryRun,
      targets: options.targets,
      credential: credential?.evidence ?? null,
      ...result,
    })}\n`);
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'backfill-embeddings';

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[backfill-embeddings] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
