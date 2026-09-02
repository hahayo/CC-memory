import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const SUMMARY_PREFIX = '[cc-memory] auto-capture summary:'
const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org'
export const DEFAULT_ALERT_TIMEOUT_MS = 10_000
export const DEFAULT_RENOTIFY_MS = 6 * 60 * 60 * 1000
const MAX_PROBLEM_LINE_LENGTH = 280

export interface AutoCaptureExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface AutoCaptureAssessment {
  ok: boolean
  exitCode: number
  deadLetterCount: number
  failedCount: number
  rateLimitedCount: number
  malformedCount: number
  blockedCount: number
  transcriptMissingCount: number
  parkedCount: number
  yieldedCount: number
  heldCount: number
  embeddingFailedCount: number
  primaryProvider: string
  primarySuccessCount: number
  fallbackSuccessCount: number
  fallbackFailedCount: number
  fatalCount: number
  spoolBytes: number
  spoolCapPct: number
  windowsCount: number
  warning: string | null
  summaryLine: string | null
  problemLine: string | null
  nonSummaryLines: string[]
  stderrLines: string[]
  fingerprint: string | null
}

export interface AutoCaptureAlertState {
  activeFingerprint: string | null
  firstFailedAt: string | null
  lastAlertedAt: string | null
  lastSuccessAt: string | null
  lastProblemLine: string | null
  lastSummaryLine: string | null
  lastExitCode: number | null
  lastDeadLetterCount: number | null
  recoveryFailureCount?: number
  /** Consecutive ticks with fallback-success > 0 (streak for escalation) */
  fallbackSuccessStreak?: number
  /** Spool capacity warning band already alerted (e.g. '70-89') — dedup same band */
  spoolCapWarningBand?: string | null
  /** ISO timestamp of last fallback-streak warning sent — dedup via renotify interval */
  fallbackWarningLastSentAt?: string | null
}

export interface AutoCaptureAlertTarget {
  botToken: string
  chatId: string
  apiBase: string
  timeoutMs: number
}

export interface AutoCaptureFailureDecision {
  send: boolean
  reason: 'new-fingerprint' | 'renotify' | 'suppressed'
  baseState: AutoCaptureAlertState
  alertedState: AutoCaptureAlertState
}

export function createEmptyAutoCaptureAlertState(): AutoCaptureAlertState {
  return {
    activeFingerprint: null,
    firstFailedAt: null,
    lastAlertedAt: null,
    lastSuccessAt: null,
    lastProblemLine: null,
    lastSummaryLine: null,
    lastExitCode: null,
    lastDeadLetterCount: null,
  }
}

export function parseSimpleEnvFile(source: string): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eqIndex = normalized.indexOf('=')
    if (eqIndex <= 0) continue

    const key = normalized.slice(0, eqIndex).trim()
    let value = normalized.slice(eqIndex + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    parsed[key] = value
  }

  return parsed
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function parseSummaryField(summaryLine: string | null, field: string): number {
  if (!summaryLine) return 0
  const match = summaryLine.match(new RegExp(`(?:^|\\s)${field}=(\\d+)`))
  return match ? Number.parseInt(match[1], 10) : 0
}

function parseDeadLetterCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'dead-letter')
}

function parseFailedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'failed')
}

function parseRateLimitedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'rate-limited')
}

function parseMalformedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'malformed')
}

function parseTranscriptMissingCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'transcript-missing')
}

function parseParkedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'parked')
}

function parseYieldedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'yielded')
}

function parseHeldCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'held')
}

function parseBlockedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'blocked')
}

function parseEmbeddingFailedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'embedding-failed')
}

function parsePrimarySuccessCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'primary-success')
}

function parseFallbackSuccessCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'fallback-success')
}

function parseFallbackFailedCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'fallback-failed')
}

function parseFatalCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'fatal')
}

function parseSpoolBytes(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'spool-bytes')
}

function parseSpoolCapPct(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'spool-cap-pct')
}

