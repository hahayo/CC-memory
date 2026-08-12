#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  assessBackupFreshness,
  createEmptyBackupFreshnessState,
  decideBackupFreshnessAlert,
  REQUIRED_BACKUP_TARGETS,
  selectLatestManifestKey,
  type BackupFreshnessReport,
  type BackupFreshnessState,
  type BackupTarget,
  type RemoteBackupManifestEvidence,
} from './lib/backup-freshness.js';
import {
  resolveAutoCaptureAlertTarget,
  sendAutoCaptureTelegramMessage,
} from '../src/services/auto-capture-alerts.js';

interface BackupFreshnessConfig {
  bucket: string;
  expectedRecipient: string;
  maxAgeMs: number;
  stateFile: string;
  rcloneEnv: NodeJS.ProcessEnv;
}

interface RcloneResult {
  status: number | null;
  stdout: string;
}

type RcloneRunner = (args: string[], env: NodeJS.ProcessEnv) => RcloneResult;

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function resolveBackupFreshnessConfig(
  source: NodeJS.ProcessEnv = process.env,
): BackupFreshnessConfig {
  const bucket = required(source, 'CC_MEMORY_R2_BUCKET');
  const endpoint = required(source, 'AWS_ENDPOINT_URL');
  const expectedRecipient = required(source, 'CC_MEMORY_AGE_RECIPIENT');
  const maxAgeHours = Number(source.CC_BACKUP_MAX_AGE_HOURS?.trim() || '26');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    throw new Error('CC_MEMORY_R2_BUCKET is invalid');
  }
  if (!/^https:\/\/\S+$/.test(endpoint)) {
    throw new Error('AWS_ENDPOINT_URL must be an https URL without whitespace');
  }
  if (!/^age1[0-9a-z]+$/.test(expectedRecipient)) {
    throw new Error('CC_MEMORY_AGE_RECIPIENT is invalid');
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 168) {
    throw new Error('CC_BACKUP_MAX_AGE_HOURS must be between 0 and 168');
  }
  const rcloneEnv: NodeJS.ProcessEnv = {
    ...source,
    RCLONE_CONFIG_CCMR2_TYPE: 's3',
    RCLONE_CONFIG_CCMR2_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_CCMR2_ACCESS_KEY_ID: required(source, 'AWS_ACCESS_KEY_ID'),
    RCLONE_CONFIG_CCMR2_SECRET_ACCESS_KEY: required(source, 'AWS_SECRET_ACCESS_KEY'),
    RCLONE_CONFIG_CCMR2_ENDPOINT: endpoint,
    RCLONE_CONFIG_CCMR2_REGION: required(source, 'AWS_DEFAULT_REGION'),
    RCLONE_CONFIG_CCMR2_NO_CHECK_BUCKET: 'true',
  };
  return {
    bucket,
    expectedRecipient,
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    stateFile: source.CC_BACKUP_FRESHNESS_STATE_FILE?.trim() || path.join(
      homedir(),
      '.local',
      'state',
      'cc-memory',
      'backup-freshness.json',
    ),
    rcloneEnv,
  };
}

const defaultRcloneRunner: RcloneRunner = (args, env) => {
  const result = spawnSync('rclone', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
};

export function collectRemoteManifestEvidence(
  target: BackupTarget,
  config: Pick<BackupFreshnessConfig, 'bucket' | 'rcloneEnv'>,
  runRclone: RcloneRunner = defaultRcloneRunner,
): RemoteBackupManifestEvidence | null {
  const prefix = `backups/v1/${target}/`;
  const listed = runRclone([
    'lsf',
    `ccmr2:${config.bucket}/${prefix}`,
    '--recursive',
    '--files-only',
    '--include',
    '*.manifest.json',
    '--config',
    '/dev/null',
  ], config.rcloneEnv);
  if (listed.status !== 0) throw new Error(`R2 manifest listing failed for ${target}`);
  const keys = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.startsWith('backups/') ? line : `${prefix}${line}`);
  const key = selectLatestManifestKey(target, keys);
  if (!key) return null;
  const read = runRclone([
    'cat',
    `ccmr2:${config.bucket}/${key}`,
    '--config',
    '/dev/null',
  ], config.rcloneEnv);
  if (read.status !== 0) throw new Error(`R2 manifest read failed for ${target}`);
  return { key, source: read.stdout };
}

