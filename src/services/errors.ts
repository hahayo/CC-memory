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
 * short-id prefix 匹配多筆（需使用者提供更長 prefix 或完整 id）。
 * details.candidates 為前 5 筆（按 updated_at DESC）。
 */
export class AmbiguousShortIdError extends BaseServiceError {
  readonly code = 'AMBIGUOUS';
}

/**
 * postgres-js unique violation 偵測。drizzle-orm 對 postgres-js driver 不包裝錯誤，
 * 原生 PostgresError 有 `.code` (sqlstate) + `.constraint_name`。
 * @param err - 抓到的錯誤
 * @param constraint - 可選；指定 constraint name 時只配對該 constraint，
 *                     不指定則任何 23505 都算 true
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint_name?: string };
  if (e.code !== '23505') return false;
  if (constraint && e.constraint_name && e.constraint_name !== constraint) return false;
  return true;
}
