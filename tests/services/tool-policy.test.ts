// tests/services/tool-policy.test.ts
//
// Personal-Hub Phase 2a — tool policy 核心（read-only + allowlist + search telemetry 開關）。
//   - isWriteTool：寫入類 tool 判定
//   - loadToolPolicy：CC_READ_ONLY / CC_TOOL_ALLOWLIST / CC_SEARCH_FEEDBACK 解析
//   - assertWritable：read-only 擋寫入（只管寫入）
//   - assertAllowed：allowlist 非空且 tool 不在集合 → 擋（含 read tool）

import { describe, it, expect } from 'vitest';
import {
  isWriteTool,
  loadToolPolicy,
  assertWritable,
  assertAllowed,
  type ToolPolicy,
} from '../../src/services/tool-policy.js';
import { ForbiddenError } from '../../src/services/errors.js';

const OPEN_POLICY: ToolPolicy = { readOnly: false, allowlist: null, searchFeedback: true };

describe('tool-policy: isWriteTool', () => {
  const writeTools = [
    'cc_memory_save',
    'cc_memory_delete',
    'cc_task_create',
    'cc_task_update',
    'cc_task_set_reminder',
    'cc_task_snooze',
    'cc_reminders_due',
    'cc_todoist_add',
    'cc_todoist_complete',
  ];
  const readTools = [
    'cc_memory_search',
    'cc_memory_list',
    'cc_memory_get',
    'cc_memory_stats',
    'cc_task_list',
    'cc_task_stats',
    'cc_todoist_projects',
    'cc_todoist_list',
    'cc_todoist_completed',
  ];

  for (const t of writeTools) {
    it(`${t} is a write tool`, () => expect(isWriteTool(t)).toBe(true));
  }
  for (const t of readTools) {
    it(`${t} is NOT a write tool`, () => expect(isWriteTool(t)).toBe(false));
  }
});

describe('tool-policy: loadToolPolicy', () => {
  it('defaults: not read-only, no allowlist, searchFeedback on', () => {
    const p = loadToolPolicy({});
    expect(p.readOnly).toBe(false);
    expect(p.allowlist).toBeNull();
    expect(p.searchFeedback).toBe(true);
  });

  it('CC_READ_ONLY truthy variants enable read-only', () => {
    expect(loadToolPolicy({ CC_READ_ONLY: '1' }).readOnly).toBe(true);
    expect(loadToolPolicy({ CC_READ_ONLY: 'true' }).readOnly).toBe(true);
    expect(loadToolPolicy({ CC_READ_ONLY: 'ON' }).readOnly).toBe(true);
  });

  it('CC_READ_ONLY falsy variants keep read-only off', () => {
    expect(loadToolPolicy({ CC_READ_ONLY: '0' }).readOnly).toBe(false);
    expect(loadToolPolicy({ CC_READ_ONLY: 'false' }).readOnly).toBe(false);
    expect(loadToolPolicy({ CC_READ_ONLY: '' }).readOnly).toBe(false);
  });

  it('CC_TOOL_ALLOWLIST parses comma-separated, trims, drops empties', () => {
    const p = loadToolPolicy({ CC_TOOL_ALLOWLIST: 'cc_memory_search, cc_task_list ,' });
    expect(p.allowlist).not.toBeNull();
    expect(p.allowlist!.has('cc_memory_search')).toBe(true);
    expect(p.allowlist!.has('cc_task_list')).toBe(true);
    expect(p.allowlist!.size).toBe(2);
  });

  it('CC_TOOL_ALLOWLIST blank → null (no restriction)', () => {
    expect(loadToolPolicy({ CC_TOOL_ALLOWLIST: '' }).allowlist).toBeNull();
    expect(loadToolPolicy({ CC_TOOL_ALLOWLIST: '   ' }).allowlist).toBeNull();
  });

  it('CC_SEARCH_FEEDBACK off variants disable telemetry; default on', () => {
    expect(loadToolPolicy({ CC_SEARCH_FEEDBACK: 'off' }).searchFeedback).toBe(false);
    expect(loadToolPolicy({ CC_SEARCH_FEEDBACK: '0' }).searchFeedback).toBe(false);
    expect(loadToolPolicy({ CC_SEARCH_FEEDBACK: 'false' }).searchFeedback).toBe(false);
    expect(loadToolPolicy({ CC_SEARCH_FEEDBACK: 'on' }).searchFeedback).toBe(true);
    expect(loadToolPolicy({}).searchFeedback).toBe(true);
  });
});

describe('tool-policy: assertWritable (read-only 只管寫入)', () => {
  it('read-only + write tool → throws ForbiddenError', () => {
    expect(() => assertWritable('cc_memory_save', { ...OPEN_POLICY, readOnly: true })).toThrow(
      ForbiddenError
    );
  });

  it('read-only + read tool → ok', () => {
    expect(() => assertWritable('cc_memory_search', { ...OPEN_POLICY, readOnly: true })).not.toThrow();
  });

  it('not read-only + write tool → ok', () => {
    expect(() => assertWritable('cc_memory_save', OPEN_POLICY)).not.toThrow();
  });
});

describe('tool-policy: assertAllowed (allowlist 含 read)', () => {
  const allowlist = new Set(['cc_memory_search']);

  it('tool outside allowlist → throws ForbiddenError (even a read tool)', () => {
    expect(() => assertAllowed('cc_memory_get', { ...OPEN_POLICY, allowlist })).toThrow(ForbiddenError);
  });

  it('tool inside allowlist → ok', () => {
    expect(() => assertAllowed('cc_memory_search', { ...OPEN_POLICY, allowlist })).not.toThrow();
  });

  it('null allowlist → ok (no restriction)', () => {
    expect(() => assertAllowed('cc_memory_get', OPEN_POLICY)).not.toThrow();
  });
});
