// src/services/tool-policy.ts
//
// Personal-Hub Phase 2 — read-only / allowlist / telemetry 開關的單一決策核心。
//
// 兩種獨立限制（各自雙層 enforce，見 src/index.ts）：
//   - read-only（CC_READ_ONLY）：限制「寫入類 tool」。assertWritable + ListTools 去寫入。
//   - allowlist（CC_TOOL_ALLOWLIST）：限制「集合外的任何 tool（含 read）」。assertAllowed + ListTools 過濾。
// 兩道檢查獨立：read-only 的 assertWritable 與 allowlist 的 assertAllowed 都走 central dispatch。
// CC_SEARCH_FEEDBACK：read-only instance 的 search telemetry 副作用開關（預設 on）。

import { ForbiddenError } from './errors.js';

export interface ToolPolicy {
  /** CC_READ_ONLY：寫入類 tool 一律拒 */
  readOnly: boolean;
  /** CC_TOOL_ALLOWLIST：非 null 時只允許集合內 tool（含 read）；null = 不額外限制 */
  allowlist: ReadonlySet<string> | null;
  /** CC_SEARCH_FEEDBACK：是否寫 search_feedback telemetry（預設 true） */
  searchFeedback: boolean;
}

/**
 * 寫入類 tool 集合（save/delete/task_create/task_update/set_reminder/snooze/reminders_due）。
 * cc_reminders_due 雖名為「撈」，但會「認領」到期提醒（寫 reminder_log + 推進 tasks），
 * 屬寫入——read-only 消費端不可呼叫，只有 poller（hermes 寫入端）能用。
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'cc_memory_save',
  'cc_memory_delete',
  'cc_task_create',
  'cc_task_update',
  'cc_task_set_reminder',
  'cc_task_snooze',
  'cc_reminders_due',
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

function isTruthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function isFalsy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false;
  return ['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

/**
 * 從 env 解析 ToolPolicy（mirror loadScopeConfig 啟動載入）。
 * - readOnly：CC_READ_ONLY truthy
 * - allowlist：CC_TOOL_ALLOWLIST 逗號分隔（trim、去空）；全空 → null
 * - searchFeedback：CC_SEARCH_FEEDBACK 預設 on，僅 off/0/false/no 關閉
 */
export function loadToolPolicy(
  env: Record<string, string | undefined> = process.env
): ToolPolicy {
  const allowEntries = (env.CC_TOOL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowlist = allowEntries.length > 0 ? new Set(allowEntries) : null;

  return {
    readOnly: isTruthy(env.CC_READ_ONLY),
    allowlist,
    searchFeedback: !isFalsy(env.CC_SEARCH_FEEDBACK), // 預設 on
  };
}

/** read-only instance 呼叫寫入 tool → 拒（只管寫入；read tool no-op）。 */
export function assertWritable(name: string, policy: ToolPolicy): void {
  if (policy.readOnly && isWriteTool(name)) {
    throw new ForbiddenError(`此 instance 為唯讀（CC_READ_ONLY），不允許寫入工具 "${name}"`, {
      tool: name,
    });
  }
}

/** allowlist 非空且 tool 不在集合 → 拒（含 read tool；與 read/write 無關）。 */
export function assertAllowed(name: string, policy: ToolPolicy): void {
  if (policy.allowlist !== null && !policy.allowlist.has(name)) {
    throw new ForbiddenError(`工具 "${name}" 不在此 instance 的 CC_TOOL_ALLOWLIST 內`, {
      tool: name,
    });
  }
}