function sanitizeState(value: unknown): BackupFreshnessState {
  if (!value || typeof value !== 'object') return createEmptyBackupFreshnessState();
  const state = value as Partial<BackupFreshnessState>;
  if (state.version !== 1) return createEmptyBackupFreshnessState();
  return {
    version: 1,
    activeFingerprint: typeof state.activeFingerprint === 'string'
      ? state.activeFingerprint
      : null,
    firstFailedAt: typeof state.firstFailedAt === 'string' ? state.firstFailedAt : null,
    lastAlertedAt: typeof state.lastAlertedAt === 'string' ? state.lastAlertedAt : null,
    lastSuccessAt: typeof state.lastSuccessAt === 'string' ? state.lastSuccessAt : null,
  };
}

export async function loadBackupFreshnessState(file: string): Promise<BackupFreshnessState> {
  try {
    return sanitizeState(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return createEmptyBackupFreshnessState();
  }
}

export async function saveBackupFreshnessState(
  file: string,
  state: BackupFreshnessState,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function formatFailure(report: BackupFreshnessReport): string {
  const problems = report.targets
    .filter((target) => target.status === 'FAIL')
    .map((target) => `${target.target}: ${target.reason}`);
  return [
    '⚠️ CC-memory backup freshness alert',
    `time=${report.generatedAt}`,
    ...problems,
  ].join('\n');
}

function formatRecovery(report: BackupFreshnessReport): string {
  return [
    '✅ CC-memory backup freshness recovered',
    `time=${report.generatedAt}`,
    ...report.targets.map((target) => (
      `${target.target}: completed_at=${target.completedAt} age_hours=${target.ageHours}`
    )),
  ].join('\n');
}

export async function runBackupFreshnessCheck(input: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  runRclone?: RcloneRunner;
  sendMessage?: (text: string) => Promise<void>;
} = {}): Promise<{ exitCode: 0 | 1; report: BackupFreshnessReport }> {
  const env = input.env ?? process.env;
  const config = resolveBackupFreshnessConfig(env);
  const evidence = { project: null, personal: null } as Record<
    BackupTarget,
    RemoteBackupManifestEvidence | null
  >;
  const collectionErrors: Partial<Record<BackupTarget, string>> = {};
  for (const target of REQUIRED_BACKUP_TARGETS) {
    try {
      evidence[target] = collectRemoteManifestEvidence(target, config, input.runRclone);
    } catch (error) {
      collectionErrors[target] = error instanceof Error ? error.message : String(error);
    }
  }
  const now = input.now ?? new Date();
  const report = assessBackupFreshness({
    evidence,
    collectionErrors,
    expectedRecipient: config.expectedRecipient,
    maxAgeMs: config.maxAgeMs,
    now,
  });
  const previous = await loadBackupFreshnessState(config.stateFile);
  const decision = decideBackupFreshnessAlert(previous, report, now);
  await saveBackupFreshnessState(config.stateFile, decision.baseState);

  if (decision.action === 'failure' || decision.action === 'recovery') {
    const sendMessage = input.sendMessage ?? (async (text: string) => {
      const target = resolveAutoCaptureAlertTarget(env);
      await sendAutoCaptureTelegramMessage(target, text);
    });
    await sendMessage(decision.action === 'failure' ? formatFailure(report) : formatRecovery(report));
    await saveBackupFreshnessState(config.stateFile, decision.alertedState);
  }

  return { exitCode: report.overall === 'PASS' ? 0 : 1, report };
}

function printHuman(report: BackupFreshnessReport): void {
  process.stdout.write(`CC-memory backup freshness: ${report.overall}\n`);
  for (const target of report.targets) {
    process.stdout.write(
      `[${target.status}] ${target.target}: ${target.reason}; ` +
      `completed_at=${target.completedAt ?? 'unknown'} age_hours=${target.ageHours ?? 'unknown'}\n`,
    );
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    process.stderr.write('Usage: npm run backup:freshness -- [--json]\n');
    return 2;
  }
  const { exitCode, report } = await runBackupFreshnessCheck();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  return exitCode;
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined &&
  path.basename(invokedPath).replace(/\.[cm]?[jt]s$/, '') === 'check-backup-freshness';
if (isMain) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[cc-memory] backup freshness checker failed: ${message}\n`);
      try {
        const target = resolveAutoCaptureAlertTarget(process.env);
        await sendAutoCaptureTelegramMessage(
          target,
          `⚠️ CC-memory backup freshness checker failed\ntime=${new Date().toISOString()}\n${message}`,
        );
      } catch {
        // The primary error remains authoritative when alert delivery is also unavailable.
      }
      process.exitCode = 1;
    });
}
