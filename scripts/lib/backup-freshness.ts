export const REQUIRED_BACKUP_TARGETS = ['project', 'personal'] as const;
export type BackupTarget = (typeof REQUIRED_BACKUP_TARGETS)[number];

export interface RemoteBackupManifestEvidence {
  key: string;
  source: string;
}

export interface BackupFreshnessTargetResult {
  target: BackupTarget;
  status: 'PASS' | 'FAIL';
  completedAt: string | null;
  ageHours: number | null;
  manifestKey: string | null;
  reason: string;
}

export interface BackupFreshnessReport {
  overall: 'PASS' | 'FAIL';
  generatedAt: string;
  maxAgeHours: number;
  targets: BackupFreshnessTargetResult[];
}

export interface BackupFreshnessState {
  version: 1;
  activeFingerprint: string | null;
  firstFailedAt: string | null;
  lastAlertedAt: string | null;
  lastSuccessAt: string | null;
}

export interface BackupFreshnessAlertDecision {
  action: 'failure' | 'recovery' | 'suppressed' | 'none';
  baseState: BackupFreshnessState;
  alertedState: BackupFreshnessState;
}

interface BackupManifest {
  schema_version: number;
  run_id: string;
  target: string;
  created_at: string;
  completed_at: string;
  object_key: string;
  manifest_key: string;
  postgres_server_version_num: number;
  dump_format: string;
  plain: { bytes: number; sha256: string };
  cipher: { bytes: number; sha256: string };
  age_recipient: string;
  remote_verification: { bytes: number; sha256: string; method: string };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function canonicalManifestPattern(target: BackupTarget): RegExp {
  return new RegExp(
    `^backups/v1/${target}/\\d{4}/(?:0[1-9]|1[0-2])/` +
    '(\\d{8}T\\d{6}Z-[0-9a-f]{16})\\.manifest\\.json$',
  );
}

export function selectLatestManifestKey(
  target: BackupTarget,
  keys: readonly string[],
): string | null {
  const pattern = canonicalManifestPattern(target);
  return keys.filter((key) => pattern.test(key)).sort().at(-1) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function parseFileEvidence(
  value: unknown,
  label: string,
): { bytes: number; sha256: string } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    bytes: parsePositiveInteger(value.bytes, `${label}.bytes`),
    sha256: parseHash(value.sha256, `${label}.sha256`),
  };
}

function parseManifest(source: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('manifest is not valid JSON');
  }
  if (!isRecord(value)) throw new Error('manifest must be an object');
  if (!isRecord(value.remote_verification)) {
    throw new Error('remote verification must be an object');
  }
  return {
    schema_version: Number(value.schema_version),
    run_id: String(value.run_id ?? ''),
    target: String(value.target ?? ''),
    created_at: String(value.created_at ?? ''),
    completed_at: String(value.completed_at ?? ''),
    object_key: String(value.object_key ?? ''),
    manifest_key: String(value.manifest_key ?? ''),
    postgres_server_version_num: Number(value.postgres_server_version_num),
    dump_format: String(value.dump_format ?? ''),
    plain: parseFileEvidence(value.plain, 'plain'),
    cipher: parseFileEvidence(value.cipher, 'cipher'),
    age_recipient: String(value.age_recipient ?? ''),
    remote_verification: {
      bytes: parsePositiveInteger(
        value.remote_verification.bytes,
        'remote_verification.bytes',
      ),
      sha256: parseHash(
        value.remote_verification.sha256,
        'remote_verification.sha256',
      ),
      method: String(value.remote_verification.method ?? ''),
    },
  };
}

function fail(
  target: BackupTarget,
  reason: string,
  evidence: RemoteBackupManifestEvidence | null,
  completedAt: string | null = null,
  ageHours: number | null = null,
): BackupFreshnessTargetResult {
  return {
    target,
    status: 'FAIL',
    completedAt,
    ageHours,
    manifestKey: evidence?.key ?? null,
    reason,
  };
}

