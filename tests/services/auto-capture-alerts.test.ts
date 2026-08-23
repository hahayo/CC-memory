import { existsSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assessAutoCaptureExecution,
  createEmptyAutoCaptureAlertState,
  decideFailureAlert,
  loadAutoCaptureAlertState,
  parseSimpleEnvFile,
  resolveAutoCaptureAlertTarget,
  saveAutoCaptureAlertState,
} from '../../src/services/auto-capture-alerts.js'

describe('services/auto-capture-alerts assessAutoCaptureExecution', () => {
  it('treats summary-only success as healthy', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=2 skipped=0 dead-letter=0\n',
      stderr: '',
    })

    expect(assessment.ok).toBe(true)
    expect(assessment.deadLetterCount).toBe(0)
    expect(assessment.problemLine).toBeNull()
    expect(assessment.fingerprint).toBeNull()
  })

  it('treats yielded progress and retry holds as healthy, but parked chunks as alertable', () => {
    const yielded = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=1\n',
      stderr: '',
    })
    expect(yielded.ok).toBe(true)
    expect(yielded.yieldedCount).toBe(1)

    const parked = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=1 yielded=0\n',
      stderr: '',
    })
    expect(parked.ok).toBe(false)
    expect(parked.parkedCount).toBe(1)
    expect(parked.problemLine).toBe('parked=1')

    const held = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0 held=1\n',
      stderr: '',
    })
    expect(held.ok).toBe(true)
    expect(held.heldCount).toBe(1)
    expect(held.problemLine).toBeNull()
    expect(held.fingerprint).toBeNull()
  })

  it('treats blocked>0 as unhealthy', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=1 transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=0\n',
      stderr: '',
    })
    expect(assessment.ok).toBe(false)
    expect(assessment.blockedCount).toBe(1)
    expect(assessment.problemLine).toBe('blocked=1')
  })

  it('parses blocked=0 as healthy when other counts are also zero', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=0\n',
      stderr: '',
    })
    expect(assessment.ok).toBe(true)
    expect(assessment.blockedCount).toBe(0)
  })

  it('flags non-summary stdout and dead-letter as alertable', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout:
        '[cc-memory] auto-capture skipped: DB health check failed: timeout\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=2\n',
      stderr: '',
    })

    expect(assessment.ok).toBe(false)
    expect(assessment.deadLetterCount).toBe(2)
    expect(assessment.problemLine).toContain('DB health check failed')
    expect(assessment.fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  it('treats expected embedding failures as alertable while capture remains processed', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=2\n',
      stderr: '',
    })

    expect(assessment.ok).toBe(false)
    expect(assessment.embeddingFailedCount).toBe(2)
    expect(assessment.problemLine).toBe('embedding-failed=2')

    const withoutGenericFailedField = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=1 embedding-failed=2\n',
      stderr: '',
    })
    expect(withoutGenericFailedField.failedCount).toBe(0)
    expect(withoutGenericFailedField.embeddingFailedCount).toBe(2)
  })

  it('alerts on a sanitized first-attempt retry warning', () => {
    const assessment = assessAutoCaptureExecution({
      exitCode: 0,
      stdout:
        '[cc-memory] auto-capture warning: retry-pending session=session-1 source=0123456789ab:100-200 error=CLAUDE_CLI_TIMEOUT attempts=1/5\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=0 parked=0 yielded=0\n',
      stderr: '',
    })

    expect(assessment.ok).toBe(false)
    expect(assessment.problemLine).toContain('retry-pending')
    expect(assessment.problemLine).toContain('CLAUDE_CLI_TIMEOUT')
  })

  it('keeps summary-only transcript-missing informational but alerts on a sanitized source warning', () => {
    const informational = assessAutoCaptureExecution({
      exitCode: 0,
      stdout: '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=1 parked=0 yielded=0\n',
      stderr: '',
    })
    expect(informational.ok).toBe(true)
    expect(informational.transcriptMissingCount).toBe(1)

    const alertable = assessAutoCaptureExecution({
      exitCode: 0,
      stdout:
        '[cc-memory] auto-capture warning: transcript-source-unavailable session=session-1 source=0123456789ab:0-120 attempts=1/5\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 transcript-missing=1 parked=0 yielded=0\n',
      stderr: '',
    })
    expect(alertable.ok).toBe(false)
    expect(alertable.transcriptMissingCount).toBe(1)
    expect(alertable.problemLine).toContain('transcript-source-unavailable')
  })
})

describe('services/auto-capture-alerts parseSimpleEnvFile', () => {
  it('supports comments, export prefix, and quoted values', () => {
    const parsed = parseSimpleEnvFile(`
# comment
export CC_MEMORY_ALERT_BOT_TOKEN="token-123"
CC_MEMORY_ALERT_CHAT_ID='1679325299'
CC_MEMORY_ALERT_API_BASE=https://example.invalid
`)

    expect(parsed.CC_MEMORY_ALERT_BOT_TOKEN).toBe('token-123')
    expect(parsed.CC_MEMORY_ALERT_CHAT_ID).toBe('1679325299')
    expect(parsed.CC_MEMORY_ALERT_API_BASE).toBe('https://example.invalid')
  })
})

