import { describe, expect, it } from 'vitest';
import { maskDsnCredentials, formatSummaryLine, runAutoCaptureTick } from '../../scripts/run-auto-capture.js';
import { assessAutoCaptureExecution } from '../../src/services/auto-capture-alerts.js';
import type { CaptureWorkerResult } from '../../src/services/capture-worker.js';

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

describe('run-auto-capture formatSummaryLine', () => {
  it('formats fatal=1 correctly in summary line', () => {
    const result: CaptureWorkerResult = {
      processed: 0, skipped: 0, failed: 0, deadLettered: 0, rateLimited: 0,
      malformed: 0, blocked: 0, parked: 0, yielded: 0, held: 0, embeddingFailed: 0,
      transcriptMissing: 0, llmRetries: 0, observationsWritten: 0, rollupsWritten: 0,
      primaryProvider: 'codex-cli', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0,
      fatalError: 'test fatal error', spoolBytes: 0, spoolCapPct: 0, windows: 0,
    };
    const line = formatSummaryLine(result);
    expect(line).toContain('fatal=1');
    expect(line).toContain('[cc-memory] auto-capture summary:');

    // The summary line should be parsed as unhealthy by assessAutoCaptureExecution
    const assessment = assessAutoCaptureExecution({ exitCode: 1, stdout: line, stderr: '' });
    expect(assessment.ok).toBe(false);
    expect(assessment.fatalCount).toBe(1);
    expect(assessment.problemLine).toBe('fatal=1');
  });

  it('formats fatal=0 when no fatalError', () => {
    const result: CaptureWorkerResult = {
      processed: 1, skipped: 0, failed: 0, deadLettered: 0, rateLimited: 0,
      malformed: 0, blocked: 0, parked: 0, yielded: 0, held: 0, embeddingFailed: 0,
      transcriptMissing: 0, llmRetries: 0, observationsWritten: 0, rollupsWritten: 0,
      primaryProvider: 'claude-cli', primarySuccess: 1, fallbackSuccess: 0, fallbackFailed: 0,
      fatalError: null, spoolBytes: 1000, spoolCapPct: 10, windows: 1,
    };
    const line = formatSummaryLine(result);
    expect(line).toContain('fatal=0');
    const assessment = assessAutoCaptureExecution({ exitCode: 0, stdout: line, stderr: '' });
    expect(assessment.ok).toBe(true);
  });
});

describe('run-auto-capture fatal path via injectable runWorker', () => {
  it('runAutoCaptureTick with injected fatal worker prints fatal=1 summary and sets exitCode=1', async () => {
    const output: string[] = [];
    const fatalResult: CaptureWorkerResult = {
      processed: 0, skipped: 0, failed: 0, deadLettered: 0, rateLimited: 0,
      malformed: 0, blocked: 0, parked: 0, yielded: 0, held: 0, embeddingFailed: 0,
      transcriptMissing: 0, llmRetries: 0, observationsWritten: 0, rollupsWritten: 0,
      primaryProvider: 'none', primarySuccess: 0, fallbackSuccess: 0, fallbackFailed: 0,
      fatalError: 'injected fatal for test', spoolBytes: 0, spoolCapPct: 0, windows: 0,
    };

    // Save and restore process.exitCode
    const savedExitCode = process.exitCode;
    try {
      const result = await runAutoCaptureTick({
        runWorker: async () => fatalResult,
        stdout: { write: (chunk: string) => { output.push(chunk); return true; } },
      });
      expect(result.fatalError).toBe('injected fatal for test');
      expect(process.exitCode).toBe(1);

      // Verify summary line contains fatal=1
      const summaryOutput = output.find(line => line.includes('[cc-memory] auto-capture summary:'));
      expect(summaryOutput).toBeDefined();
      expect(summaryOutput).toContain('fatal=1');
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe('supervisor fallback-success streak alert integration', () => {
  it('three consecutive ticks trigger alert, fourth is suppressed (dedup)', async () => {
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
        // Below threshold: accumulating streak, no send
        expect(decision.send).toBe(false);
      } else if (tick === threshold) {
        // Exactly at threshold: first send
        expect(decision.send).toBe(true);
        expect(decision.reason).toBe('fallback-streak');
        expect(decision.message).toContain('codex');
      } else {
        // Past threshold, within renotify window: suppressed (dedup)
        expect(decision.send).toBe(false);
      }

      state = decision.updatedState;
    }
  });
});
