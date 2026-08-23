import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, open, readFile } from 'node:fs/promises'
import { homedir, hostname as resolveHostname } from 'node:os'
import path from 'node:path'
import {
  assessAutoCaptureExecution,
  buildSuccessState,
  decideFailureAlert,
  decideWarningAlert,
  formatAutoCaptureFailureMessage,
  formatAutoCaptureRecoveryMessage,
  loadAutoCaptureAlertState,
  parseSimpleEnvFile,
  resolveAutoCaptureAlertTarget,
  saveAutoCaptureAlertState,
  sendAutoCaptureTelegramMessage,
  type AutoCaptureAlertState,
  type AutoCaptureAlertTarget,
  type AutoCaptureExecutionResult,
} from '../src/services/auto-capture-alerts.js'

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_PROJECT_URL_FILE = path.join(homedir(), '.ccm-project-url')
const DEFAULT_PRODUCTION_APPROVAL_FILE = path.join(
  homedir(),
  '.ccm-auto-capture-production-approved'
)
const DEFAULT_ALERT_ENV_FILE = path.join(homedir(), '.ccm-memory-alert.env')
const DEFAULT_ALERT_STATE_FILE = path.join(
  homedir(),
  '.local',
  'state',
  'cc-memory',
  'auto-capture-alert-state.json'
)
const DEFAULT_GEMINI_API_KEY_FILE = path.join(homedir(), '.gemini-api-key')

export interface RunAutoCaptureWorkerInput {
  repoRoot: string
  env: NodeJS.ProcessEnv
}

export interface AutoCaptureSupervisorDeps {
  now?: () => Date
  hostname?: () => string
  loadState?: () => Promise<AutoCaptureAlertState>
  saveState?: (state: AutoCaptureAlertState) => Promise<void>
  runWorker?: (input: RunAutoCaptureWorkerInput) => Promise<AutoCaptureExecutionResult>
  readAlertTarget?: () => Promise<AutoCaptureAlertTarget>
  sendTelegram?: (target: AutoCaptureAlertTarget, text: string) => Promise<void>
  checkProductionApproval?: (input: ProductionApprovalCheckInput) => Promise<void>
  stderr?: { write(text: string): unknown }
}

export interface ProductionApprovalCheckInput {
  databaseUrl: string
  now: Date
}

export interface ProductionApprovalCheckDeps {
  readProductionUrl?: () => Promise<string>
  readApprovalDocument?: () => Promise<string>
}

export interface AutoCaptureSupervisorOptions {
  repoRoot?: string
  env?: Record<string, string | undefined>
  projectUrl?: string
  projectUrlFile?: string
  alertTarget?: AutoCaptureAlertTarget
  alertEnvFile?: string
  geminiApiKeyFile?: string
  stateFile?: string
  renotifyMs?: number
}

export interface AutoCaptureSupervisorTickResult {
  exitCode: number
  notification: 'none' | 'failure' | 'recovery' | 'warning'
  alerted: boolean
  state: AutoCaptureAlertState
}

export async function sendAutoCaptureSupervisorTestAlert(
  options: AutoCaptureSupervisorOptions = {},
  deps: AutoCaptureSupervisorDeps = {}
): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const hostname = deps.hostname?.() ?? resolveHostname()
  const readAlertTarget = deps.readAlertTarget ?? (() => resolveAlertTargetFromFile(options))
  const sendTelegram = deps.sendTelegram ?? sendAutoCaptureTelegramMessage
  const target = await readAlertTarget()
  await sendTelegram(
    target,
    [
      'CC-memory Telegram alert test',
      `host=${hostname}`,
      `time=${now.toISOString()}`,
      'source=run-auto-capture-supervisor --test-alert',
    ].join('\n')
  )
}

async function readTrimmedFile(filePath: string, label: string): Promise<string> {
  const content = await readFile(filePath, 'utf8')
  const value = content.trim()
  if (!value) {
    throw new Error(`${label} is empty: ${filePath}`)
  }
  return value
}

async function resolveProjectUrl(options: AutoCaptureSupervisorOptions): Promise<string> {
  if (options.projectUrl) return options.projectUrl
  const env = options.env ?? process.env
  const filePath = options.projectUrlFile ?? env.CC_MEMORY_PROJECT_URL_FILE ?? DEFAULT_PROJECT_URL_FILE
  return readTrimmedFile(filePath, 'project database url file')
}

