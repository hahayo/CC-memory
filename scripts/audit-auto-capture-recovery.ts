import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const DEFAULT_SPOOL_DIR = join(homedir(), '.cache', 'cc-memory', 'spool');

interface DeadLetterMetadata {
  session_id?: unknown;
  offset?: { start?: unknown; end?: unknown };
  hwm_offset?: { start?: unknown; end?: unknown };
  source?: {
    path_hash?: unknown;
    start?: unknown;
    end?: unknown;
    content_hash?: unknown;
  };
}

interface ParsedSpoolRecord {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

interface SpoolSnapshot {
  kind: 'active' | 'sealed';
  records: ParsedSpoolRecord[];
  sessionIds: Set<string>;
}

export interface RecoveryCandidateRange {
  path_hash: string;
  start: number;
  end: number;
  source_exists: boolean;
}

export interface RecoveryManifestEntry {
  dead_letter_id: string;
  session_hash: string;
  spool_kind: 'active' | 'sealed' | 'missing';
  classifications: string[];
  candidate_ranges: RecoveryCandidateRange[];
  ambiguity_reasons: string[];
  recommended_action: string;
  would_replay: false;
}

export interface RecoveryManifest {
  version: 1;
  generated_at: string;
  spool_root_hash: string;
  would_replay: false;
  entries: RecoveryManifestEntry[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseSpool(buffer: Buffer): ParsedSpoolRecord[] {
  const records: ParsedSpoolRecord[] = [];
  let start = 0;
  for (const line of buffer.toString('utf8').split('\n')) {
    const end = start + Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim().length > 0) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        records.push({ start, end, value });
      } catch {
        // Malformed historical lines are represented by missing candidate evidence.
      }
    }
    start = end;
  }
  return records;
}

async function listSpoolSnapshots(root: string): Promise<SpoolSnapshot[]> {
  const snapshots: SpoolSnapshot[] = [];
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() || project.name === '.dead') continue;
    const projectDir = join(root, project.name);
    const files = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      const active = file.name.endsWith('.jsonl');
      const sealed = file.name.includes('.jsonl.') && file.name.endsWith('.sealed');
      if (!active && !sealed) continue;
      const buffer = await readFile(join(projectDir, file.name)).catch(() => null);
      if (!buffer) continue;
      const records = parseSpool(buffer);
      snapshots.push({
        kind: active ? 'active' : 'sealed',
        records,
        sessionIds: new Set(records.flatMap((record) =>
          typeof record.value.session_id === 'string' ? [record.value.session_id] : []
        )),
      });
    }
  }
  return snapshots;
}

function recordsForDeadLetter(
  snapshot: SpoolSnapshot,
  sessionId: string,
  offsetStart: number | null,
  offsetEnd: number | null
): ParsedSpoolRecord[] {
  if (!snapshot.sessionIds.has(sessionId)) return [];
  const sessionMatches = snapshot.records.filter((record) => {
    const recordSession = record.value.session_id;
    return recordSession === sessionId || recordSession === undefined;
  });
  if (offsetStart === null || offsetEnd === null) return sessionMatches;
  return sessionMatches.filter((record) => record.end > offsetStart && record.start < offsetEnd);
}

async function rangesFromRecords(records: ParsedSpoolRecord[]): Promise<RecoveryCandidateRange[]> {
  const grouped = new Map<string, { path: string; start: number; end: number }>();
  for (const record of records) {
    const path = record.value.transcript_path;
    if (typeof path !== 'string' || path.length === 0) continue;
    const boundary = nonNegativeInteger(record.value.transcript_offset)
      ?? nonNegativeInteger(record.value.hwm_offset);
    if (boundary === null) continue;
    const pathHash = sha256(path);
    const previous = grouped.get(pathHash);
    grouped.set(pathHash, {
      path,
      start: previous ? Math.min(previous.start, boundary) : boundary,
      end: previous ? Math.max(previous.end, boundary) : boundary,
    });
  }
  const ranges: RecoveryCandidateRange[] = [];
  for (const [pathHash, range] of grouped) {
    ranges.push({
      path_hash: pathHash,
      start: range.start,
      end: range.end,
      source_exists: await stat(range.path).then(() => true).catch(() => false),
    });
  }
  return ranges.sort((a, b) => a.path_hash.localeCompare(b.path_hash));
}

function directSourceRange(metadata: DeadLetterMetadata): RecoveryCandidateRange | null {
  const source = metadata.source;
  if (!source || typeof source.path_hash !== 'string') return null;
  const start = nonNegativeInteger(source.start);
  const end = nonNegativeInteger(source.end);
  if (!/^[a-f0-9]{64}$/.test(source.path_hash) || start === null || end === null || end < start) {
    return null;
  }
  return {
    path_hash: source.path_hash,
    start,
    end,
    source_exists: false,
  };
}