function parseWindowsCount(summaryLine: string | null): number {
  return parseSummaryField(summaryLine, 'windows')
}

function parsePrimaryProvider(summaryLine: string | null): string {
  if (!summaryLine) return ''
  const match = summaryLine.match(/(?:^|\s)primary-provider=(\S+)/)
  return match ? match[1] : ''
}

function truncateProblemLine(line: string): string {
  if (line.length <= MAX_PROBLEM_LINE_LENGTH) return line
  return `${line.slice(0, MAX_PROBLEM_LINE_LENGTH - 3)}...`
}

export function assessAutoCaptureExecution(result: AutoCaptureExecutionResult): AutoCaptureAssessment {
  const stdoutLines = normalizeLines(result.stdout)
  const stderrLines = normalizeLines(result.stderr)
  const summaryLine = stdoutLines.find((line) => line.startsWith(SUMMARY_PREFIX)) ?? null
  const nonSummaryLines = stdoutLines.filter((line) => line !== summaryLine)
  const deadLetterCount = parseDeadLetterCount(summaryLine)
  const failedCount = parseFailedCount(summaryLine)
  const rateLimitedCount = parseRateLimitedCount(summaryLine)
  const malformedCount = parseMalformedCount(summaryLine)
  const transcriptMissingCount = parseTranscriptMissingCount(summaryLine)
  const parkedCount = parseParkedCount(summaryLine)
  const yieldedCount = parseYieldedCount(summaryLine)
  const heldCount = parseHeldCount(summaryLine)
  const blockedCount = parseBlockedCount(summaryLine)
  const embeddingFailedCount = parseEmbeddingFailedCount(summaryLine)
  const primaryProvider = parsePrimaryProvider(summaryLine)
  const primarySuccessCount = parsePrimarySuccessCount(summaryLine)
  const fallbackSuccessCount = parseFallbackSuccessCount(summaryLine)
  const fallbackFailedCount = parseFallbackFailedCount(summaryLine)
  const fatalCount = parseFatalCount(summaryLine)
  const spoolBytes = parseSpoolBytes(summaryLine)
  const spoolCapPct = parseSpoolCapPct(summaryLine)
  const windowsCount = parseWindowsCount(summaryLine)

  // Warnings: independently evaluate fallback-success and spool capacity 70-89%
  const warnings: string[] = []
  if (fallbackSuccessCount > 0) {
    warnings.push(`fallback-success=${fallbackSuccessCount} (codex may be logged out, falling back to haiku)`)
  }
  if (spoolCapPct >= 70 && spoolCapPct < 90) {
    warnings.push(`spool-cap-pct=${spoolCapPct} (warning: approaching capacity)`)
  }
  const warning: string | null = warnings.length > 0 ? warnings.join('; ') : null

  const ok =
    result.exitCode === 0 &&
    nonSummaryLines.length === 0 &&
    deadLetterCount === 0 &&
    failedCount === 0 &&
    malformedCount === 0 &&
    rateLimitedCount === 0 &&
    blockedCount === 0 &&
    parkedCount === 0 &&
    embeddingFailedCount === 0 &&
    fallbackFailedCount === 0 &&
    fatalCount === 0 &&
    spoolCapPct < 90

  // Synthesize a problemLine when counts indicate issues but no explicit stdout problem line
  let problemLine: string | null = null
  if (!ok) {
    if (nonSummaryLines.length > 0) {
      problemLine = truncateProblemLine(nonSummaryLines[0])
    } else if (stderrLines.length > 0) {
      problemLine = truncateProblemLine(stderrLines[0])
    } else if (fatalCount > 0) {
      problemLine = `fatal=${fatalCount}`
    } else if (spoolCapPct >= 90) {
      problemLine = `spool-cap-pct=${spoolCapPct} (critical)`
    } else if (fallbackFailedCount > 0) {
      problemLine = `fallback-failed=${fallbackFailedCount}`
    } else if (rateLimitedCount > 0) {
      problemLine = `rate-limited=${rateLimitedCount}`
    } else if (blockedCount > 0) {
      problemLine = `blocked=${blockedCount}`
    } else if (failedCount > 0) {
      problemLine = `failed=${failedCount}`
    } else if (malformedCount > 0) {
      problemLine = `malformed=${malformedCount}`
    } else if (deadLetterCount > 0) {
      problemLine = `dead-letter=${deadLetterCount}`
    } else if (parkedCount > 0) {
      problemLine = `parked=${parkedCount}`
    } else if (embeddingFailedCount > 0) {
      problemLine = `embedding-failed=${embeddingFailedCount}`
    } else {
      problemLine = `worker exit=${result.exitCode}`
    }
  }

  const fingerprint =
    ok || problemLine === null
      ? null
      : createHash('sha256')
          .update(JSON.stringify({
            exitCode: result.exitCode,
            problemLine,
          }))
          .digest('hex')
          .slice(0, 12)

  return {
    ok,
    exitCode: result.exitCode,
    deadLetterCount,
    failedCount,
    rateLimitedCount,
    malformedCount,
    blockedCount,
    transcriptMissingCount,
    parkedCount,
    yieldedCount,
    heldCount,
    embeddingFailedCount,
    primaryProvider,
    primarySuccessCount,
    fallbackSuccessCount,
    fallbackFailedCount,
    fatalCount,
    spoolBytes,
    spoolCapPct,
    windowsCount,
    warning,
    summaryLine,
    problemLine,
    nonSummaryLines,
    stderrLines,
    fingerprint,
  }
}

