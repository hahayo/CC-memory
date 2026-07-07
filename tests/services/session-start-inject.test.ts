// tests/services/session-start-inject.test.ts
//
// v0.5 M4 4c — SessionStart 注入渲染核心（純 unit，不連 DB）。
// 鎖住：render 含污染防線 marker、每列吐輕索引欄位、不含 narrative 全文、
// rows 空回空字串；buildSessionStartOutput 空內容回 null、有內容為合法
// SessionStart hook protocol JSON。

import { describe, expect, it } from 'vitest';
import {
  INJECT_SOURCE_MARKER,
  buildSessionStartOutput,
  projectIdFromCwd,
  renderRecentActivityContext,
  resolveInjectTokenBudget,
  sanitizeSegmentBashMirror,
} from '../../src/services/session-start-inject.js';
import type {
  RecentActivityResult,
  RecentActivityRow,
} from '../../src/services/recent-activity.js';

function makeRow(overrides: Partial<RecentActivityRow> = {}): RecentActivityRow {
  return {
    id: 'mem-1',
    updatedAt: '2026-07-07T10:00:00.000Z',
    summaryExcerpt: 'did some capture work',
    observationIds: ['obs-1', 'obs-2'],
    observationCount: 2,
    discoveryTokens: 42,
    ...overrides,
  };
}

function makeResult(rows: RecentActivityRow[]): RecentActivityResult {
  return { source: 'cc-memory-inject', projectId: 'demo-project', rows };
}

describe('renderRecentActivityContext', () => {
  it('embeds the source=cc-memory-inject pollution marker', () => {
    const text = renderRecentActivityContext(makeResult([makeRow()]));
    expect(text).toContain(INJECT_SOURCE_MARKER);
    expect(text).toContain('source=cc-memory-inject');
  });

  it('renders id / updated_at / observation count / discovery_tokens / summary excerpt per row', () => {
    const text = renderRecentActivityContext(
      makeResult([
        makeRow({
          id: 'mem-xyz',
          updatedAt: '2026-07-07T11:22:33.000Z',
          observationCount: 3,
          discoveryTokens: 128,
          summaryExcerpt: 'excerpt text here',
        }),
      ])
    );
    expect(text).toContain('mem-xyz');
    expect(text).toContain('2026-07-07T11:22:33.000Z');
    expect(text).toContain('observations=3');
    expect(text).toContain('discovery_tokens=128');
    expect(text).toContain('excerpt text here');
  });

  it('does not include observation narrative full text', () => {
    // RecentActivityRow 本就不帶 narrative；render 只吐輕索引欄位，不得出現 narrative 標籤或全文。
    const text = renderRecentActivityContext(makeResult([makeRow(), makeRow({ id: 'mem-2' })]));
    expect(text).not.toContain('narrative');
  });

  it('returns empty string when rows are empty', () => {
    expect(renderRecentActivityContext(makeResult([]))).toBe('');
  });
});

describe('buildSessionStartOutput', () => {
  it('returns null when rendered context is empty', () => {
    expect(buildSessionStartOutput(makeResult([]))).toBeNull();
  });

  it('returns valid SessionStart hook protocol JSON when there is content', () => {
    const output = buildSessionStartOutput(makeResult([makeRow()]));
    expect(output).not.toBeNull();

    const parsed = JSON.parse(output as string) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('source=cc-memory-inject');
  });
});

describe('sanitizeSegmentBashMirror（bash sanitize_segment 逐字元 mirror，對審 P2）', () => {
  it('連續不安全字各自換底線，不塌縮（bash ${v//[^...]/_} 語義）', () => {
    expect(sanitizeSegmentBashMirror('我的專案')).toBe('____');
    expect(sanitizeSegmentBashMirror('my  project')).toBe('my__project');
    expect(sanitizeSegmentBashMirror('foo!!bar')).toBe('foo__bar');
  });

  it('安全字元原樣保留', () => {
    expect(sanitizeSegmentBashMirror('CC-memory')).toBe('CC-memory');
    expect(sanitizeSegmentBashMirror('a_b.c-d')).toBe('a_b.c-d');
  });

  it('前導點：全數剝除後補單一底線（bash while 迴圈語義）', () => {
    expect(sanitizeSegmentBashMirror('.hidden')).toBe('_hidden');
    expect(sanitizeSegmentBashMirror('..config')).toBe('_config');
    expect(sanitizeSegmentBashMirror('..')).toBe('_');
  });

  it('空字串 → unknown', () => {
    expect(sanitizeSegmentBashMirror('')).toBe('unknown');
  });
});

describe('projectIdFromCwd（cwd 處理逐步 mirror bash）', () => {
  it('取 basename 並 sanitize；只去單一尾斜線', () => {
    expect(projectIdFromCwd('/home/user/CC-memory')).toBe('CC-memory');
    expect(projectIdFromCwd('/home/user/我的專案')).toBe('____');
    expect(projectIdFromCwd('/home/user/proj/')).toBe('proj');
  });
});

describe('resolveInjectTokenBudget（CC_MEMORY_INJECT_TOKEN_BUDGET，對審 P2）', () => {
  it('未設/空 → undefined（builder 用預設）', () => {
    expect(resolveInjectTokenBudget({})).toBeUndefined();
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: '  ' })).toBeUndefined();
  });

  it('正整數字串 → 數值；小數取 floor', () => {
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: '800' })).toBe(800);
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: '99.7' })).toBe(99);
  });

  it('parse 失敗/非正數 → undefined（plan.md env 表：失敗用預設）', () => {
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: 'abc' })).toBeUndefined();
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: '-5' })).toBeUndefined();
    expect(resolveInjectTokenBudget({ CC_MEMORY_INJECT_TOKEN_BUDGET: '0' })).toBeUndefined();
  });
});
