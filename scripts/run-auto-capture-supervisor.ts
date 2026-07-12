import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir, hostname as resolveHostname } from 'node:os'
import path from 'node:path'
import {
  assessAutoCaptureExecution,
  buildSuccessState,
  decideFailureAlert,
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
}

export interface AutoCaptureSupervisorOptions {
  repoRoot?: string
  env?: Record<string, string | undefined>
  projectUrl?: string
  projectUrlFile?: string
  alertTarget?: AutoCaptureAlertTarget
  alertEnvFile?: string
  stateFile?: string
  renotifyMs?: number
}

export interface AutoCaptureSupervisorTickResult {
  exitCode: number
  notification: 'none' | 'failure' | 'recovery'
  alerted: boolean
  state: AutoCaptureAlertState
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

async function resolveAlertTargetFromFile(
  options: AutoCaptureSupervisorOptions
): Promise<AutoCaptureAlertTarget> {
  if (options.alertTarget) return options.alertTarget

  const env = options.env ?? process.env
  const filePath = options.alertEnvFile ?? env.CC_MEMORY_ALERT_ENV_FILE ?? DEFAULT_ALERT_ENV_FILE
  const fileSource = parseSimpleEnvFile(await readTrimmedFile(filePath, 'memory alert env file'))
  const merged: Record<string, string | undefined> = { ...fileSource, ...env }
  return resolveAutoCaptureAlertTarget(merged)
}

async function maybeReadGeminiApiKey(env: Record<string, string | undefined>): Promise<string | undefined> {
  if ((env.CC_CAPTURE_LLM ?? '').trim() !== 'gemini-flash') return undefined
  if (env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY

  try {
    return await readTrimmedFile(DEFAULT_GEMINI_API_KEY_FILE, 'Gemini API key file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function buildWorkerEnv(
  envSource: Record<string, string | undefined>,
  databaseUrl: string
): Promise<NodeJS.ProcessEnv> {
  const nextEnv: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(envSource)) {
    if (value !== undefined) nextEnv[key] = value
  }

  nextEnv.DATABASE_URL = databaseUrl
  nextEnv.CC_MEMORY_SPOOL_DIR =
    nextEnv.CC_MEMORY_SPOOL_DIR ?? path.join(homedir(), '.cache', 'cc-memory', 'spool')
  nextEnv.CC_CAPTURE_LLM = nextEnv.CC_CAPTURE_LLM ?? 'claude-cli'
  nextEnv.CC_CAPTURE_CLAUDE_MODEL = nextEnv.CC_CAPTURE_CLAUDE_MODEL ?? 'haiku'
  nextEnv.CC_CAPTURE_MAX_SESSIONS_PER_TICK = nextEnv.CC_CAPTURE_MAX_SESSIONS_PER_TICK ?? '1'

  const geminiApiKey = await maybeReadGeminiApiKey(nextEnv)
  if (geminiApiKey) {
    nextEnv.GEMINI_API_KEY = geminiApiKey
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
  const previousState = await loadState()
  const databaseUrl = await resolveProjectUrl(options)
  const workerEnv = await buildWorkerEnv(env, databaseUrl)
  const runWorker = deps.runWorker ?? runAutoCaptureWorkerSubprocess
  const execution = await runWorker({ repoRoot, env: workerEnv })
  const assessment = assessAutoCaptureExecution(execution)

  if (assessment.ok) {
    const nextState = buildSuccessState(previousState, now)

    if (!previousState.activeFingerprint) {
      await saveState(nextState)
      return { exitCode: 0, notification: 'none', alerted: false, state: nextState }
    }

    const message = formatAutoCaptureRecoveryMessage({
      host: hostname,
      now,
      previousState,
    })

    try {
      const target = await readAlertTarget()
      await sendTelegram(target, message)
      await saveState(nextState)
      return { exitCode: 0, notification: 'recovery', alerted: true, state: nextState }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[run-auto-capture-supervisor] recovery alert failed: ${messageText}\n`)
      const prevCount = previousState.recoveryFailureCount ?? 0
      if (prevCount + 1 >= 3) {
        // 連續 3 次 recovery 發送失敗：告警是 best-effort，清掉 fingerprint 避免永久卡住
        process.stderr.write(
          `[run-auto-capture-supervisor] recovery alert failed 3 times consecutively, clearing failure state\n`
        )
        await saveState(nextState)
        return { exitCode: 0, notification: 'recovery', alerted: false, state: nextState }
      }
      const staleState: AutoCaptureAlertState = {
        ...previousState,
        recoveryFailureCount: prevCount + 1,
      }
      await saveState(staleState)
      return { exitCode: 2, notification: 'recovery', alerted: false, state: staleState }
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

  try {
    const target = await readAlertTarget()
    await sendTelegram(target, message)
    await saveState(decision.alertedState)
    return { exitCode: 1, notification: 'failure', alerted: true, state: decision.alertedState }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[run-auto-capture-supervisor] failure alert failed: ${messageText}\n`)
    await saveState(decision.baseState)
    return { exitCode: 2, notification: 'failure', alerted: false, state: decision.baseState }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') === 'run-auto-capture-supervisor'

if (isMain) {
  runAutoCaptureSupervisorTick()
    .then((result) => {
      process.exitCode = result.exitCode
    })
    .catch((error) => {
      console.error('[run-auto-capture-supervisor] failed:', error)
      process.exitCode = 2
    })
}
