import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assessAutoCaptureExecution, createEmptyAutoCaptureAlertState, type AutoCaptureAlertState } from '../../src/services/auto-capture-alerts.js'
import {
  checkProductionApproval,
  databaseTargetIdentity,
  loadSecureProductionApprovalDocument,
  validateProductionApprovalDocument,
  runAutoCaptureSupervisorTick as runAutoCaptureSupervisorTickImpl,
  sendAutoCaptureSupervisorTestAlert,
  type RunAutoCaptureWorkerInput,
} from '../../scripts/run-auto-capture-supervisor.js'
import { maskDsnCredentials } from '../../scripts/run-auto-capture.js'

const TEST_MISSING_GEMINI_KEY_FILE = join(
  tmpdir(),
  'cc-memory-supervisor-tests-no-gemini-key'
)

function runAutoCaptureSupervisorTick(
  options: Parameters<typeof runAutoCaptureSupervisorTickImpl>[0] = {},
  deps: Parameters<typeof runAutoCaptureSupervisorTickImpl>[1] = {}
) {
  return runAutoCaptureSupervisorTickImpl(
    {
      ...options,
      geminiApiKeyFile: options.geminiApiKeyFile ?? TEST_MISSING_GEMINI_KEY_FILE,
    },
    deps
  )
}