function toIsoString(now: Date): string {
  return now.toISOString()
}

export function buildFailureState(
  previousState: AutoCaptureAlertState,
  assessment: AutoCaptureAssessment,
  now: Date
): AutoCaptureAlertState {
  const next = createEmptyAutoCaptureAlertState()
  const fingerprint = assessment.fingerprint
  const isSameFailure = fingerprint !== null && previousState.activeFingerprint === fingerprint

  next.activeFingerprint = fingerprint
  next.firstFailedAt =
    isSameFailure && previousState.firstFailedAt ? previousState.firstFailedAt : toIsoString(now)
  next.lastAlertedAt = isSameFailure ? previousState.lastAlertedAt : null
  next.lastSuccessAt = previousState.lastSuccessAt
  next.lastProblemLine = assessment.problemLine
  next.lastSummaryLine = assessment.summaryLine
  next.lastExitCode = assessment.exitCode
  next.lastDeadLetterCount = assessment.deadLetterCount

  return next
}

export function buildSuccessState(
  previousState: AutoCaptureAlertState,
  now: Date
): AutoCaptureAlertState {
  return {
    activeFingerprint: null,
    firstFailedAt: null,
    lastAlertedAt: previousState.lastAlertedAt,
    lastSuccessAt: toIsoString(now),
    lastProblemLine: previousState.lastProblemLine,
    lastSummaryLine: previousState.lastSummaryLine,
    lastExitCode: previousState.lastExitCode,
    lastDeadLetterCount: previousState.lastDeadLetterCount,
  }
}

export function decideFailureAlert(
  previousState: AutoCaptureAlertState,
  assessment: AutoCaptureAssessment,
  now: Date,
  renotifyMs = DEFAULT_RENOTIFY_MS
): AutoCaptureFailureDecision {
  const baseState = buildFailureState(previousState, assessment, now)
  const fingerprint = assessment.fingerprint
  const lastAlertedAtMs = previousState.lastAlertedAt ? Date.parse(previousState.lastAlertedAt) : Number.NaN
  const isSameFailure = fingerprint !== null && previousState.activeFingerprint === fingerprint

  let send = false
  let reason: AutoCaptureFailureDecision['reason'] = 'suppressed'

  if (!isSameFailure || !previousState.lastAlertedAt) {
    send = true
    reason = 'new-fingerprint'
  } else if (!Number.isNaN(lastAlertedAtMs) && now.getTime() - lastAlertedAtMs >= renotifyMs) {
    send = true
    reason = 'renotify'
  }

  return {
    send,
    reason,
    baseState,
    alertedState: send ? { ...baseState, lastAlertedAt: toIsoString(now) } : baseState,
  }
}

