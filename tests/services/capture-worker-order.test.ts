// tests/services/capture-worker-order.test.ts
//
// 2026-09-04 fresh-first：worker 每 tick 的 session 順序（純函式，不碰檔案／DB）。
//   - rotateSessionsAfterCursor：cursor 路徑消失（seal／rotate）時從「第一個排在 cursor 之後」接續，
//     不得從頭重來（8 月起後段專案餓死的根因）；
//   - orderSessionsForTick：fresh（mtime 在窗口內）新到舊排最前，stale 依 path 輪流；窗口 0 = 舊行為。

import { describe, expect, it } from 'vitest';
import {
  captureQuietPeriodMs,
  orderSessionsForTick,
  rotateSessionsAfterCursor,
  type SpoolSession,
} from '../../src/services/capture-worker.js';

function session(path: string, mtimeMs = 0): SpoolSession {
  return {
    projectDir: path.slice(0, path.lastIndexOf('/')),
    projectIdFromPath: 'p',
    sessionIdFromPath: path.slice(path.lastIndexOf('/') + 1, -6),
    path,
    mtimeMs,
  };
}

const SORTED = ['/s/a/1.jsonl', '/s/b/1.jsonl', '/s/c/1.jsonl', '/s/d/1.jsonl'].map((p) => session(p));
const paths = (list: SpoolSession[]): string[] => list.map((s) => s.path);

describe('rotateSessionsAfterCursor', () => {
  it('starts after the cursor when the cursor path is present', () => {
    expect(paths(rotateSessionsAfterCursor(SORTED, '/s/b/1.jsonl'))).toEqual([
      '/s/c/1.jsonl', '/s/d/1.jsonl', '/s/a/1.jsonl', '/s/b/1.jsonl',
    ]);
  });

  it('resumes after the vanished cursor position instead of restarting from the head', () => {
    // b 剛被 seal 改名：清單裡沒有 b，但必須從 c 接續，不是回到 a。
    const withoutB = SORTED.filter((s) => !s.path.includes('/b/'));
    expect(paths(rotateSessionsAfterCursor(withoutB, '/s/b/1.jsonl'))).toEqual([
      '/s/c/1.jsonl', '/s/d/1.jsonl', '/s/a/1.jsonl',
    ]);
  });

  it('wraps to the head when the vanished cursor was the last path, and stays put when it sorts first', () => {
    expect(paths(rotateSessionsAfterCursor(SORTED, '/s/z/1.jsonl'))).toEqual(paths(SORTED));
    expect(paths(rotateSessionsAfterCursor(SORTED, '/s/0/1.jsonl'))).toEqual(paths(SORTED));
  });

  it('is a no-op without a cursor or with a single session', () => {
    expect(paths(rotateSessionsAfterCursor(SORTED, null))).toEqual(paths(SORTED));
    expect(paths(rotateSessionsAfterCursor([SORTED[0]], '/s/z/1.jsonl'))).toEqual(['/s/a/1.jsonl']);
  });
});

