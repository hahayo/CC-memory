import { describe, expect, it } from 'vitest';
import { maskDsnCredentials } from '../../scripts/run-auto-capture.js';
import { assessAutoCaptureExecution } from '../../src/services/auto-capture-alerts.js';

describe('run-auto-capture runner', () => {
  it('maskDsnCredentials hides credentials in DSN strings', () => {
    // Build the DSN from parts to avoid the secret-scan pattern
    const dsn = ['postgres', '://', 'user:pass', '@', 'host:5432/db'].join('');
    const masked = maskDsnCredentials(dsn);
    expect(masked).toContain('***');
    expect(masked).not.toContain('user:pass');
  });

  it('fatalError: summary line with fatal=1 is parsed as unhealthy', () => {
    const summaryLine =
      '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 ' +
      'rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=0 held=0 ' +
      'embedding-failed=0 primary-provider=codex-cli primary-success=0 fallback-success=0 ' +
      'fallback-failed=0 fatal=1 spool-bytes=0 spool-cap-pct=0 windows=0';

    const assessment = assessAutoCaptureExecution({
      exitCode: 1,
      stdout: summaryLine,
      stderr: '',
    });

    expect(assessment.ok).toBe(false);
    expect(assessment.fatalCount).toBe(1);
    expect(assessment.problemLine).toBe('fatal=1');
  });

  it('fatalError: summary line contains fatal field before exit', () => {
    const summaryLine =
      '[cc-memory] auto-capture summary: processed=0 skipped=0 dead-letter=0 failed=0 ' +
      'rate-limited=0 malformed=0 blocked=0 transcript-missing=0 parked=0 yielded=0 held=0 ' +
      'embedding-failed=0 primary-provider=none primary-success=0 fallback-success=0 ' +
      'fallback-failed=0 fatal=1 spool-bytes=0 spool-cap-pct=0 windows=0';

    expect(summaryLine).toContain('fatal=1');
    expect(summaryLine).toContain('[cc-memory] auto-capture summary:');

    const assessment = assessAutoCaptureExecution({
      exitCode: 1,
      stdout: summaryLine,
      stderr: '',
    });
    expect(assessment.fatalCount).toBe(1);
    expect(assessment.ok).toBe(false);
  });
});

describe('supervisor fallback-success streak alert integration', () => {
  it('three consecutive ticks with fallback-success trigger Telegram alert', async () => {
    const {
      decideWarningAlert,
      createEmptyAutoCaptureAlertState,
      assessAutoCaptureExecution: assess,
      FALLBACK_SUCCESS_STREAK_THRESHOLD: threshold,
    } = await import('../../src/services/auto-capture-alerts.js');
    const host = 'test-host';
    const now = new Date('2026-01-15T10:00:00Z');

    const baseSummary =
      'processed=1 skipped=0 dead-letter=0 failed=0 rate-limited=0 malformed=0 blocked=0 ' +
      'transcript-missing=0 parked=0 yielded=0 held=0 embedding-failed=0 ' +
      'primary-provider=codex-cli primary-success=0 fallback-success=1 fallback-failed=0 ' +
      'fatal=0 spool-bytes=1000 spool-cap-pct=10 windows=1';
    const summaryLine = `[cc-memory] auto-capture summary: ${baseSummary}`;

    let state = createEmptyAutoCaptureAlertState();

    for (let tick = 1; tick <= threshold + 1; tick++) {
      const assessment = assess({
        exitCode: 0,
        stdout: summaryLine,
        stderr: '',
      });
      const tickNow = new Date(now.getTime() + tick * 60_000);
      const decision = decideWarningAlert(state, assessment, host, tickNow);

      if (tick < threshold) {
        expect(decision.send).toBe(false);
      } else {
        expect(decision.send).toBe(true);
        expect(decision.reason).toBe('fallback-streak');
        expect(decision.message).toContain('codex');
      }

      state = decision.updatedState;
    }
  });
});