export function validateProductionApprovalDocument(source: string, now: Date): void {
  const values = parseSimpleEnvFile(source)
  if (values.scope !== 'auto-capture-prod') {
    throw new Error('production approval scope must be auto-capture-prod')
  }
  if (!values.approved_by?.trim()) {
    throw new Error('production approval approved_by is required')
  }

  const parseCanonicalIso = (value: string | undefined): number => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? '')) {
      return Number.NaN
    }
    const parsed = Date.parse(value!)
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? parsed
      : Number.NaN
  }

  const approvedAt = parseCanonicalIso(values.approved_at)
  if (!Number.isFinite(approvedAt)) {
    throw new Error('production approval approved_at must be an ISO timestamp')
  }
  if (approvedAt > now.getTime()) {
    throw new Error('production approval approved_at is in the future')
  }

  const expiresAt = parseCanonicalIso(values.expires_at)
  if (!Number.isFinite(expiresAt)) {
    throw new Error('production approval expires_at must be an ISO timestamp')
  }
  if (expiresAt <= now.getTime()) {
    throw new Error('production approval has expired')
  }
  if (expiresAt <= approvedAt) {
    throw new Error('production approval expires_at must be after approved_at')
  }
}

export function databaseTargetIdentity(databaseUrl: string): string {
  const rawAuthority = databaseUrl
    .slice(databaseUrl.indexOf('://') + 3)
    .split(/[/?#]/, 1)[0]
    ?? ''
  if (rawAuthority.split('@').length > 2) {
    throw new Error('project database url must not contain multiple @ delimiters')
  }
  const authority = rawAuthority.split('@').at(-1) ?? ''
  if (authority.includes('%')) {
    throw new Error('project database url must not contain an encoded hostname')
  }
  const parsed = new URL(databaseUrl)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('project database url must use postgres or postgresql')
  }
  const rawHostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!rawHostname) {
    throw new Error('project database url must include an explicit hostname')
  }
  if (rawHostname.includes(',')) {
    throw new Error('project database url must not contain multiple hosts')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('project database url must include an explicit database path')
  }
  if ([...parsed.searchParams.keys()].some((key) => key.toLowerCase() === 'database')) {
    throw new Error('project database url must not override the database query parameter')
  }
  const isLoopback =
    rawHostname === 'localhost' ||
    rawHostname === '[::1]' ||
    rawHostname === '::1' ||
    /^127\./.test(rawHostname) ||
    /^\[::ffff:7f[0-9a-f]{2}:/.test(rawHostname)
  const hostname = isLoopback
    ? 'loopback'
    : rawHostname
  const port = parsed.port || '5432'
  return `${hostname}:${port}${parsed.pathname}`
}

async function readSecureMode0600RegularFile(filePath: string, label: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`)
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file (symlinks are not accepted)`)
    }
    const mode = metadata.mode & 0o777
    if (mode !== 0o600) {
      throw new Error(
        `${label} must have mode 0600 (actual: ${mode.toString(8).padStart(4, '0')})`
      )
    }
    return handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export async function loadSecureProductionApprovalDocument(filePath: string): Promise<string> {
  return readSecureMode0600RegularFile(filePath, 'production approval marker')
}

export async function checkProductionApproval(
  input: ProductionApprovalCheckInput,
  deps: ProductionApprovalCheckDeps = {}
): Promise<void> {
  let productionUrl: string
  try {
    productionUrl = await (deps.readProductionUrl ?? (() =>
      readTrimmedFile(DEFAULT_PROJECT_URL_FILE, 'canonical production database url file')))()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`canonical production database identity is unavailable: ${message}`)
  }
  if (databaseTargetIdentity(input.databaseUrl) !== databaseTargetIdentity(productionUrl)) return

  let source: string
  try {
    source = await (deps.readApprovalDocument ?? (() =>
      loadSecureProductionApprovalDocument(DEFAULT_PRODUCTION_APPROVAL_FILE)))()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`production approval marker is unavailable: ${message}`)
  }
  validateProductionApprovalDocument(source, input.now)
}