describe('services/auto-capture-alerts resolveAutoCaptureAlertTarget', () => {
  it('reads memory-specific Telegram config', () => {
    const target = resolveAutoCaptureAlertTarget({
      CC_MEMORY_ALERT_BOT_TOKEN: 'bot-token',
      CC_MEMORY_ALERT_CHAT_ID: 'chat-id',
      CC_MEMORY_ALERT_TIMEOUT_MS: '15000',
    })

    expect(target.botToken).toBe('bot-token')
    expect(target.chatId).toBe('chat-id')
    expect(target.timeoutMs).toBe(15_000)
  })
})

describe('services/auto-capture-alerts decideFailureAlert', () => {
  const assessment = assessAutoCaptureExecution({
    exitCode: 1,
    stdout:
      '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=1\n' +
      '[cc-memory] auto-capture disabled (claude-cli): missing claude auth\n',
    stderr: '',
  })

  it('alerts immediately on a new fingerprint', () => {
    const decision = decideFailureAlert(
      createEmptyAutoCaptureAlertState(),
      assessment,
      new Date('2026-07-08T00:00:00.000Z')
    )

    expect(decision.send).toBe(true)
    expect(decision.reason).toBe('new-fingerprint')
    expect(decision.alertedState.lastAlertedAt).toBe('2026-07-08T00:00:00.000Z')
  })

  it('suppresses identical fingerprints inside the dedupe window', () => {
    const previous = {
      ...createEmptyAutoCaptureAlertState(),
      activeFingerprint: assessment.fingerprint,
      firstFailedAt: '2026-07-08T00:00:00.000Z',
      lastAlertedAt: '2026-07-08T01:00:00.000Z',
    }

    const decision = decideFailureAlert(previous, assessment, new Date('2026-07-08T03:00:00.000Z'))

    expect(decision.send).toBe(false)
    expect(decision.reason).toBe('suppressed')
    expect(decision.baseState.lastAlertedAt).toBe('2026-07-08T01:00:00.000Z')
  })

  it('re-alerts identical fingerprints after six hours', () => {
    const previous = {
      ...createEmptyAutoCaptureAlertState(),
      activeFingerprint: assessment.fingerprint,
      firstFailedAt: '2026-07-08T00:00:00.000Z',
      lastAlertedAt: '2026-07-08T00:30:00.000Z',
    }

    const decision = decideFailureAlert(previous, assessment, new Date('2026-07-08T07:00:00.000Z'))

    expect(decision.send).toBe(true)
    expect(decision.reason).toBe('renotify')
    expect(decision.alertedState.lastAlertedAt).toBe('2026-07-08T07:00:00.000Z')
  })
})

describe('services/auto-capture-alerts fingerprint stability', () => {
  it('fingerprint does NOT include deadLetterCount (only exitCode + problemLine)', () => {
    // 相同 exitCode + problemLine，不同 deadLetterCount → fingerprint 相同
    const result1 = assessAutoCaptureExecution({
      exitCode: 1,
      stdout:
        '[cc-memory] auto-capture skipped: DB offline\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=2\n',
      stderr: '',
    })
    const result2 = assessAutoCaptureExecution({
      exitCode: 1,
      stdout:
        '[cc-memory] auto-capture skipped: DB offline\n' +
        '[cc-memory] auto-capture summary: processed=0 skipped=1 dead-letter=8\n',
      stderr: '',
    })

    expect(result1.fingerprint).toBe(result2.fingerprint)
    expect(result1.deadLetterCount).toBe(2)
    expect(result2.deadLetterCount).toBe(8)
  })

  it('different exitCode produces different fingerprint', () => {
    const result1 = assessAutoCaptureExecution({
      exitCode: 1,
      stdout: '[cc-memory] auto-capture skipped: DB offline\n',
      stderr: '',
    })
    const result2 = assessAutoCaptureExecution({
      exitCode: 2,
      stdout: '[cc-memory] auto-capture skipped: DB offline\n',
      stderr: '',
    })

    expect(result1.fingerprint).not.toBe(result2.fingerprint)
  })
})

describe('services/auto-capture-alerts saveAutoCaptureAlertState file mode', () => {
  it('creates state file with mode 0o600 and parent dir with mode 0o700', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-alert-state-'))
    const stateFile = join(dir, 'subdir', 'state.json')
    try {
      const state = createEmptyAutoCaptureAlertState()
      await saveAutoCaptureAlertState(stateFile, state)

      expect(existsSync(stateFile)).toBe(true)
      const fileStat = statSync(stateFile)
      // 0o600 = owner rw only
      expect(fileStat.mode & 0o777).toBe(0o600)

      const dirStat = statSync(join(dir, 'subdir'))
      // 0o700 = owner rwx only
      expect(dirStat.mode & 0o777).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadAutoCaptureAlertState tolerates missing recoveryFailureCount field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-alert-compat-'))
    const stateFile = join(dir, 'state.json')
    try {
      // 模擬舊格式 state 檔（無 recoveryFailureCount 欄位）
      const { writeFileSync: wf, mkdirSync: md } = await import('node:fs')
      md(dir, { recursive: true })
      wf(stateFile, JSON.stringify({
        activeFingerprint: 'abc123',
        firstFailedAt: '2026-07-08T00:00:00.000Z',
        lastAlertedAt: null,
        lastSuccessAt: null,
        lastProblemLine: null,
        lastSummaryLine: null,
        lastExitCode: 1,
        lastDeadLetterCount: 0,
      }))
      const loaded = await loadAutoCaptureAlertState(stateFile)
      expect(loaded.recoveryFailureCount).toBe(0)
      expect(loaded.activeFingerprint).toBe('abc123')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