export function formatAutoCaptureFailureMessage(input: {
  host: string
  now: Date
  firstFailedAt: string | null
  assessment: AutoCaptureAssessment
}): string {
  const { host, now, firstFailedAt, assessment } = input
  const lines = [
    '⚠️ CC-memory auto-capture alert',
    `host=${host}`,
    `time=${toIsoString(now)}`,
    `fingerprint=${assessment.fingerprint ?? 'unknown'}`,
    `first_failed_at=${firstFailedAt ?? toIsoString(now)}`,
    `exit=${assessment.exitCode}`,
    `dead_letter=${assessment.deadLetterCount}`,
  ]

  if (assessment.problemLine) lines.push(`problem=${assessment.problemLine}`)
  if (assessment.summaryLine) lines.push(`summary=${assessment.summaryLine}`)

  return lines.join('\n')
}

export function formatAutoCaptureRecoveryMessage(input: {
  host: string
  now: Date
  previousState: AutoCaptureAlertState
}): string {
  const { host, now, previousState } = input
  const lines = [
    '✅ CC-memory auto-capture recovered',
    `host=${host}`,
    `time=${toIsoString(now)}`,
    `recovered_from=${previousState.activeFingerprint ?? 'unknown'}`,
  ]

  if (previousState.firstFailedAt) lines.push(`first_failed_at=${previousState.firstFailedAt}`)
  if (previousState.lastAlertedAt) lines.push(`last_alerted_at=${previousState.lastAlertedAt}`)
  if (previousState.lastProblemLine) lines.push(`last_problem=${previousState.lastProblemLine}`)

  return lines.join('\n')
}

export const FALLBACK_SUCCESS_STREAK_THRESHOLD = 3

export interface AutoCaptureWarningDecision {
  send: boolean
  reasons: Array<'fallback-streak' | 'spool-cap-new-band'>
  /** @deprecated Use reasons[0] ?? 'none' — kept for backward compat */
  reason: 'fallback-streak' | 'spool-cap-new-band' | 'none'
  message: string | null
  /** State to persist BEFORE delivery attempt (streak incremented, but dedup timestamps unchanged) */
  updatedState: AutoCaptureAlertState
  /** State to persist AFTER confirmed delivery (dedup timestamps set). Same as updatedState when send=false. */
  deliveredState: AutoCaptureAlertState
}

/**
 * Decide whether to send a Telegram warning based on assessment.
 * Both conditions are evaluated independently:
 * - fallback-success > 0: increment streak; send when streak >= 3 consecutive ticks (dedup via renotify)
 * - spool capacity 70-89%: send once per band (dedup via spoolCapWarningBand)
 * Both reset their respective state when the condition clears.
 */
