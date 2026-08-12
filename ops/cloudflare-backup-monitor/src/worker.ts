import {
  assessBackupFreshness,
  REQUIRED_BACKUP_TARGETS,
  selectLatestManifestKey,
  type BackupFreshnessReport,
  type BackupTarget,
  type RemoteBackupManifestEvidence,
} from '../../../scripts/lib/backup-freshness.js';

interface R2ObjectLike {
  key: string;
}

interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  list(options: { prefix: string; cursor?: string }): Promise<R2ListResultLike>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

export interface MonitorEnv {
  BACKUPS: R2BucketLike;
  CC_MEMORY_AGE_RECIPIENT: string;
  CC_BACKUP_MAX_AGE_HOURS: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function maxAgeMs(env: MonitorEnv): number {
  const hours = Number(required(env.CC_BACKUP_MAX_AGE_HOURS, 'CC_BACKUP_MAX_AGE_HOURS'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error('CC_BACKUP_MAX_AGE_HOURS must be between 0 and 168');
  }
  return hours * 60 * 60 * 1000;
}

async function listManifestKeys(bucket: R2BucketLike, target: BackupTarget): Promise<string[]> {
  const prefix = `backups/v1/${target}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  let truncated = true;
  while (truncated) {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    if (keys.length > 10_000) throw new Error(`too many manifest objects for ${target}`);
    if (!page.truncated) return keys;
    if (!page.cursor || page.cursor === cursor) {
      throw new Error(`invalid R2 pagination cursor for ${target}`);
    }
    cursor = page.cursor;
    truncated = page.truncated;
  }
  return keys;
}

async function readLatestEvidence(
  bucket: R2BucketLike,
  target: BackupTarget,
): Promise<RemoteBackupManifestEvidence | null> {
  const key = selectLatestManifestKey(target, await listManifestKeys(bucket, target));
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) throw new Error(`latest manifest disappeared for ${target}`);
  return { key, source: await object.text() };
}

export async function inspectR2BackupFreshness(
  env: MonitorEnv,
  now = new Date(),
): Promise<BackupFreshnessReport> {
  const expectedRecipient = required(
    env.CC_MEMORY_AGE_RECIPIENT,
    'CC_MEMORY_AGE_RECIPIENT',
  );
  if (!/^age1[0-9a-z]+$/.test(expectedRecipient)) {
    throw new Error('CC_MEMORY_AGE_RECIPIENT is invalid');
  }
  const [project, personal] = await Promise.all(
    REQUIRED_BACKUP_TARGETS.map((target) => readLatestEvidence(env.BACKUPS, target)),
  );
  return assessBackupFreshness({
    evidence: { project, personal },
    expectedRecipient,
    maxAgeMs: maxAgeMs(env),
    now,
  });
}

function failureMessage(report: BackupFreshnessReport): string {
  return [
    '⚠️ CC-memory Cloudflare backup monitor alert',
    `time=${report.generatedAt}`,
    ...report.targets
      .filter((target) => target.status === 'FAIL')
      .map((target) => `${target.target}: ${target.reason}`),
  ].join('\n');
}

async function sendTelegram(
  env: MonitorEnv,
  message: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const botToken = required(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN');
  const chatId = required(env.TELEGRAM_CHAT_ID, 'TELEGRAM_CHAT_ID');
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    },
  );
  if (!response.ok) {
    throw new Error(`Telegram alert failed with HTTP ${response.status}`);
  }
}

export async function runScheduledBackupMonitor(
  env: MonitorEnv,
  now = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  let report: BackupFreshnessReport;
  try {
    report = await inspectR2BackupFreshness(env, now);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegram(
      env,
      [
        '⚠️ CC-memory Cloudflare backup monitor exception',
        `time=${now.toISOString()}`,
        `problem=${reason}`,
      ].join('\n'),
      fetchImpl,
    );
    throw new Error(`backup freshness inspection failed: ${reason}`);
  }
  if (report.overall === 'FAIL') {
    await sendTelegram(env, failureMessage(report), fetchImpl);
    throw new Error('backup freshness gate failed');
  }
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(
    _controller: unknown,
    env: MonitorEnv,
    _context: ExecutionContextLike,
  ): Promise<void> {
    await runScheduledBackupMonitor(env);
  },
};