async function resolveAlertTargetFromFile(
  options: AutoCaptureSupervisorOptions
): Promise<AutoCaptureAlertTarget> {
  if (options.alertTarget) return options.alertTarget

  const env = options.env ?? process.env
  const filePath = options.alertEnvFile ?? env.CC_MEMORY_ALERT_ENV_FILE ?? DEFAULT_ALERT_ENV_FILE
  let fileSource: Record<string, string> = {}
  try {
    fileSource = parseSimpleEnvFile(await readTrimmedFile(filePath, 'memory alert env file'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const canFallbackToEnv =
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      message.startsWith('memory alert env file is empty:')
    if (!canFallbackToEnv) throw error
    return resolveAutoCaptureAlertTarget(env)
  }
  const merged: Record<string, string | undefined> = { ...fileSource, ...env }
  return resolveAutoCaptureAlertTarget(merged)
}

async function maybeReadGeminiApiKey(
  env: Record<string, string | undefined>,
  keyFile = DEFAULT_GEMINI_API_KEY_FILE,
  onUnavailable?: (error: unknown) => void
): Promise<string | undefined> {
  if (env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY

  try {
    const value = (await readSecureMode0600RegularFile(keyFile, 'embedding key file')).trim()
    if (!value) {
      throw new Error(`Gemini API key file is empty: ${keyFile}`)
    }
    return value
  } catch (error) {
    onUnavailable?.(error)
    return undefined
  }
}

async function buildWorkerEnv(
  envSource: Record<string, string | undefined>,
  databaseUrl: string,
  geminiApiKeyFile?: string,
  onGeminiKeyUnavailable?: (error: unknown) => void
): Promise<NodeJS.ProcessEnv> {
  const nextEnv: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(envSource)) {
    if (value !== undefined) nextEnv[key] = value
  }

  nextEnv.DATABASE_URL = databaseUrl
  nextEnv.CC_MEMORY_SPOOL_DIR =
    nextEnv.CC_MEMORY_SPOOL_DIR ?? path.join(homedir(), '.cache', 'cc-memory', 'spool')
  // 刻意的安全預設，勿改：unit 沒指定時退回便宜且已驗證的 provider，
  // 避免漏設 env 的執行路徑直接打貴模型。provider 由 systemd unit 顯式指定。
  nextEnv.CC_CAPTURE_LLM = nextEnv.CC_CAPTURE_LLM ?? 'claude-cli'
  nextEnv.CC_CAPTURE_CLAUDE_MODEL = nextEnv.CC_CAPTURE_CLAUDE_MODEL ?? 'haiku'
  nextEnv.CC_CAPTURE_MAX_SESSIONS_PER_TICK = nextEnv.CC_CAPTURE_MAX_SESSIONS_PER_TICK ?? '1'
  delete nextEnv.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR
  delete nextEnv.CC_FORCE_PROJECT_ID
  delete nextEnv.DATABASE_URL_PERSONAL
  delete nextEnv.PGHOST
  delete nextEnv.PGPORT
  delete nextEnv.PGDATABASE
  delete nextEnv.PGUSER
  delete nextEnv.PGUSERNAME
  delete nextEnv.PGPASSWORD

  const geminiApiKey = await maybeReadGeminiApiKey(
    nextEnv,
    geminiApiKeyFile,
    onGeminiKeyUnavailable
  )
  if (geminiApiKey) {
    nextEnv.GEMINI_API_KEY = geminiApiKey
    nextEnv.CC_MEMORY_EMBEDDING_EXPECTED = '1'
  } else {
    delete nextEnv.CC_MEMORY_EMBEDDING_EXPECTED
  }

  return nextEnv
}

// Budget chain: claude per-call 75s × worst-case 2 calls (malformed retry) + DB/收尾餘裕
// → worker tick budget 240s < supervisor 270s < systemd 300s
const DEFAULT_SUPERVISOR_TIMEOUT_MS = 270_000
const SIGKILL_GRACE_MS = 5_000

function resolveSupervisorTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.CC_CAPTURE_SUPERVISOR_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SUPERVISOR_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUPERVISOR_TIMEOUT_MS
}

function requiresAlerts(env: Record<string, string | undefined>): boolean {
  return ['1', 'on', 'true'].includes((env.CC_MEMORY_REQUIRE_ALERTS ?? '').trim().toLowerCase())
}

export async function runAutoCaptureWorkerSubprocess(
  input: RunAutoCaptureWorkerInput
): Promise<AutoCaptureExecutionResult> {
  const tsxCli = path.join(input.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const workerScript = path.join(input.repoRoot, 'scripts', 'run-auto-capture.ts')
  await access(tsxCli)
  await access(workerScript)

  const timeoutMs = resolveSupervisorTimeoutMs(input.env as Record<string, string | undefined>)

  return new Promise<AutoCaptureExecutionResult>((resolve, reject) => {
    let timedOut = false
    let exited = false
    const child = spawn(process.execPath, [tsxCli, workerScript], {
      cwd: input.repoRoot,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const killTimer = setTimeout(() => {
      timedOut = true
      const timeoutLine = `[run-auto-capture-supervisor] worker timed out after ${timeoutMs}ms, sending SIGTERM\n`
      stderr += timeoutLine
      process.stderr.write(timeoutLine)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
      }, SIGKILL_GRACE_MS)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      exited = true
      clearTimeout(killTimer)
      if (signal) {
        const signalLine = `[run-auto-capture-supervisor] worker terminated by signal ${signal}\n`
        stderr += signalLine
        process.stderr.write(signalLine)
      }

      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

export async function runAutoCaptureSupervisorTick(
  options: AutoCaptureSupervisorOptions = {},
  deps: AutoCaptureSupervisorDeps = {}
): Promise<AutoCaptureSupervisorTickResult> {
  const env = options.env ?? process.env
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const now = deps.now?.() ?? new Date()
  const hostname = deps.hostname?.() ?? resolveHostname()
  const stateFile = options.stateFile ?? env.CC_MEMORY_ALERT_STATE_FILE ?? DEFAULT_ALERT_STATE_FILE
  const loadState = deps.loadState ?? (() => loadAutoCaptureAlertState(stateFile))
  const saveState = deps.saveState ?? ((state) => saveAutoCaptureAlertState(stateFile, state))
  const readAlertTarget = deps.readAlertTarget ?? (() => resolveAlertTargetFromFile(options))
  const sendTelegram = deps.sendTelegram ?? sendAutoCaptureTelegramMessage
  const stderr = deps.stderr ?? process.stderr
  let alertTarget: AutoCaptureAlertTarget | undefined
  try {
    alertTarget = await readAlertTarget()
  } catch (error) {
    if (requiresAlerts(env)) throw error
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`[run-auto-capture-supervisor] alerts-disabled: ${message}\n`)
  }
  const previousState = await loadState()
  const approvalCheck = deps.checkProductionApproval ?? checkProductionApproval
  const databaseUrl = await resolveProjectUrl(options)
  let productionApprovalError: unknown
  try {
    await approvalCheck({ databaseUrl, now })
  } catch (error) {
    productionApprovalError = error
  }

  let geminiKeyUnavailableError: unknown
  let execution: AutoCaptureExecutionResult
  if (productionApprovalError !== undefined) {
    const message = productionApprovalError instanceof Error
      ? productionApprovalError.message
      : String(productionApprovalError)
    const problemLine = `[run-auto-capture-supervisor] production-approval-denied: ${message}`
    stderr.write(`${problemLine}\n`)
    execution = { exitCode: 1, stdout: '', stderr: problemLine }
  } else {
    const workerEnv = await buildWorkerEnv(
      env,
      databaseUrl,
      options.geminiApiKeyFile,
      (error) => { geminiKeyUnavailableError = error }
    )
    if (!workerEnv.GEMINI_API_KEY?.trim()) {
      const reason = geminiKeyUnavailableError instanceof Error
        ? geminiKeyUnavailableError.message
        : geminiKeyUnavailableError === undefined
          ? undefined
          : String(geminiKeyUnavailableError)
      const detail = reason ? ` (${reason})` : ''
      stderr.write(
        `[run-auto-capture-supervisor] embeddings-disabled: GEMINI_API_KEY unavailable${detail}\n`
      )
    }
    const runWorker = deps.runWorker ?? runAutoCaptureWorkerSubprocess
    execution = await runWorker({ repoRoot, env: workerEnv })
  }
  const geminiKeyErrorCode = (geminiKeyUnavailableError as NodeJS.ErrnoException | undefined)?.code
  const hasEmbeddingCredentialError =
    geminiKeyUnavailableError !== undefined && geminiKeyErrorCode !== 'ENOENT'
  const assessedExecution = hasEmbeddingCredentialError
    ? {
        ...execution,
        exitCode: execution.exitCode === 0 ? 1 : execution.exitCode,
        stderr: [
          execution.stderr.trimEnd(),
          `[run-auto-capture-supervisor] embedding credential error: ${
            geminiKeyUnavailableError instanceof Error
              ? geminiKeyUnavailableError.message
              : String(geminiKeyUnavailableError)
          }`,
        ].filter(Boolean).join('\n'),
      }
    : execution
  const assessment = assessAutoCaptureExecution(assessedExecution)

  if (assessment.ok) {
    const nextState = buildSuccessState(previousState, now)

    // Process warnings (fallback-success streak, spool capacity) even on healthy ticks
    const warningDecision = decideWarningAlert(previousState, assessment, hostname, now)
    // Carry warning streak (incremented) into nextState; dedup timestamps only on confirmed delivery
    nextState.fallbackSuccessStreak = warningDecision.updatedState.fallbackSuccessStreak
    // Preserve pre-delivery state (no dedup stamps yet)
    nextState.spoolCapWarningBand = warningDecision.updatedState.spoolCapWarningBand
    nextState.fallbackWarningLastSentAt = warningDecision.updatedState.fallbackWarningLastSentAt
    let warningSent = false
    if (warningDecision.send && alertTarget && warningDecision.message) {
      try {
        await sendTelegram(alertTarget, warningDecision.message)
        warningSent = true
        // Only commit dedup timestamps after confirmed delivery
        nextState.spoolCapWarningBand = warningDecision.deliveredState.spoolCapWarningBand
        nextState.fallbackWarningLastSentAt = warningDecision.deliveredState.fallbackWarningLastSentAt
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        stderr.write(`[run-auto-capture-supervisor] warning alert failed: ${messageText}\n`)
        // Keep pre-delivery state — next tick will re-attempt the warning
      }
    }

    if (!previousState.activeFingerprint) {
      await saveState(nextState)
      // Return 'warning' notification when a warning was actually sent; recovery takes priority below
      const notification = warningSent ? 'warning' as const : 'none' as const
      return { exitCode: 0, notification, alerted: warningSent, state: nextState }
    }

    const message = formatAutoCaptureRecoveryMessage({
      host: hostname,
      now,
      previousState,
    })

    if (!alertTarget) {
      await saveState(nextState)
      return { exitCode: 0, notification: 'recovery', alerted: false, state: nextState }
    }

    try {
      await sendTelegram(alertTarget, message)
      await saveState(nextState)
      return { exitCode: 0, notification: 'recovery', alerted: true, state: nextState }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      stderr.write(`[run-auto-capture-supervisor] recovery alert failed: ${messageText}\n`)
      const prevCount = previousState.recoveryFailureCount ?? 0
      if (prevCount + 1 >= 3) {
        // 連續 3 次 recovery 發送失敗：告警是 best-effort，清掉 fingerprint 避免永久卡住
        stderr.write(
          `[run-auto-capture-supervisor] recovery alert failed 3 times consecutively, clearing failure state\n`
        )
        await saveState(nextState)
        return { exitCode: 0, notification: 'recovery', alerted: false, state: nextState }
      }
      // Preserve warning dedup state even when recovery fails (Finding 2)
      const staleState: AutoCaptureAlertState = {
        ...previousState,
        recoveryFailureCount: prevCount + 1,
        // Carry forward warning state from this tick
        fallbackSuccessStreak: nextState.fallbackSuccessStreak,
        spoolCapWarningBand: nextState.spoolCapWarningBand,
        fallbackWarningLastSentAt: nextState.fallbackWarningLastSentAt,
      }
      await saveState(staleState)
      return { exitCode: 2, notification: 'recovery', alerted: warningSent, state: staleState }
    }
  }

  const decision = decideFailureAlert(previousState, assessment, now, options.renotifyMs)

  if (!decision.send) {
    await saveState(decision.baseState)
    return { exitCode: 1, notification: 'failure', alerted: false, state: decision.baseState }
  }

  const message = formatAutoCaptureFailureMessage({
    host: hostname,
    now,
    firstFailedAt: decision.baseState.firstFailedAt,
    assessment,
  })

  if (!alertTarget) {
    await saveState(decision.baseState)
    return { exitCode: 1, notification: 'failure', alerted: false, state: decision.baseState }
  }

  try {
    await sendTelegram(alertTarget, message)
    await saveState(decision.alertedState)
    return { exitCode: 1, notification: 'failure', alerted: true, state: decision.alertedState }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    stderr.write(`[run-auto-capture-supervisor] failure alert failed: ${messageText}\n`)
    await saveState(decision.baseState)
    return { exitCode: 2, notification: 'failure', alerted: false, state: decision.baseState }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'run-auto-capture-supervisor'

if (isMain) {
  const operation = process.argv.includes('--test-alert')
    ? sendAutoCaptureSupervisorTestAlert().then(() => ({ exitCode: 0 }))
    : runAutoCaptureSupervisorTick()
  operation
    .then((result) => {
      process.exitCode = result.exitCode
    })
    .catch((error) => {
      console.error('[run-auto-capture-supervisor] failed:', error)
      process.exitCode = 2
    })
}
