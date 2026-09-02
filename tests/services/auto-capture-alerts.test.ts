import { existsSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assessAutoCaptureExecution,
  createEmptyAutoCaptureAlertState,
  decideFailureAlert,
  decideWarningAlert,
  FALLBACK_SUCCESS_STREAK_THRESHOLD,
  loadAutoCaptureAlertState,
  parseSimpleEnvFile,
  resolveAutoCaptureAlertTarget,
  saveAutoCaptureAlertState,
  sendAutoCaptureTelegramMessage,
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

describe('assessAutoCaptureExecution new telemetry fields', () => {
  function makeSummary(fields: Record<string, string | number>): string {
    const base = 'processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=0'
    const extra = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    return `[cc-memory] auto-capture summary: ${base} ${extra}`
  }

  it('parses primary-provider, primary-success, fallback-success, fallback-failed, fatal, spool-bytes, spool-cap-pct, windows', () => {
    const summary = makeSummary({
      'primary-provider': 'codex-cli',
      'primary-success': 3,
      'fallback-success': 1,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 120000000,
      'spool-cap-pct': 23,
      'windows': 4,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(true)
    expect(result.primaryProvider).toBe('codex-cli')
    expect(result.primarySuccessCount).toBe(3)
    expect(result.fallbackSuccessCount).toBe(1)
    expect(result.fallbackFailedCount).toBe(0)
    expect(result.fatalCount).toBe(0)
    expect(result.spoolBytes).toBe(120000000)
    expect(result.spoolCapPct).toBe(23)
    expect(result.windowsCount).toBe(4)
    // fallback-success=1 now generates a warning (codex findings fix #1)
    expect(result.warning).toContain('fallback-success=1')
  })

  it('fallback-failed > 0 → unhealthy', () => {
    const summary = makeSummary({
      'primary-provider': 'codex-cli',
      'primary-success': 0,
      'fallback-success': 0,
      'fallback-failed': 1,
      'fatal': 0,
      'spool-bytes': 1000,
      'spool-cap-pct': 0,
      'windows': 1,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(false)
    expect(result.problemLine).toBe('fallback-failed=1')
  })

  it('fatal > 0 → unhealthy', () => {
    const summary = makeSummary({
      'primary-provider': 'codex-cli',
      'primary-success': 0,
      'fallback-success': 0,
      'fallback-failed': 0,
      'fatal': 1,
      'spool-bytes': 1000,
      'spool-cap-pct': 0,
      'windows': 0,
    })
    const result = assessAutoCaptureExecution({ exitCode: 1, stdout: summary, stderr: '' })
    expect(result.ok).toBe(false)
    expect(result.problemLine).toBe('fatal=1')
  })

  it('spool-cap-pct 70-89 → ok=true but warning', () => {
    const summary = makeSummary({
      'primary-provider': 'claude-cli',
      'primary-success': 1,
      'fallback-success': 0,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 360000000,
      'spool-cap-pct': 72,
      'windows': 1,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(true)
    expect(result.warning).toContain('spool-cap-pct=72')
    expect(result.warning).toContain('warning')
  })

  it('spool-cap-pct >= 90 → unhealthy', () => {
    const summary = makeSummary({
      'primary-provider': 'claude-cli',
      'primary-success': 0,
      'fallback-success': 0,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 470000000,
      'spool-cap-pct': 94,
      'windows': 0,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(false)
    expect(result.problemLine).toContain('spool-cap-pct=94')
  })

  it('spool-cap-pct > 100 early exit → unhealthy', () => {
    const summary = makeSummary({
      'primary-provider': 'claude-cli',
      'primary-success': 0,
      'fallback-success': 0,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 600000000,
      'spool-cap-pct': 115,
      'windows': 0,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(false)
    expect(result.problemLine).toContain('spool-cap-pct=115')
  })
})

describe('assessAutoCaptureExecution fallback-success warning', () => {
  function makeSummary(fields: Record<string, string | number>): string {
    const base = 'processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=0'
    const extra = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    return `[cc-memory] auto-capture summary: ${base} ${extra}`
  }

  it('fallback-success > 0 → ok=true but warning mentions codex', () => {
    const summary = makeSummary({
      'primary-provider': 'codex-cli',
      'primary-success': 0,
      'fallback-success': 2,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 1000,
      'spool-cap-pct': 10,
      'windows': 1,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(true)
    expect(result.warning).toContain('fallback-success=2')
    expect(result.warning).toContain('codex')
  })

  it('fallback-success=0 → no warning from fallback', () => {
    const summary = makeSummary({
      'primary-provider': 'codex-cli',
      'primary-success': 1,
      'fallback-success': 0,
      'fallback-failed': 0,
      'fatal': 0,
      'spool-bytes': 1000,
      'spool-cap-pct': 10,
      'windows': 1,
    })
    const result = assessAutoCaptureExecution({ exitCode: 0, stdout: summary, stderr: '' })
    expect(result.ok).toBe(true)
    expect(result.warning).toBe(null)
  })
})

describe('decideWarningAlert', () => {
  const host = 'test-host'
  const now = new Date('2026-01-15T10:00:00Z')

  function makeAssessment(overrides: Partial<ReturnType<typeof assessAutoCaptureExecution>>): ReturnType<typeof assessAutoCaptureExecution> {
    return {
      ok: true,
      exitCode: 0,
      deadLetterCount: 0,
      failedCount: 0,
      rateLimitedCount: 0,
      malformedCount: 0,
      blockedCount: 0,
      transcriptMissingCount: 0,
      parkedCount: 0,
      yieldedCount: 0,
      heldCount: 0,
      embeddingFailedCount: 0,
      primaryProvider: 'codex-cli',
      primarySuccessCount: 1,
      fallbackSuccessCount: 0,
      fallbackFailedCount: 0,
      fatalCount: 0,
      spoolBytes: 1000,
      spoolCapPct: 10,
      windowsCount: 1,
      warning: null,
      summaryLine: null,
      problemLine: null,
      nonSummaryLines: [],
      stderrLines: [],
      fingerprint: null,
      ...overrides,
    }
  }

  it('single tick fallback-success: increments streak but does NOT send', () => {
    const state = createEmptyAutoCaptureAlertState()
    const assessment = makeAssessment({ fallbackSuccessCount: 2, warning: 'fallback-success=2 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
    expect(result.updatedState.fallbackSuccessStreak).toBe(1)
  })

  it('streak reaches threshold: sends Telegram warning', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD - 1 }
    const assessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    expect(result.reason).toBe('fallback-streak')
    expect(result.message).toContain('codex')
    expect(result.message).toContain('haiku')
    expect(result.updatedState.fallbackSuccessStreak).toBe(FALLBACK_SUCCESS_STREAK_THRESHOLD)
  })

  it('streak resets when fallbackSuccessCount is 0', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), fallbackSuccessStreak: 2 }
    const assessment = makeAssessment({ fallbackSuccessCount: 0 })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
    expect(result.updatedState.fallbackSuccessStreak).toBe(0)
  })

  it('70% spool cap sends one-time warning', () => {
    const state = createEmptyAutoCaptureAlertState()
    const assessment = makeAssessment({ spoolCapPct: 75, warning: 'spool-cap-pct=75 (warning: approaching capacity)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    expect(result.reason).toBe('spool-cap-new-band')
    // Band is only set in deliveredState (post-confirmed-delivery), not updatedState
    expect(result.updatedState.spoolCapWarningBand).toBeFalsy()
    expect(result.deliveredState.spoolCapWarningBand).toBe('70-89')
  })

  it('same spool cap band → suppressed (dedup)', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), spoolCapWarningBand: '70-89' }
    const assessment = makeAssessment({ spoolCapPct: 80, warning: 'spool-cap-pct=80 (warning: approaching capacity)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
  })

  it('spool cap drops below 70 → band resets for next crossing', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), spoolCapWarningBand: '70-89' }
    const assessment = makeAssessment({ spoolCapPct: 60 })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
    expect(result.updatedState.spoolCapWarningBand).toBe(null)
  })

  it('streak past threshold is suppressed within renotify window (dedup)', () => {
    const sentAt = new Date(now.getTime() - 60_000).toISOString() // 1 min ago
    const state = {
      ...createEmptyAutoCaptureAlertState(),
      fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD,
      fallbackWarningLastSentAt: sentAt,
    }
    const assessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
    expect(result.updatedState.fallbackSuccessStreak).toBe(FALLBACK_SUCCESS_STREAK_THRESHOLD + 1)
    // lastSentAt unchanged
    expect(result.updatedState.fallbackWarningLastSentAt).toBe(sentAt)
  })

  it('streak past threshold re-notifies after renotify interval', () => {
    const sentAt = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString() // 7h ago
    const state = {
      ...createEmptyAutoCaptureAlertState(),
      fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD,
      fallbackWarningLastSentAt: sentAt,
    }
    const assessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    expect(result.reason).toBe('fallback-streak')
    // Timestamp only in deliveredState; updatedState keeps old value
    expect(result.updatedState.fallbackWarningLastSentAt).toBe(sentAt)
    expect(result.deliveredState.fallbackWarningLastSentAt).toBe(now.toISOString())
  })

  it('fallback streak + 72% spool → BOTH warnings delivered', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD - 1 }
    const assessment = makeAssessment({
      fallbackSuccessCount: 1,
      spoolCapPct: 72,
      warning: 'fallback-success=1 (codex may be logged out, falling back to haiku); spool-cap-pct=72 (warning: approaching capacity)',
    })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    expect(result.reasons).toContain('fallback-streak')
    expect(result.reasons).toContain('spool-cap-new-band')
    expect(result.message).toContain('codex')
    expect(result.message).toContain('spool-cap-pct=72')
    // Dedup state only in deliveredState
    expect(result.updatedState.spoolCapWarningBand).toBeFalsy()
    expect(result.deliveredState.spoolCapWarningBand).toBe('70-89')
    expect(result.updatedState.fallbackSuccessStreak).toBe(FALLBACK_SUCCESS_STREAK_THRESHOLD)
    expect(result.deliveredState.fallbackWarningLastSentAt).toBe(now.toISOString())
  })

  it('send=true: updatedState does NOT have dedup timestamps (pre-delivery)', () => {
    const state = { ...createEmptyAutoCaptureAlertState(), fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD - 1 }
    const assessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    // updatedState has no delivery timestamp — safe to persist on send failure
    expect(result.updatedState.fallbackWarningLastSentAt).toBeUndefined()
    // deliveredState has the timestamp — persist only on confirmed delivery
    expect(result.deliveredState.fallbackWarningLastSentAt).toBe(now.toISOString())
  })

  it('send failure → persist updatedState → next tick re-sends', () => {
    // Simulate: tick N sends, but Telegram fails → persist updatedState (no dedup stamp)
    const state = { ...createEmptyAutoCaptureAlertState(), fallbackSuccessStreak: FALLBACK_SUCCESS_STREAK_THRESHOLD - 1 }
    const assessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)

    // Simulate send failure: persist updatedState (no dedup timestamp)
    const stateAfterFailure = result.updatedState

    // Next tick: same assessment, using stateAfterFailure
    const nextNow = new Date(now.getTime() + 60_000) // 1 min later
    const nextAssessment = makeAssessment({ fallbackSuccessCount: 1, warning: 'fallback-success=1 (codex may be logged out, falling back to haiku)' })
    const nextResult = decideWarningAlert(stateAfterFailure, nextAssessment, host, nextNow)
    // Should re-send because no dedup timestamp was persisted
    expect(nextResult.send).toBe(true)
    expect(nextResult.reason).toBe('fallback-streak')
  })

  it('capacity send failure → next tick re-sends band warning', () => {
    const state = createEmptyAutoCaptureAlertState()
    const assessment = makeAssessment({ spoolCapPct: 75, warning: 'spool-cap-pct=75 (warning: approaching capacity)' })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(true)
    expect(result.reason).toBe('spool-cap-new-band')

    // Simulate send failure: persist updatedState (band NOT set)
    const stateAfterFailure = result.updatedState
    expect(stateAfterFailure.spoolCapWarningBand).toBeFalsy()

    // Next tick: same capacity, using stateAfterFailure
    const nextNow = new Date(now.getTime() + 60_000)
    const nextAssessment = makeAssessment({ spoolCapPct: 78, warning: 'spool-cap-pct=78 (warning: approaching capacity)' })
    const nextResult = decideWarningAlert(stateAfterFailure, nextAssessment, host, nextNow)
    // Should re-send because band was not committed
    expect(nextResult.send).toBe(true)
    expect(nextResult.reason).toBe('spool-cap-new-band')
  })

  it('streak resets also clears fallbackWarningLastSentAt', () => {
    const state = {
      ...createEmptyAutoCaptureAlertState(),
      fallbackSuccessStreak: 5,
      fallbackWarningLastSentAt: '2026-01-15T09:00:00.000Z',
    }
    const assessment = makeAssessment({ fallbackSuccessCount: 0 })
    const result = decideWarningAlert(state, assessment, host, now)
    expect(result.send).toBe(false)
    expect(result.updatedState.fallbackSuccessStreak).toBe(0)
    expect(result.updatedState.fallbackWarningLastSentAt).toBe(null)
  })
})

// T3（2026-09-03）：觀察窗內 8 次「alert failed: fetch failed／This operation was aborted」，同時段本機另一個
// Telegram client 也記到 api.telegram.org 暫時連不上——屬本機到 Telegram 的間歇性網路問題，不是程式邏輯。
// 修法：網路類錯誤（fetch failed／abort／5xx／429）有界重試；4xx（token／chat 錯）不重試。
describe('services/auto-capture-alerts sendAutoCaptureTelegramMessage retry', () => {
  const target = { botToken: 't', chatId: 'c', apiBase: 'https://api.telegram.test', timeoutMs: 50 }
  const okResponse = () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response

  it('retries transient fetch failures with backoff and succeeds', async () => {
    const calls: number[] = []
    const sleeps: number[] = []
    let n = 0
    const fetchImpl = (async () => {
      calls.push(++n)
      if (n < 3) throw new TypeError('fetch failed')
      return okResponse()
    }) as unknown as typeof fetch
    await sendAutoCaptureTelegramMessage(target, 'hello', fetchImpl, {
      attempts: 3,
      backoffMs: [100, 200],
      sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(calls).toEqual([1, 2, 3])
    expect(sleeps).toEqual([100, 200])
  })

  it('gives up after the configured attempts and rethrows the last error', async () => {
    let n = 0
    const fetchImpl = (async () => { n += 1; throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(sendAutoCaptureTelegramMessage(target, 'hello', fetchImpl, {
      attempts: 3, backoffMs: [0, 0], sleep: async () => {},
    })).rejects.toThrow('fetch failed')
    expect(n).toBe(3)
  })

  it('does not retry HTTP 4xx (bad token / chat id)', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return { ok: false, status: 401, text: async () => 'Unauthorized' } as unknown as Response
    }) as unknown as typeof fetch
    await expect(sendAutoCaptureTelegramMessage(target, 'hello', fetchImpl, {
      attempts: 3, backoffMs: [0, 0], sleep: async () => {},
    })).rejects.toThrow('HTTP 401')
    expect(n).toBe(1)
  })

  it('retries HTTP 5xx and 429', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      if (n === 1) return { ok: false, status: 502, text: async () => 'bad gateway' } as unknown as Response
      if (n === 2) return { ok: false, status: 429, text: async () => 'slow down' } as unknown as Response
      return okResponse()
    }) as unknown as typeof fetch
    await sendAutoCaptureTelegramMessage(target, 'hello', fetchImpl, {
      attempts: 3, backoffMs: [0, 0], sleep: async () => {},
    })
    expect(n).toBe(3)
  })

  it('retries when the per-attempt timeout aborts the request', async () => {
    let n = 0
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      n += 1
      if (n === 1) {
        init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
        return
      }
      resolve(okResponse())
    })) as unknown as typeof fetch
    await sendAutoCaptureTelegramMessage(target, 'hello', fetchImpl, {
      attempts: 2, backoffMs: [0], sleep: async () => {},
    })
    expect(n).toBe(2)
  })
})