function classifyEntry(input: {
  ranges: RecoveryCandidateRange[];
  spoolKind: RecoveryManifestEntry['spool_kind'];
  legacyWindow: boolean;
}): Pick<RecoveryManifestEntry, 'classifications' | 'ambiguity_reasons' | 'recommended_action'> {
  const classifications: string[] = [];
  const ambiguityReasons: string[] = [];
  if (input.ranges.length === 1) classifications.push('single_transcript_path');
  if (input.ranges.length > 1) {
    classifications.push('mixed_transcript_paths');
    ambiguityReasons.push('dead-letter spool range references multiple transcript paths');
  }
  if (input.spoolKind === 'missing' || input.ranges.length === 0) {
    classifications.push('source_missing');
    ambiguityReasons.push('matching active or sealed spool snapshot was not found');
  }
  if (input.ranges.some((range) => !range.source_exists)) {
    if (!classifications.includes('source_missing')) classifications.push('source_missing');
    ambiguityReasons.push('one or more transcript sources no longer exist');
  }
  if (input.legacyWindow) {
    classifications.push('prior_chunk_commit_unknown');
    ambiguityReasons.push('legacy window metadata cannot prove whether an earlier chunk committed');
  }
  if (
    input.ranges.length === 1 &&
    input.ranges[0].source_exists &&
    !input.legacyWindow
  ) {
    classifications.push('recoverable_single_path');
  }
  const recommendedAction = classifications.includes('recoverable_single_path')
    ? 'prepare a separately approved replay after checking DB source coverage'
    : 'manual evidence review required; do not replay automatically';
  return { classifications, ambiguity_reasons: [...new Set(ambiguityReasons)], recommended_action: recommendedAction };
}

export async function auditAutoCaptureRecovery(input: {
  spoolDir?: string;
  outputPath: string;
  now?: Date;
}): Promise<RecoveryManifest> {
  const spoolDir = resolve(input.spoolDir ?? DEFAULT_SPOOL_DIR);
  const outputPath = resolve(input.outputPath);
  if (outputPath !== '/tmp' && !outputPath.startsWith('/tmp/')) {
    throw new Error('Recovery manifest output must stay under /tmp');
  }
  const snapshots = await listSpoolSnapshots(spoolDir);
  const deadDir = join(spoolDir, '.dead');
  const deadFiles = (await readdir(deadDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries: RecoveryManifestEntry[] = [];

  for (const deadFile of deadFiles) {
    const payload = await readFile(join(deadDir, deadFile.name), 'utf8')
      .then((raw) => JSON.parse(raw) as { metadata?: DeadLetterMetadata })
      .catch(() => null);
    if (!payload?.metadata) continue;
    const metadata = payload.metadata;
    const sessionId = typeof metadata.session_id === 'string' ? metadata.session_id : 'unknown';
    const offsetStart = nonNegativeInteger(metadata.offset?.start);
    const offsetEnd = nonNegativeInteger(metadata.offset?.end);
    const direct = directSourceRange(metadata);
    let matchingSnapshot: SpoolSnapshot | null = null;
    let ranges: RecoveryCandidateRange[] = [];
    for (const snapshot of snapshots) {
      const records = recordsForDeadLetter(snapshot, sessionId, offsetStart, offsetEnd);
      if (records.length === 0) continue;
      matchingSnapshot = snapshot;
      ranges = await rangesFromRecords(records);
      break;
    }
    if (direct) {
      const matching = ranges.find((range) => range.path_hash === direct.path_hash);
      ranges = [{ ...direct, source_exists: matching?.source_exists ?? false }];
    }
    const spoolKind = matchingSnapshot?.kind ?? 'missing';
    const classified = classifyEntry({
      ranges,
      spoolKind,
      legacyWindow: direct === null && metadata.hwm_offset !== undefined,
    });
    entries.push({
      dead_letter_id: basename(deadFile.name, '.json'),
      session_hash: sha256(sessionId),
      spool_kind: spoolKind,
      ...classified,
      candidate_ranges: ranges,
      would_replay: false,
    });
  }

  const manifest: RecoveryManifest = {
    version: 1,
    generated_at: (input.now ?? new Date()).toISOString(),
    spool_root_hash: sha256(spoolDir),
    would_replay: false,
    entries,
  };
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  return manifest;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const spoolDir = optionValue(args, '--spool-dir') ?? process.env.CC_MEMORY_SPOOL_DIR;
  const defaultOutput = `/tmp/cc-memory-auto-capture-recovery-${Date.now()}.json`;
  const outputPath = optionValue(args, '--output') ?? defaultOutput;
  const manifest = await auditAutoCaptureRecovery({ spoolDir, outputPath });
  process.stdout.write(`${JSON.stringify({ output: outputPath, entries: manifest.entries.length, would_replay: false })}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'audit-auto-capture-recovery';

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[audit-auto-capture-recovery] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