describe('orderSessionsForTick', () => {
  const NOW = 1_000_000_000_000;
  const HOUR = 3_600_000;
  const list = [
    session('/s/a/1.jsonl', NOW - 100 * HOUR), // stale
    session('/s/b/1.jsonl', NOW - 2 * HOUR), // fresh
    session('/s/c/1.jsonl', NOW - 200 * HOUR), // stale
    session('/s/d/1.jsonl', NOW - 1 * HOUR), // fresh, newest
    session('/s/e/1.jsonl', NOW + 5 * HOUR), // 時鐘跳動：未來 mtime 也算 fresh、排最前
  ];

  it('puts fresh sessions first, newest to oldest, then stale sessions rotated after the cursor', () => {
    const { ordered, freshPaths } = orderSessionsForTick(list, '/s/a/1.jsonl', NOW, 72 * HOUR);
    expect(paths(ordered)).toEqual([
      '/s/e/1.jsonl', '/s/d/1.jsonl', '/s/b/1.jsonl', // fresh
      '/s/c/1.jsonl', '/s/a/1.jsonl', // stale, after cursor a
    ]);
    expect([...freshPaths].sort()).toEqual(['/s/b/1.jsonl', '/s/d/1.jsonl', '/s/e/1.jsonl']);
  });

  it('treats everything as stale (legacy path round-robin) when the fresh window is 0', () => {
    const { ordered, freshPaths } = orderSessionsForTick(list, '/s/c/1.jsonl', NOW, 0);
    expect(paths(ordered)).toEqual([
      '/s/d/1.jsonl', '/s/e/1.jsonl', '/s/a/1.jsonl', '/s/b/1.jsonl', '/s/c/1.jsonl',
    ]);
    expect(freshPaths.size).toBe(0);
  });

  it('breaks mtime ties by path so the order is deterministic', () => {
    const tie = [session('/s/y/1.jsonl', NOW), session('/s/x/1.jsonl', NOW)];
    expect(paths(orderSessionsForTick(tie, null, NOW, HOUR).ordered)).toEqual([
      '/s/x/1.jsonl', '/s/y/1.jsonl',
    ]);
  });

  it('holds sessions still active within the quiet period (including future mtimes) and keeps the rest', () => {
    // quiet=2h：d（1h 前）與 e（未來 mtime）還在聊 → 本 tick 不碰；b（剛好 2h）不算 quiet。
    const { ordered, freshPaths, quietHeld } = orderSessionsForTick(list, '/s/a/1.jsonl', NOW, 72 * HOUR, 2 * HOUR);
    expect(paths(quietHeld).sort()).toEqual(['/s/d/1.jsonl', '/s/e/1.jsonl']);
    expect(paths(ordered)).toEqual(['/s/b/1.jsonl', '/s/c/1.jsonl', '/s/a/1.jsonl']);
    expect([...freshPaths]).toEqual(['/s/b/1.jsonl']);
  });

  it('quiet period 0 (default) changes nothing', () => {
    const withDefault = orderSessionsForTick(list, '/s/a/1.jsonl', NOW, 72 * HOUR);
    const withZero = orderSessionsForTick(list, '/s/a/1.jsonl', NOW, 72 * HOUR, 0);
    expect(paths(withZero.ordered)).toEqual(paths(withDefault.ordered));
    expect(withDefault.quietHeld).toEqual([]);
    expect(withZero.quietHeld).toEqual([]);
  });

  it('quiet period does not touch the stale layer', () => {
    // quiet 比 fresh 窗口還長是設定錯誤，但不能把 stale 吃掉：a（100h）仍在 stale 層。
    const { ordered, quietHeld } = orderSessionsForTick(list, null, NOW, 72 * HOUR, 50 * HOUR);
    expect(paths(quietHeld).sort()).toEqual(['/s/b/1.jsonl', '/s/d/1.jsonl', '/s/e/1.jsonl']);
    expect(paths(ordered)).toEqual(['/s/a/1.jsonl', '/s/c/1.jsonl']);
  });
});

describe('captureQuietPeriodMs', () => {
  it('defaults to 0 (off) and honors CC_CAPTURE_QUIET_PERIOD_MS', () => {
    expect(captureQuietPeriodMs({})).toBe(0);
    expect(captureQuietPeriodMs({ CC_CAPTURE_QUIET_PERIOD_MS: '0' })).toBe(0);
    expect(captureQuietPeriodMs({ CC_CAPTURE_QUIET_PERIOD_MS: '7200000' })).toBe(7_200_000);
    expect(captureQuietPeriodMs({ CC_CAPTURE_QUIET_PERIOD_MS: 'abc' })).toBe(0);
    expect(captureQuietPeriodMs({ CC_CAPTURE_QUIET_PERIOD_MS: '-5' })).toBe(0);
  });
});