export function decideWarningAlert(
  previousState: AutoCaptureAlertState,
  assessment: AutoCaptureAssessment,
  host: string,
  now: Date,
  renotifyMs = DEFAULT_RENOTIFY_MS
): AutoCaptureWarningDecision {
  const updatedState = { ...previousState }
  const messages: string[] = []
  const reasons: Array<'fallback-streak' | 'spool-cap-new-band'> = []

  // Track which dedup fields should be stamped only after confirmed delivery
  let fallbackDeliveryTimestamp: string | null = null
  let capacityDeliveryBand: string | null = null

  // --- Fallback success streak (independent) ---
  if (assessment.fallbackSuccessCount > 0) {
    const prevStreak = previousState.fallbackSuccessStreak ?? 0
    updatedState.fallbackSuccessStreak = prevStreak + 1
    if (updatedState.fallbackSuccessStreak >= FALLBACK_SUCCESS_STREAK_THRESHOLD) {
      // Dedup: only send if never sent, or renotify interval elapsed, or streak was reset and crossed again
      const lastSentMs = previousState.fallbackWarningLastSentAt
        ? Date.parse(previousState.fallbackWarningLastSentAt)
        : Number.NaN
      const shouldSend =
        Number.isNaN(lastSentMs) || now.getTime() - lastSentMs >= renotifyMs
      if (shouldSend) {
        // Do NOT set fallbackWarningLastSentAt in updatedState — only in deliveredState
        fallbackDeliveryTimestamp = toIsoString(now)
        reasons.push('fallback-streak')
        messages.push(
          [
            '⚠️ CC-memory auto-capture warning',
            `host=${host}`,
            `time=${toIsoString(now)}`,
            `fallback-success streak=${updatedState.fallbackSuccessStreak}`,
            'codex may be logged out, falling back to haiku',
          ].join('\n')
        )
      }
    }
  } else {
    // Clear streak when no fallback-success
    updatedState.fallbackSuccessStreak = 0
    updatedState.fallbackWarningLastSentAt = null
  }

  // --- Spool capacity warning (independent, one-shot per band) ---
  if (assessment.spoolCapPct >= 70 && assessment.spoolCapPct < 90) {
    const band = '70-89'
    if (previousState.spoolCapWarningBand !== band) {
      // Do NOT set spoolCapWarningBand in updatedState — only in deliveredState
      capacityDeliveryBand = band
      reasons.push('spool-cap-new-band')
      messages.push(
        [
          '⚠️ CC-memory auto-capture warning',
          `host=${host}`,
          `time=${toIsoString(now)}`,
          `spool-cap-pct=${assessment.spoolCapPct} (approaching capacity)`,
        ].join('\n')
      )
    }
  } else if (assessment.spoolCapPct < 70) {
    // Clear spool cap band when below 70% (reset for next crossing)
    updatedState.spoolCapWarningBand = null
  }

  const send = reasons.length > 0

  // deliveredState: apply dedup timestamps that should only persist after confirmed send
  const deliveredState = { ...updatedState }
  if (fallbackDeliveryTimestamp) {
    deliveredState.fallbackWarningLastSentAt = fallbackDeliveryTimestamp
  }
  if (capacityDeliveryBand) {
    deliveredState.spoolCapWarningBand = capacityDeliveryBand
  }

  return {
    send,
    reasons,
    reason: reasons[0] ?? 'none',
    message: messages.length > 0 ? messages.join('\n---\n') : null,
    updatedState,
    deliveredState,
  }
}

function sanitizeAlertState(input: unknown): AutoCaptureAlertState {
  if (!input || typeof input !== 'object') return createEmptyAutoCaptureAlertState()
  const state = input as Partial<AutoCaptureAlertState>
  return {
    activeFingerprint: typeof state.activeFingerprint === 'string' ? state.activeFingerprint : null,
    firstFailedAt: typeof state.firstFailedAt === 'string' ? state.firstFailedAt : null,
    lastAlertedAt: typeof state.lastAlertedAt === 'string' ? state.lastAlertedAt : null,
    lastSuccessAt: typeof state.lastSuccessAt === 'string' ? state.lastSuccessAt : null,
    lastProblemLine: typeof state.lastProblemLine === 'string' ? state.lastProblemLine : null,
    lastSummaryLine: typeof state.lastSummaryLine === 'string' ? state.lastSummaryLine : null,
    lastExitCode: typeof state.lastExitCode === 'number' ? state.lastExitCode : null,
    lastDeadLetterCount:
      typeof state.lastDeadLetterCount === 'number' ? state.lastDeadLetterCount : null,
    recoveryFailureCount:
      typeof state.recoveryFailureCount === 'number' ? state.recoveryFailureCount : 0,
    fallbackSuccessStreak:
      typeof state.fallbackSuccessStreak === 'number' ? state.fallbackSuccessStreak : 0,
    spoolCapWarningBand:
      typeof state.spoolCapWarningBand === 'string' ? state.spoolCapWarningBand : null,
    fallbackWarningLastSentAt:
      typeof state.fallbackWarningLastSentAt === 'string' ? state.fallbackWarningLastSentAt : null,
  }
}

