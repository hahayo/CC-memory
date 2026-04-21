// src/services/tasks.ts
//
// Stage 1 Track T：task service 全部方法。
//
// Exports：
//   - createTask(db, input)
//   - listTasks(db, input)
//   - getTask(db, id)
//   - updateTask(db, id, patch, options) — optimistic locking + 狀態轉移
//   - resolveTaskByShortId(db, prefix, projectId)
//
// 設計重點：
//   1. writer_host 由 resolveWriterHost() 預設填；caller 可明示覆蓋。
//   2. listTasks 預設排除 cancelled；若 input.status 明示含 cancelled 則顯示。
//   3. updateTask：先 SELECT → 檢查 expectedStatus → 驗狀態矩陣 → UPDATE ... WHERE id=? AND status=?
//      WHERE 子句的 status 作為第二道 race-condition 防線（affected=0 → StaleTaskError）。
//   4. completed_at 副作用：→ done 時 set now()；done → open 時 clear。
//   5. resolveTaskByShortId：prefix < 6 → InvalidArgumentError；0/1/many → tagged union。
//
// 狀態轉移矩陣（table-driven）：
//     open         → in_progress / done / cancelled        ✅
//     in_progress  → done / cancelled                      ✅（不退回 open）
//     done         → open                                  ✅（清 completed_at）
//     cancelled    → open                                  ✅
//     其餘組合                                              ❌ InvalidTransitionError
//     同 status（no-op）                                    ✅（不驗矩陣，走其他欄位 update）

import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { tasks, type Task } from '../db/schema.js';
import type {
  DbClient,
  CreateTaskInput,
  ListTasksInput,
  UpdateTaskPatch,
  UpdateTaskOptions,
  TaskStatus,
  ResolveShortIdResult,
} from './types.js';
import {
  InvalidTransitionError,
  StaleTaskError,
  NotFoundError,
  InvalidArgumentError,
  IdempotencyConflictError,
  isUniqueViolation,
} from './errors.js';
import { resolveWriterHost } from '../utils/writer-host.js';

// ---------------------------------------------------------------------------
// 狀態轉移矩陣（table-driven）
// ---------------------------------------------------------------------------

const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
};

function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // 同 status 視為 no-op，其他欄位仍可更新
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

const TITLE_MIN_LENGTH = 1;
const TITLE_MAX_LENGTH = 500;

const VALID_STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'done',
  'cancelled',
];
const VALID_PRIORITIES = ['low', 'normal', 'high'] as const;
const VALID_SOURCES = ['manual', 'telegram', 'claude-code', 'codex', 'mcp'] as const;

function validateTitle(title: string): void {
  // DB CHECK 最終防線；service 層先擋避免 INTERNAL 變成 protocol error
  if (typeof title !== 'string' || title.length < TITLE_MIN_LENGTH) {
    throw new InvalidArgumentError(`task title 不可空（至少 ${TITLE_MIN_LENGTH} 字）`, {
      titleLength: typeof title === 'string' ? title.length : 'not-string',
    });
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new InvalidArgumentError(
      `task title 超過長度上限（${TITLE_MAX_LENGTH} 字）`,
      { titleLength: title.length, max: TITLE_MAX_LENGTH }
    );
  }
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `${field} 必須為 ${allowed.join(' | ')}`,
      { field, value, allowed: [...allowed] }
    );
  }
  return value as T;
}

/**
 * normalize idempotency_key：空字串 / 只含空白 → undefined（不進冪等流程）。
 * 防止 client 把 '' 當 key 造成首次 create 成功後永久污染 tasks_idempotency_key_unique
 * （codex review round 9 P2）。
 */
function normalizeIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function createTask(db: DbClient, input: CreateTaskInput): Promise<Task> {
  validateTitle(input.title);
  // enum 驗證：以明示傳入為準；fallback default 不必驗
  const status = input.status === undefined ? 'open' : validateEnum(input.status, VALID_STATUSES, 'status');
  const priority =
    input.priority === undefined ? 'normal' : validateEnum(input.priority, VALID_PRIORITIES, 'priority');
  const source =
    input.source === undefined ? 'manual' : validateEnum(input.source, VALID_SOURCES, 'source');
  const normalizedKey = normalizeIdempotencyKey(input.idempotencyKey);
  const writerHost = input.writerHost ?? resolveWriterHost();

  const row = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    title: input.title,
    description: input.description,
    status,
    priority,
    dueDate: input.dueDate,
    tags: input.tags ?? [],
    source,
    sourceRef: input.sourceRef,
    idempotencyKey: normalizedKey,
    writerHost,
    metadata: input.metadata ?? {},
    // 建立時若 status 已是 'done'，需設 completed_at = now()，
    // 否則稽核 / reopen 邏輯會把這筆當「未完成」（對齊 updateTask 的副作用）
    ...(status === 'done' ? { completedAt: new Date() } : {}),
  };

  // tasks 的 idempotency_key 是 hard unique（無 content_hash），因此重複 key
  // 全部視為 IdempotencyConflictError（不像 memory 有「同 payload 回舊 id」分支）。
  // 這樣 MCP/HTTP caller 能收到明確的 protocol-level error，而非 INTERNAL。
  try {
    const [inserted] = await db.insert(tasks).values(row).returning();
    return inserted as Task;
  } catch (err) {
    if (normalizedKey && isUniqueViolation(err, 'tasks_idempotency_key_unique')) {
      throw new IdempotencyConflictError(
        'Task with this idempotency_key already exists',
        { idempotencyKey: normalizedKey }
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------

export async function listTasks(db: DbClient, input: ListTasksInput): Promise<Task[]> {
  const { projectId, status, limit = 20, offset = 0 } = input;

  const conditions = [eq(tasks.projectId, projectId)];

  if (status === undefined) {
    // 預設：排除 cancelled
    conditions.push(sql`${tasks.status} <> 'cancelled'`);
  } else if (Array.isArray(status)) {
    // 空陣列視為「沒指定過濾」→ 套預設（排除 cancelled），避免 drizzle
    // inArray 產出 `IN ()` 這種無效 SQL 變 INTERNAL（codex review round 14 P2）。
    if (status.length === 0) {
      conditions.push(sql`${tasks.status} <> 'cancelled'`);
    } else {
      // 同步驗 enum，壞值早拋 InvalidArgumentError（不靠 DB CHECK）
      for (const s of status) validateEnum(s, VALID_STATUSES, 'status');
      conditions.push(inArray(tasks.status, status));
    }
  } else {
    validateEnum(status, VALID_STATUSES, 'status');
    conditions.push(eq(tasks.status, status));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset);

  return rows as Task[];
}

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

export async function getTask(db: DbClient, id: string): Promise<Task | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows.length > 0 ? (rows[0] as Task) : null;
}

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------

export async function updateTask(
  db: DbClient,
  id: string,
  patch: UpdateTaskPatch,
  options: UpdateTaskOptions
): Promise<Task> {
  // Step 1：SELECT 當前 row
  const currentRows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (currentRows.length === 0) {
    throw new NotFoundError('Task not found', { id });
  }
  const current = currentRows[0] as Task;

  // Step 1.5：projectId 範疇檢查（codex review round 5 P2）
  //   若 caller 指定 projectId，task 必須屬於該 project，否則視為「找不到」
  //   （不洩露存在性給跨 project 窺探者）
  if (options.projectId !== undefined && current.projectId !== options.projectId) {
    throw new NotFoundError('Task not found', { id });
  }

  const currentStatus = current.status as TaskStatus;

  // Step 2：expectedStatus 檢查
  if (currentStatus !== options.expectedStatus) {
    throw new StaleTaskError('Task status changed', {
      id,
      current: currentStatus,
      expected: options.expectedStatus,
    });
  }

  // Step 2.5：patch 欄位 pre-validation（title 長度 + enum 驗證）
  //   把 enum 驗證放在狀態矩陣之前，避免 `status: "paused"` 這種壞值被誤判成
  //   "INVALID_TRANSITION"（codex review round 9 P3）
  if (patch.title !== undefined) {
    validateTitle(patch.title);
  }
  if (patch.status !== undefined) {
    validateEnum(patch.status, VALID_STATUSES, 'status');
  }
  if (patch.priority !== undefined) {
    validateEnum(patch.priority, VALID_PRIORITIES, 'priority');
  }

  // Step 3：狀態矩陣檢查（若 patch 有 status 變更）
  if (patch.status !== undefined && !isLegalTransition(currentStatus, patch.status)) {
    throw new InvalidTransitionError(
      `${currentStatus} → ${patch.status} not allowed`,
      { from: currentStatus, to: patch.status }
    );
  }

  // Step 4：組 update payload
  const setPayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (patch.title !== undefined) setPayload.title = patch.title;
  if (patch.description !== undefined) setPayload.description = patch.description;
  if (patch.status !== undefined) setPayload.status = patch.status;
  if (patch.priority !== undefined) setPayload.priority = patch.priority;
  if (patch.dueDate !== undefined) setPayload.dueDate = patch.dueDate;
  if (patch.tags !== undefined) setPayload.tags = patch.tags;
  if (patch.metadata !== undefined) setPayload.metadata = patch.metadata;

  // Step 5：completed_at 副作用
  //   只在「真的轉入 done」時才設 completed_at = now()；
  //   已是 done 的 no-op update（status='done' 同 currentStatus='done'）
  //   不可覆寫原完成時間（否則稽核時間漂移）。
  if (patch.status === 'done' && currentStatus !== 'done') {
    setPayload.completedAt = new Date();
  } else if (patch.status === 'open' && currentStatus === 'done') {
    setPayload.completedAt = null;
  }
  // 其他組合：不碰 completed_at

  // Step 6：UPDATE ... WHERE id=? AND status=expectedStatus（optimistic locking 第二道防線）
  //   若 projectId 有帶也加進 WHERE，雙重保險（race 下別人重 insert 同 id 到他 project
  //   是 UUID collision 天方夜譚，但加了不花成本）
  const updateConditions = [eq(tasks.id, id), eq(tasks.status, options.expectedStatus)];
  if (options.projectId !== undefined) {
    updateConditions.push(eq(tasks.projectId, options.projectId));
  }
  const updated = await db
    .update(tasks)
    .set(setPayload)
    .where(and(...updateConditions))
    .returning();

  if (updated.length === 0) {
    // race：SELECT 和 UPDATE 之間 status 被改了
    throw new StaleTaskError('Task status changed (race)', {
      id,
      expected: options.expectedStatus,
    });
  }

  return updated[0] as Task;
}

// ---------------------------------------------------------------------------
// resolveTaskByShortId
// ---------------------------------------------------------------------------

const SHORT_ID_MIN_LENGTH = 6;
const SHORT_ID_CANDIDATE_LIMIT = 100;
const SHORT_ID_AMBIGUOUS_DISPLAY = 5;

export async function resolveTaskByShortId(
  db: DbClient,
  prefix: string,
  projectId: string
): Promise<ResolveShortIdResult> {
  if (prefix.length < SHORT_ID_MIN_LENGTH) {
    throw new InvalidArgumentError('Task short-id prefix must be at least 6 chars', {
      prefixLength: prefix.length,
    });
  }

  // id 是 uuid，用 id::text LIKE 'prefix%' 抓前綴
  // 注意：prefix 來自呼叫端；% / _ 在 LIKE 裡有特殊意義，
  // 但 uuid 的合法字元只有 0-9 a-f -，不會包含 %/_，因此可直接拼。
  // 仍保守：顯式過濾非 uuid 字元以防 caller 傳奇怪值。
  // postgres uuid::text 一律輸出小寫，LIKE 大小寫敏感 → sanitize 後 toLowerCase()
  // 避免 caller 複製大寫 UUID prefix 時 false NOT_FOUND（codex review round 3 P2）。
  const sanitized = prefix.replace(/[^0-9a-fA-F-]/g, '').toLowerCase();
  if (sanitized.length < SHORT_ID_MIN_LENGTH) {
    // 真正送到 DB 的 prefix 被 sanitize 後太短 → 當 NOT_FOUND
    // （等同 uuid 不可能匹配）
    return { kind: 'NOT_FOUND' };
  }

  const pattern = sanitized + '%';
  const rows = (await db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.projectId, projectId), sql`${tasks.id}::text LIKE ${pattern}`)
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(SHORT_ID_CANDIDATE_LIMIT)) as Task[];

  if (rows.length === 0) return { kind: 'NOT_FOUND' };
  if (rows.length === 1) return { kind: 'FOUND', task: rows[0] };
  return {
    kind: 'AMBIGUOUS',
    candidates: rows.slice(0, SHORT_ID_AMBIGUOUS_DISPLAY),
  };
}