function assessTarget(input: {
  target: BackupTarget;
  evidence: RemoteBackupManifestEvidence | null;
  collectionError?: string;
  expectedRecipient: string;
  maxAgeMs: number;
  now: Date;
}): BackupFreshnessTargetResult {
  const { target, evidence, collectionError, expectedRecipient, maxAgeMs, now } = input;
  if (collectionError) return fail(target, collectionError, evidence);
  if (!evidence) return fail(target, 'manifest missing', null);

  let manifest: BackupManifest;
  try {
    manifest = parseManifest(evidence.source);
  } catch (error) {
    return fail(target, error instanceof Error ? error.message : String(error), evidence);
  }

  const keyMatch = evidence.key.match(canonicalManifestPattern(target));
  if (!keyMatch) return fail(target, 'manifest key is not canonical', evidence);
  const expectedRunId = keyMatch[1];
  if (
    manifest.schema_version !== 1 ||
    manifest.target !== target ||
    manifest.run_id !== expectedRunId ||
    !RUN_ID_PATTERN.test(manifest.run_id) ||
    manifest.manifest_key !== evidence.key
  ) {
    return fail(target, 'manifest identity does not match its key', evidence);
  }
  const expectedObjectKey = evidence.key.replace(/\.manifest\.json$/, '.dump.age');
  if (manifest.object_key !== expectedObjectKey) {
    return fail(target, 'cipher object key does not match manifest key', evidence);
  }
  if (
    manifest.postgres_server_version_num < 180000 ||
    manifest.dump_format !== 'custom'
  ) {
    return fail(target, 'manifest does not prove a PostgreSQL 18 custom dump', evidence);
  }
  if (manifest.age_recipient !== expectedRecipient) {
    return fail(target, 'manifest age recipient does not match the pinned recipient', evidence);
  }
  if (
    manifest.remote_verification.method !== 'full-readback' ||
    manifest.remote_verification.bytes !== manifest.cipher.bytes ||
    manifest.remote_verification.sha256 !== manifest.cipher.sha256
  ) {
    return fail(target, 'remote verification does not match ciphertext', evidence);
  }

  const completedAtMs = Date.parse(manifest.completed_at);
  const createdAtMs = Date.parse(manifest.created_at);
  if (
    Number.isNaN(completedAtMs) ||
    Number.isNaN(createdAtMs) ||
    createdAtMs > completedAtMs
  ) {
    return fail(target, 'manifest timestamps are invalid', evidence);
  }
  const ageMs = now.getTime() - completedAtMs;
  const ageHours = Math.round((ageMs / (60 * 60 * 1000)) * 100) / 100;
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return fail(target, 'completed_at is in the future', evidence, manifest.completed_at, ageHours);
  }
  if (ageMs > maxAgeMs) {
    return fail(
      target,
      `manifest is stale: age_hours=${ageHours}`,
      evidence,
      manifest.completed_at,
      ageHours,
    );
  }
  return {
    target,
    status: 'PASS',
    completedAt: manifest.completed_at,
    ageHours,
    manifestKey: evidence.key,
    reason: 'fresh committed manifest with full ciphertext readback',
  };
}

export function assessBackupFreshness(input: {
  evidence: Record<BackupTarget, RemoteBackupManifestEvidence | null>;
  collectionErrors?: Partial<Record<BackupTarget, string>>;
  expectedRecipient: string;
  maxAgeMs: number;
  now?: Date;
}): BackupFreshnessReport {
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new Error('maxAgeMs must be positive');
  }
  const now = input.now ?? new Date();
  const targets = REQUIRED_BACKUP_TARGETS.map((target) => assessTarget({
    target,
    evidence: input.evidence[target],
    collectionError: input.collectionErrors?.[target],
    expectedRecipient: input.expectedRecipient,
    maxAgeMs: input.maxAgeMs,
    now,
  }));
  return {
    overall: targets.every((target) => target.status === 'PASS') ? 'PASS' : 'FAIL',
    generatedAt: now.toISOString(),
    maxAgeHours: input.maxAgeMs / (60 * 60 * 1000),
    targets,
  };
}

export function createEmptyBackupFreshnessState(): BackupFreshnessState {
  return {
    version: 1,
    activeFingerprint: null,
    firstFailedAt: null,
    lastAlertedAt: null,
    lastSuccessAt: null,
  };
}

function reportFingerprint(report: BackupFreshnessReport): string {
  const failures = report.targets
    .filter((target) => target.status === 'FAIL')
    .map((target) => ({
      target: target.target,
      reasonClass: target.reason.split(':', 1)[0],
    }));
  return failures.map((failure) => `${failure.target}:${failure.reasonClass}`).join('|');
}

export function decideBackupFreshnessAlert(
  previous: BackupFreshnessState,
  report: BackupFreshnessReport,
  now = new Date(),
  renotifyMs = 6 * 60 * 60 * 1000,
): BackupFreshnessAlertDecision {
  const nowIso = now.toISOString();
  if (report.overall === 'PASS') {
    const recovered = previous.activeFingerprint !== null;
    const next: BackupFreshnessState = {
      version: 1,
      activeFingerprint: null,
      firstFailedAt: null,
      lastAlertedAt: previous.lastAlertedAt,
      lastSuccessAt: nowIso,
    };
    return {
      action: recovered ? 'recovery' : 'none',
      baseState: next,
      alertedState: next,
    };
  }

  const fingerprint = reportFingerprint(report);
  const sameFailure = fingerprint === previous.activeFingerprint;
  const lastAlertedMs = previous.lastAlertedAt ? Date.parse(previous.lastAlertedAt) : Number.NaN;
  const shouldAlert = !sameFailure || !previous.lastAlertedAt ||
    (!Number.isNaN(lastAlertedMs) && now.getTime() - lastAlertedMs >= renotifyMs);
  const baseState: BackupFreshnessState = {
    version: 1,
    activeFingerprint: fingerprint,
    firstFailedAt: sameFailure && previous.firstFailedAt ? previous.firstFailedAt : nowIso,
    lastAlertedAt: sameFailure ? previous.lastAlertedAt : null,
    lastSuccessAt: previous.lastSuccessAt,
  };
  return {
    action: shouldAlert ? 'failure' : 'suppressed',
    baseState,
    alertedState: shouldAlert ? { ...baseState, lastAlertedAt: nowIso } : baseState,
  };
}