export async function loadAutoCaptureAlertState(filePath: string): Promise<AutoCaptureAlertState> {
  try {
    const content = await readFile(filePath, 'utf8')
    return sanitizeAlertState(JSON.parse(content))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyAutoCaptureAlertState()
    }
    return createEmptyAutoCaptureAlertState()
  }
}

export async function saveAutoCaptureAlertState(
  filePath: string,
  state: AutoCaptureAlertState
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function requireString(
  source: Record<string, string | undefined>,
  key: string,
  label: string
): string {
  const value = source[key]?.trim()
  if (!value) {
    throw new Error(`Missing ${label} (${key})`)
  }
  return value
}

export function resolveAutoCaptureAlertTarget(
  source: Record<string, string | undefined>
): AutoCaptureAlertTarget {
  const timeoutRaw = source.CC_MEMORY_ALERT_TIMEOUT_MS?.trim() ?? ''
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : DEFAULT_ALERT_TIMEOUT_MS

  return {
    botToken: requireString(source, 'CC_MEMORY_ALERT_BOT_TOKEN', 'memory alert bot token'),
    chatId: requireString(source, 'CC_MEMORY_ALERT_CHAT_ID', 'memory alert chat id'),
    apiBase: source.CC_MEMORY_ALERT_API_BASE?.trim() || DEFAULT_TELEGRAM_API_BASE,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_ALERT_TIMEOUT_MS,
  }
}

export const DEFAULT_ALERT_SEND_ATTEMPTS = 3
export const DEFAULT_ALERT_SEND_BACKOFF_MS: readonly number[] = [2_000, 4_000]

export interface TelegramSendOptions {
  /** 總嘗試次數（含第一次；預設 3） */
  attempts?: number
  /** 第 n 次失敗後等多久再試（預設 2 s、4 s；不足時沿用最後一個值） */
  backoffMs?: readonly number[]
  /** 測試注入用 */
  sleep?: (ms: number) => Promise<void>
}

class TelegramHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Telegram send failed: HTTP ${status} ${body}`.trim())
  }
}

// 哪些錯誤值得重試：網路層（undici 的 `fetch failed`）、逾時 abort、5xx、429。
// 4xx（token／chat id 錯）重試也不會好，直接拋。
function isRetryableTelegramError(error: unknown): boolean {
  if (error instanceof TelegramHttpError) return error.status === 429 || error.status >= 500
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    if (/fetch failed|aborted|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(error.message)) return true
  }
  return false
}

async function sendTelegramOnce(
  target: AutoCaptureAlertTarget,
  text: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), target.timeoutMs)

  try {
    const response = await fetchImpl(`${target.apiBase}/bot${target.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.chatId, text }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseText = await response.text()
      throw new TelegramHttpError(response.status, responseText)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 送 Telegram 告警，網路類失敗有界重試（T3，2026-09-03）：觀察窗內 8 次送不出全是本機到
 * api.telegram.org 的間歇性連線問題（同時段另一個 Telegram client 也記到 primary path unreachable），
 * 單次 10 s 逾時本身合理；預設最多 3 次、間隔 2 s／4 s，最壞約 36 s，仍遠小於 supervisor 的整體逾時。
 */
export async function sendAutoCaptureTelegramMessage(
  target: AutoCaptureAlertTarget,
  text: string,
  fetchImpl: typeof fetch = fetch,
  options: TelegramSendOptions = {}
): Promise<void> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ALERT_SEND_ATTEMPTS))
  const backoff = options.backoffMs ?? DEFAULT_ALERT_SEND_BACKOFF_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendTelegramOnce(target, text, fetchImpl)
      return
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isRetryableTelegramError(error)) throw error
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0
      await sleep(wait)
    }
  }
  throw lastError
}
