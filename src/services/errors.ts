// src/services/errors.ts
//
// Service 層自訂錯誤。MCP handler / HTTP handler 會 map 成 McpError / HTTP 4xx。
// 全部從 BaseServiceError 繼承，確保 instanceof 判斷穩定。

export abstract class BaseServiceError extends Error {
  abstract readonly code: string;

  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * 狀態轉移違反規則（例如 tasks: done → in_progress 不合法）。
 */
export class InvalidTransitionError extends BaseServiceError {
  readonly code = 'INVALID_TRANSITION';
}

/**
 * 同 idempotency_key 但 payload 不一致（content_hash 不同）。
 * 非 silent 吞；callers 必須明確處理。
 */
export class IdempotencyConflictError extends BaseServiceError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/**
 * optimistic locking 失敗（UPDATE ... WHERE status=expected 影響 0 行）。
 */
export class StaleTaskError extends BaseServiceError {
  readonly code = 'CONFLICT';
}

/**
 * 指定 project_id 在 memories / tasks 皆查不到。
 */
export class ProjectNotFoundError extends BaseServiceError {
  readonly code = 'NOT_FOUND';
}

/**
 * 輸入參數違反契約（例如 task short-id prefix < 6）。
 */
export class InvalidArgumentError extends BaseServiceError {
  readonly code = 'INVALID_ARGUMENT';
}

/**
 * 查不到目標資源（例如 taskId / memoryId 不存在）。
 */
export class NotFoundError extends BaseServiceError {
  readonly code = 'NOT_FOUND';
}

/**
 * tool 在此 instance 被 policy 拒絕（read-only 擋寫入 / allowlist 排除）。對應 403。
 */
export class ForbiddenError extends BaseServiceError {
  readonly code = 'FORBIDDEN';
}

/**
 * short-id prefix 匹配多筆（需使用者提供更長 prefix 或完整 id）。
 * details.candidates 為前 5 筆（按 updated_at DESC）。
 */
export class AmbiguousShortIdError extends BaseServiceError {
  readonly code = 'AMBIGUOUS';
}

/**
 * 外部 API rate limit（Todoist 429）。details.retry_after = 秒數（可能 null）。
 * 與 INTERNAL 區隔，讓 poller / agent 能識別「稍後重試」而非真錯誤。
 */
export class RateLimitError extends BaseServiceError {
  readonly code = 'RATE_LIMIT';
}

/**
 * Todoist API 非 2xx（429 以外）/ 逾時 / 傳輸層錯誤的統一包裝。
 * code 依 HTTP status 映射到 McpError 既有碼（400→INVALID_ARGUMENT、401/403→FORBIDDEN、
 * 404→NOT_FOUND、其餘→INTERNAL），details 帶 error_tag / http_code 供除錯。
 */
export class TodoistApiError extends BaseServiceError {
  readonly code: string;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/**
 * postgres-js unique violation 偵測。舊版 drizzle-orm 直接拋出 driver error；
 * 新版會用 DrizzleQueryError 包裝並把原始 PostgresError 放在 `.cause`。
 * 原生 PostgresError 有 `.code` (sqlstate) + `.constraint_name`。
 * @param err - 抓到的錯誤
 * @param constraint - 可選；指定 constraint name 時只配對該 constraint，
 *                     不指定則任何 23505 都算 true
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current = err;
  const seen = new Set<object>();

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (candidate.code === '23505') {
      if (
        constraint &&
        candidate.constraint_name &&
        candidate.constraint_name !== constraint
      ) {
        return false;
      }
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