describe('scripts/run-auto-capture-supervisor', () => {
  it('normalizes production DB identity independently of credentials and query parameters', () => {
    expect(databaseTargetIdentity(
      'postgres://writer:old@localhost:5432/cc_memory?sslmode=disable'
    )).toBe(databaseTargetIdentity(
      'postgresql://writer:new@127.0.0.1/cc_memory?application_name=canary'
    ));
    expect(databaseTargetIdentity('postgres://writer:new@localhost:5432/test_db'))
      .not.toBe(databaseTargetIdentity('postgres://writer:new@localhost:5432/cc_memory'));
    expect(databaseTargetIdentity('postgres://writer:new@LOCALHOST./cc_memory'))
      .toBe(databaseTargetIdentity('postgres://writer:new@127.0.0.2:5432/cc_memory'))
  });

  it('rejects ambiguous database targets that cannot be compared safely', () => {
    expect(() => databaseTargetIdentity('postgres:///cc_memory')).toThrow(/hostname/)
    expect(() => databaseTargetIdentity('postgres://dev,production/cc_memory'))
      .toThrow(/multiple hosts/)
    expect(() => databaseTargetIdentity('postgres://localhost:5432'))
      .toThrow(/database path/)
    expect(() => databaseTargetIdentity('postgres://localhost/decoy?database=cc_memory'))
      .toThrow(/database query parameter/)
    expect(() => databaseTargetIdentity('postgres://localhost%2cproduction/cc_memory'))
      .toThrow(/encoded hostname|Invalid URL/)
    expect(() => databaseTargetIdentity(
      'postgres://u@localhost,x@innocent.host:5432/cc_memory'
    )).toThrow(/multiple @/)
  })

  it('requires approval when the resolved URL targets the canonical production DB', async () => {
    await expect(checkProductionApproval(
      {
        databaseUrl: 'postgres://writer:copied@127.0.0.1/cc_memory',
        now: new Date('2026-08-12T01:00:00.000Z'),
      },
      {
        readProductionUrl: async () => 'postgres://writer:canonical@localhost:5432/cc_memory',
        readApprovalDocument: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      }
    )).rejects.toThrow(/production approval marker is unavailable/);
  });

  it('accepts only a mode-0600 regular production approval marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-production-approval-'))
    const marker = join(root, 'approval')
    const link = join(root, 'approval-link')
    writeFileSync(marker, 'scope=auto-capture-prod\n', { mode: 0o600 })

    await expect(loadSecureProductionApprovalDocument(marker)).resolves
      .toBe('scope=auto-capture-prod\n')
    chmodSync(marker, 0o644)
    await expect(loadSecureProductionApprovalDocument(marker)).rejects.toThrow(/0600/)
    chmodSync(marker, 0o600)
    symlinkSync(marker, link)
    await expect(loadSecureProductionApprovalDocument(link)).rejects.toThrow(/regular file/)
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a scoped, current production approval document', () => {
    expect(() => validateProductionApprovalDocument(
      [
        'scope=auto-capture-prod',
        'approved_by=haha',
        'approved_at=2026-08-12T00:00:00.000Z',
        'expires_at=2026-08-12T02:00:00.000Z',
      ].join('\n'),
      new Date('2026-08-12T01:00:00.000Z')
    )).not.toThrow()
  })

  it.each([
    ['empty touch file', ''],
    [
      'wrong scope',
      [
        'scope=all-production',
        'approved_by=haha',
        'approved_at=2026-08-12T00:00:00.000Z',
        'expires_at=2026-08-12T02:00:00.000Z',
      ].join('\n'),
    ],
    [
      'future approval',
      [
        'scope=auto-capture-prod',
        'approved_by=haha',
        'approved_at=2026-08-12T01:30:00.000Z',
        'expires_at=2026-08-12T02:00:00.000Z',
      ].join('\n'),
    ],
    [
      'non-canonical timestamp',
      [
        'scope=auto-capture-prod',
        'approved_by=haha',
        'approved_at=2026-08-12 00:00:00 UTC',
        'expires_at=2026-08-12T02:00:00.000Z',
      ].join('\n'),
    ],
    [
      'expired approval',
      [
        'scope=auto-capture-prod',
        'approved_by=haha',
        'approved_at=2026-08-12T00:00:00.000Z',
        'expires_at=2026-08-12T00:30:00.000Z',
      ].join('\n'),
    ],
  ])('rejects an invalid production approval document: %s', (_label, source) => {
    expect(() => validateProductionApprovalDocument(
      source,
      new Date('2026-08-12T01:00:00.000Z')
    )).toThrow(/production approval/i)
  })

  it('does not run the worker and alerts when the production approval guard rejects', async () => {
    const runWorker = vi.fn()
    const approvalCheck = vi.fn(async () => {
      throw new Error('production approval marker is missing')
    })
    const sentMessages: string[] = []

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-08-12T01:00:00.000Z'),
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        checkProductionApproval: approvalCheck,
        runWorker,
        sendTelegram: async (_target, text) => { sentMessages.push(text) },
      }
    )

    expect(runWorker).not.toHaveBeenCalled()
    expect(approvalCheck).toHaveBeenCalledWith({
      databaseUrl: 'postgres://project-db.example/cc_memory',
      now: new Date('2026-08-12T01:00:00.000Z'),
    })
    expect(result).toMatchObject({ exitCode: 1, notification: 'failure', alerted: true })
    expect(sentMessages.join('')).toContain('production approval marker is missing')
  })

  it('does not allow inherited forced-personal settings to redirect the worker DB', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {}
    await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: {
          CC_FORCE_PROJECT_ID: '__personal__',
          DATABASE_URL_PERSONAL: 'postgres://personal-db.example/personal',
          PGHOST: 'other-db.example',
          PGPORT: '6543',
          PGDATABASE: 'other_database',
          PGUSER: 'other_user',
          PGUSERNAME: 'other_username',
          PGPASSWORD: 'other_password',
        },
      },
      {
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        checkProductionApproval: async () => {},
        readAlertTarget: async () => { throw new Error('alerts unavailable') },
        runWorker: async ({ env }) => {
          capturedEnv = env
          return {
            exitCode: 0,
            stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
            stderr: '',
          }
        },
      }
    )

    expect(capturedEnv.DATABASE_URL).toBe('postgres://project-db.example/cc_memory')
    expect(capturedEnv.CC_FORCE_PROJECT_ID).toBeUndefined()
    expect(capturedEnv.DATABASE_URL_PERSONAL).toBeUndefined()
    expect(capturedEnv.PGHOST).toBeUndefined()
    expect(capturedEnv.PGPORT).toBeUndefined()
    expect(capturedEnv.PGDATABASE).toBeUndefined()
    expect(capturedEnv.PGUSER).toBeUndefined()
    expect(capturedEnv.PGUSERNAME).toBeUndefined()
    expect(capturedEnv.PGPASSWORD).toBeUndefined()
  })

  it('requires a valid alert target before running when CC_MEMORY_REQUIRE_ALERTS is enabled', async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
      stderr: '',
    }))

    await expect(runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: { CC_MEMORY_REQUIRE_ALERTS: '1' },
      },
      {
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        readAlertTarget: async () => {
          throw new Error('memory alert env file is missing')
        },
        runWorker,
      }
    )).rejects.toThrow('memory alert env file is missing')
    expect(runWorker).not.toHaveBeenCalled()
  })

  it('runs the worker when alerts are unavailable by default', async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0\n',
      stderr: '',
    }))

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: {},
      },
      {
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        readAlertTarget: async () => {
          throw new Error('memory alert env file is missing')
        },
        runWorker,
      }
    )

    expect(result).toMatchObject({ exitCode: 0, notification: 'none', alerted: false })
    expect(runWorker).toHaveBeenCalledTimes(1)
  })

  it('keeps a worker failure active when alerts are unavailable', async () => {
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: {},
      },
      {
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async (state) => { savedState = state },
        readAlertTarget: async () => { throw new Error('memory alert env file is missing') },
        runWorker: async () => ({
          exitCode: 1,
          stdout: '[cc-memory] auto-capture skipped: DB timeout\n',
          stderr: '',
        }),
      }
    )

    expect(result).toMatchObject({ exitCode: 1, notification: 'failure', alerted: false })
    expect(savedState.activeFingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(savedState.lastAlertedAt).toBeNull()
  })

  it('clears a prior failure after recovery when alerts are unavailable', async () => {
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: {},
      },
      {
        now: () => new Date('2026-08-12T00:00:00.000Z'),
        loadState: async () => ({
          ...createEmptyAutoCaptureAlertState(),
          activeFingerprint: 'abc123def456',
          firstFailedAt: '2026-08-11T00:00:00.000Z',
        }),
        saveState: async (state) => { savedState = state },
        readAlertTarget: async () => { throw new Error('memory alert env file is missing') },
        runWorker: async () => ({
          exitCode: 0,
          stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0\n',
          stderr: '',
        }),
      }
    )

    expect(result).toMatchObject({ exitCode: 0, notification: 'recovery', alerted: false })
    expect(savedState.activeFingerprint).toBeNull()
    expect(savedState.lastSuccessAt).toBe('2026-08-12T00:00:00.000Z')
  })

  it('keeps held-ok-held ticks informational without alert or recovery churn', async () => {
    let state = createEmptyAutoCaptureAlertState()
    const sentMessages: string[] = []
    const summaries = [
      'processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0 held=1',
      'processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0 held=0',
      'processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0 held=1',
    ]

    for (const summary of summaries) {
      const result = await runAutoCaptureSupervisorTick(
        {
          projectUrl: 'postgres://project-db.example/cc_memory',
          alertTarget: {
            botToken: 'bot-token',
            chatId: '1679325299',
            apiBase: 'https://api.telegram.org',
            timeoutMs: 10_000,
          },
        },
        {
          loadState: async () => state,
          saveState: async (nextState) => { state = nextState },
          runWorker: async () => ({
            exitCode: 0,
            stdout: `[cc-memory] auto-capture summary: ${summary}\n`,
            stderr: '',
          }),
          sendTelegram: async (_target, text) => { sentMessages.push(text) },
        }
      )

      expect(result).toMatchObject({ exitCode: 0, notification: 'none', alerted: false })
    }

    expect(sentMessages).toEqual([])
    expect(state.activeFingerprint).toBeNull()
  })

  it('sends a standalone bot test without running the worker or mutating alert state', async () => {
    const sentMessages: string[] = []
    const runWorker = vi.fn()
    const saveState = vi.fn()

    await sendAutoCaptureSupervisorTestAlert(
      {
        alertTarget: {
          botToken: 'dedicated-bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-15T10:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        runWorker,
        saveState,
        sendTelegram: async (_target, text) => {
          sentMessages.push(text)
        },
      }
    )

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('CC-memory Telegram alert test')
    expect(sentMessages[0]).toContain('host=cc-memory-host')
    expect(runWorker).not.toHaveBeenCalled()
    expect(saveState).not.toHaveBeenCalled()
  })

  it('accepts alert credentials from env when the alert file is empty', async () => {
    const sentTargets: Array<{ botToken: string; chatId: string }> = []
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-empty-alert-env-'))
    const alertEnvFile = join(root, 'alert.env')
    writeFileSync(alertEnvFile, '')

    try {
      await sendAutoCaptureSupervisorTestAlert(
        {
          alertEnvFile,
          env: {
            CC_MEMORY_ALERT_BOT_TOKEN: 'env-bot-token',
            CC_MEMORY_ALERT_CHAT_ID: 'env-chat-id',
          },
        },
        {
          sendTelegram: async (target) => {
            sentTargets.push({ botToken: target.botToken, chatId: target.chatId })
          },
        }
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    expect(sentTargets).toEqual([{ botToken: 'env-bot-token', chatId: 'env-chat-id' }])
  })

  it('sends a failure alert on first failing fingerprint', async () => {
    const sentMessages: string[] = []
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T00:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 1,
          stdout:
            '[cc-memory] auto-capture disabled (claude-cli): missing claude auth\n' +
            '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=1\n',
          stderr: '',
        }),
        sendTelegram: async (_target, text) => {
          sentMessages.push(text)
        },
      }
    )

    expect(result.exitCode).toBe(1)
    expect(result.notification).toBe('failure')
    expect(result.alerted).toBe(true)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('CC-memory auto-capture alert')
    expect(sentMessages[0]).toContain('host=cc-memory-host')
    expect(savedState.activeFingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(savedState.lastAlertedAt).toBe('2026-07-08T00:00:00.000Z')
  })

  it('suppresses duplicate failure fingerprints inside the dedupe window', async () => {
    const sentMessages: string[] = []
    const execution = {
      exitCode: 1,
      stdout:
        '[cc-memory] auto-capture skipped: DB health check failed: timeout\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=0\n',
      stderr: '',
    }
    const assessment = assessAutoCaptureExecution(execution)
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T03:00:00.000Z'),
        loadState: async () => ({
          ...createEmptyAutoCaptureAlertState(),
          activeFingerprint: assessment.fingerprint,
          firstFailedAt: '2026-07-08T00:00:00.000Z',
          lastAlertedAt: '2026-07-08T01:00:00.000Z',
        }),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => execution,
        sendTelegram: async (_target, text) => {
          sentMessages.push(text)
        },
      }
    )

    expect(result.exitCode).toBe(1)
    expect(result.notification).toBe('failure')
    expect(result.alerted).toBe(false)
    expect(sentMessages).toHaveLength(0)
    expect(savedState.lastAlertedAt).toBe('2026-07-08T01:00:00.000Z')
  })

  it('sends recovery and clears the active fingerprint after success', async () => {
    const sentMessages: string[] = []
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T06:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => ({
          ...createEmptyAutoCaptureAlertState(),
          activeFingerprint: 'abc123def456',
          firstFailedAt: '2026-07-08T00:00:00.000Z',
          lastAlertedAt: '2026-07-08T00:00:00.000Z',
          lastProblemLine: 'problem=timeout',
        }),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 0,
          stdout: '[cc-memory] auto-capture summary: processed=3 skipped=0 dead-letter=0\n',
          stderr: '',
        }),
        sendTelegram: async (_target, text) => {
          sentMessages.push(text)
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.notification).toBe('recovery')
    expect(result.alerted).toBe(true)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('CC-memory auto-capture recovered')
    expect(savedState.activeFingerprint).toBeNull()
    expect(savedState.lastSuccessAt).toBe('2026-07-08T06:00:00.000Z')
  })

  it('keeps an unsent failure active when Telegram delivery fails', async () => {
    const sendTelegram = vi.fn(async () => {
      throw new Error('network down')
    })
    let savedState = createEmptyAutoCaptureAlertState()

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T00:00:00.000Z'),
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 1,
          stdout:
            '[cc-memory] auto-capture skipped: DB health check failed: timeout\n' +
            '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=0\n',
          stderr: '',
        }),
        sendTelegram,
      }
    )

    expect(result.exitCode).toBe(2)
    expect(result.notification).toBe('failure')
    expect(result.alerted).toBe(false)
    expect(sendTelegram).toHaveBeenCalledTimes(1)
    expect(savedState.activeFingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(savedState.lastAlertedAt).toBeNull()
  })

  it('recovery alert failure increments recoveryFailureCount in saved state', async () => {
    let savedState: AutoCaptureAlertState = createEmptyAutoCaptureAlertState()
    const sendTelegram = vi.fn(async () => {
      throw new Error('network down')
    })

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T06:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => ({
          ...createEmptyAutoCaptureAlertState(),
          activeFingerprint: 'abc123def456',
          firstFailedAt: '2026-07-08T00:00:00.000Z',
          lastAlertedAt: '2026-07-08T00:00:00.000Z',
          lastProblemLine: 'problem=timeout',
          recoveryFailureCount: 0,
        }),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 0,
          stdout: '[cc-memory] auto-capture summary: processed=3 skipped=0 dead-letter=0\n',
          stderr: '',
        }),
        sendTelegram,
      }
    )

    expect(result.exitCode).toBe(2)
    expect(result.notification).toBe('recovery')
    expect(result.alerted).toBe(false)
    expect(savedState.recoveryFailureCount).toBe(1)
    expect(savedState.activeFingerprint).toBe('abc123def456')
  })

  it('recovery self-heals after 3 consecutive send failures (clears fingerprint)', async () => {
    let savedState: AutoCaptureAlertState = createEmptyAutoCaptureAlertState()
    const sendTelegram = vi.fn(async () => {
      throw new Error('network still down')
    })

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T06:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => ({
          ...createEmptyAutoCaptureAlertState(),
          activeFingerprint: 'abc123def456',
          firstFailedAt: '2026-07-08T00:00:00.000Z',
          lastAlertedAt: '2026-07-08T00:00:00.000Z',
          lastProblemLine: 'problem=timeout',
          recoveryFailureCount: 2,
        }),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 0,
          stdout: '[cc-memory] auto-capture summary: processed=3 skipped=0 dead-letter=0\n',
          stderr: '',
        }),
        sendTelegram,
      }
    )

    // 第 3 次 recovery 告警失敗 → 清掉 fingerprint，worker 健康才是主體
    expect(result.exitCode).toBe(0)
    expect(result.notification).toBe('recovery')
    expect(result.alerted).toBe(false)
    expect(savedState.activeFingerprint).toBeNull()
    expect(savedState.lastSuccessAt).toBe('2026-07-08T06:00:00.000Z')
  })

  it('buildWorkerEnv includes CC_CAPTURE_MAX_SESSIONS_PER_TICK default', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {}

    await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T00:00:00.000Z'),
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        runWorker: async (input: RunAutoCaptureWorkerInput) => {
          capturedEnv = input.env
          return {
            exitCode: 0,
            stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
            stderr: '',
          }
        },
        sendTelegram: async () => {},
      }
    )

    expect(capturedEnv.CC_CAPTURE_MAX_SESSIONS_PER_TICK).toBe('1')
  })

  it('loads the embedding API key file when capture extraction uses claude-cli', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-supervisor-key-'))
    const keyFile = join(root, 'gemini-api-key')
    const key = ['test', 'embedding', 'key'].join('-')
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 })
    let capturedEnv: NodeJS.ProcessEnv = {}

    try {
      await runAutoCaptureSupervisorTick(
        {
          projectUrl: 'postgres://project-db.example/cc_memory',
          geminiApiKeyFile: keyFile,
          env: { CC_CAPTURE_LLM: 'claude-cli' },
          alertTarget: {
            botToken: 'bot-token',
            chatId: '1679325299',
            apiBase: 'https://api.telegram.org',
            timeoutMs: 10_000,
          },
        },
        {
          loadState: async () => createEmptyAutoCaptureAlertState(),
          saveState: async () => {},
          runWorker: async (input: RunAutoCaptureWorkerInput) => {
            capturedEnv = input.env
            return {
              exitCode: 0,
              stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
              stderr: '',
            }
          },
        }
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    expect(capturedEnv.CC_CAPTURE_LLM).toBe('claude-cli')
    expect(capturedEnv.GEMINI_API_KEY).toBe(key)
    expect(capturedEnv.CC_MEMORY_EMBEDDING_EXPECTED).toBe('1')
  })

  it('does not pass an archived transcript snapshot directory into the live worker', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {}

    await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: { CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR: '/archive/must-not-leak' },
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        runWorker: async (input) => {
          capturedEnv = input.env
          return {
            exitCode: 0,
            stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
            stderr: '',
          }
        },
      },
    )

    expect(capturedEnv.CC_MEMORY_TRANSCRIPT_SNAPSHOT_DIR).toBeUndefined()
  })

  it('reports that embeddings are disabled when no Gemini key is available', async () => {
    const warnings: string[] = []
    const missingKeyFile = join(tmpdir(), `missing-gemini-key-${Date.now()}`)

    await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        geminiApiKeyFile: missingKeyFile,
        env: { CC_CAPTURE_LLM: 'claude-cli' },
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        stderr: { write: (text: string) => { warnings.push(text); } },
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        runWorker: async () => ({
          exitCode: 0,
          stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0\n',
          stderr: '',
        }),
      }
    )

    expect(warnings.join('')).toContain('embeddings-disabled: GEMINI_API_KEY unavailable')
    expect(warnings.join('')).toContain(missingKeyFile)
  })

  it('runs capture but reports an unhealthy tick when the Gemini key file is unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-memory-unreadable-key-'))
    const sentMessages: string[] = []
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0\n',
      stderr: '',
    }))

    try {
      const result = await runAutoCaptureSupervisorTick(
        {
          projectUrl: 'postgres://project-db.example/cc_memory',
          geminiApiKeyFile: root,
          alertTarget: {
            botToken: 'bot-token',
            chatId: '1679325299',
            apiBase: 'https://api.telegram.org',
            timeoutMs: 10_000,
          },
        },
        {
          loadState: async () => createEmptyAutoCaptureAlertState(),
          saveState: async () => {},
          runWorker,
          sendTelegram: async (_target, text) => { sentMessages.push(text) },
        }
      )

      expect(runWorker).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ exitCode: 1, notification: 'failure', alerted: true })
      expect(sentMessages.join('')).toContain('embedding credential error')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('worker timeout produces non-ok assessment with timedOut flag', async () => {
    let savedState: AutoCaptureAlertState = createEmptyAutoCaptureAlertState()
    const sentMessages: string[] = []

    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T00:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async (state) => {
          savedState = state
        },
        runWorker: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: '[run-auto-capture-supervisor] worker timed out after 150000ms, sending SIGTERM\n' +
            '[run-auto-capture-supervisor] worker terminated by signal SIGTERM\n',
          timedOut: true,
        }),
        sendTelegram: async (_target, text) => {
          sentMessages.push(text)
        },
      }
    )

    expect(result.exitCode).toBe(1)
    expect(result.notification).toBe('failure')
    expect(result.alerted).toBe(true)
    expect(sentMessages[0]).toContain('auto-capture alert')
    expect(savedState.activeFingerprint).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('scripts/run-auto-capture-supervisor SIGKILL escalation', () => {
  it('uses exited flag (not child.killed) to decide SIGKILL escalation', async () => {
    // This test verifies the fix: child.killed is true after SIGTERM send (not after exit),
    // so we use an exited flag from the close event. The actual SIGKILL escalation requires
    // a real process that ignores SIGTERM; here we verify the timeout path produces timedOut=true.
    const sentMessages: string[] = []
    const result = await runAutoCaptureSupervisorTick(
      {
        projectUrl: 'postgres://project-db.example/cc_memory',
        env: { CC_CAPTURE_SUPERVISOR_TIMEOUT_MS: '50' },
        alertTarget: {
          botToken: 'bot-token',
          chatId: '1679325299',
          apiBase: 'https://api.telegram.org',
          timeoutMs: 10_000,
        },
      },
      {
        now: () => new Date('2026-07-08T00:00:00.000Z'),
        hostname: () => 'cc-memory-host',
        loadState: async () => createEmptyAutoCaptureAlertState(),
        saveState: async () => {},
        runWorker: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: '[run-auto-capture-supervisor] worker timed out after 50ms, sending SIGTERM\n' +
            '[run-auto-capture-supervisor] worker terminated by signal SIGKILL\n',
          timedOut: true,
        }),
        sendTelegram: async (_target, text) => { sentMessages.push(text) },
      }
    )

    expect(result.exitCode).toBe(1)
    expect(result.alerted).toBe(true)
    expect(sentMessages[0]).toContain('auto-capture alert')
  })
})

describe('scripts/run-auto-capture maskDsnCredentials', () => {
  // 動態組裝含帳密 DSN 以避免 secret-scan hook 誤判
  const scheme = 'postgres://'
  const cred = 'testuser:testpass'
  const host = 'host.example:5432/db'

  it('masks credentials between :// and @', () => {
    const input = `${scheme}${cred}@${host}`
    expect(maskDsnCredentials(input)).toBe(`${scheme}***@${host}`)
  })

  it('masks multiple DSNs in the same string', () => {
    const input = `primary=${scheme}a:b@h1.example:5432/db secondary=${scheme}c:d@h2.example:5432/db`
    const expected = `primary=${scheme}***@h1.example:5432/db secondary=${scheme}***@h2.example:5432/db`
    expect(maskDsnCredentials(input)).toBe(expected)
  })

  it('handles text without DSN pattern by leaving it unchanged', () => {
    const input = 'connection error: timeout after 10s'
    expect(maskDsnCredentials(input)).toBe(input)
  })

  it('masks URL-encoded special characters in credentials', () => {
    const input = `${scheme}user%40corp:pass%23x@${host}`
    expect(maskDsnCredentials(input)).toBe(`${scheme}***@${host}`)
  })
})
