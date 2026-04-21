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

export async function createTask(db: DbClient, input: CreateTaskInput): Promise<Task> {
  const writerHost = input.writerHost ?? resolveWriterHost();

  const row = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    title: input.title,
    description: input.description,
    status: input.status ?? 'open',
    priority: input.priority ?? 'normal',
    dueDate: input.dueDate,
    tags: input.tags ?? [],
    source: input.source ?? 'manual',
    sourceRef: input.sourceRef,
    idempotencyKey: input.idempotencyKey,
    writerHost,
    metadata: input.metadata ?? {},
  };

  const [inserted] = await db.insert(tasks).values(row).returning();
  return inserted as Task;
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
    conditions.push(inArray(tasks.status, status));
  } else {
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
  const currentStatus = current.status as TaskStatus;

  // Step 2：expectedStatus 檢查
  if (currentStatus !== options.expectedStatus) {
    throw new StaleTaskError('Task status changed', {
      id,
      current: currentStatus,
      expected: options.expectedStatus,
    });
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
  if (patch.status === 'done') {
    setPayload.completedAt = new Date();
  } else if (patch.status === 'open' && currentStatus === 'done') {
    setPayload.completedAt = null;
  }
  // 其他組合：不碰 completed_at

  // Step 6：UPDATE ... WHERE id=? AND status=expectedStatus（optimistic locking 第二道防線）
  const updated = await db
    .update(tasks)
    .set(setPayload)
    .where(and(eq(tasks.id, id), eq(tasks.status, options.expectedStatus)))
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
  const sanitized = prefix.replace(/[^0-9a-fA-F-]/g, '');
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
