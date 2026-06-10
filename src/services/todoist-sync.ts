// src/services/todoist-sync.ts
//
// A3d — Todoist → cc-memory 單向 sync（方案 A：polling）。
//
// 流程（pullAndApply 一次 tick）：
//   1. 讀 sync_state.sync_token（resource='todoist'）；無 → '*'（full sync）
//   2. POST {base}/sync（application/x-www-form-urlencoded：sync_token + resource_types=["items"]）
//   3. 單一 tx：逐筆 upsert 到 tasks（ON CONFLICT (todoist_id)）+ 寫回新 sync_token
//      → token 只在整批套用成功後前進；中途失敗整包 rollback，下輪用舊 token 重拉
//
// 方向性（loop prevention）：本 service 只「讀」Todoist（/sync 一個 endpoint），
// 永不呼叫 Todoist 寫入端點。cc-memory→Todoist 方向只存在於顯式 cc_todoist_add
// （src/services/todoist.ts），無自動鏡像，故無回流迴圈。
//
// 欄位對應（Todoist=SOT，單向蓋過）：
//   id → todoist_id（upsert key）
//   content → title（截 500，title length CHECK）
//   description → description
//   due.date → due_date（無 due → NULL；date-only 'YYYY-MM-DD' 與 datetime 皆交 new Date）
//   priority 4/3/2/1 → high/normal/normal/low（Todoist 4=最高）
//   checked=true → status='done' + completed_at
//   is_deleted=true → status='cancelled'（軟刪，不真刪）
//   固定：project_id='__personal__'、source='todoist'

import { PERSONAL_PROJECT_ID } from '../constants.js';
import { ForbiddenError, RateLimitError, TodoistApiError } from './errors.js';

// 與 src/services/todoist.ts 同 base（unified API v1）
const BASE_URL = 'https://api.todoist.com/api/v1';
const SYNC_TIMEOUT_MS = 30_000;
const TITLE_MAX = 500;
const RESOURCE = 'todoist';

// postgres.js Sql（poller / 測試皆傳 postgres() client；不經 Drizzle，raw upsert 較直接）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = any;

interface TodoistDue {
  date: string;
}

interface TodoistSyncItem {
  id: string;
  content: string;
  description?: string;
  priority?: number;
  due?: TodoistDue | null;
  checked?: boolean;
  is_deleted?: boolean;
  completed_at?: string | null;
}

interface SyncResponse {
  items?: TodoistSyncItem[];
  full_sync?: boolean;
  sync_token: string;
}

export interface SyncResult {
  /** 套用的 active 列數（不含 completed / archived） */
  upserted: number;
  /** checked=true 的列數 */
  completed: number;
  /** is_deleted=true 的列數（軟刪 → cancelled） */
  archived: number;
  newSyncToken: string;
}

export interface PullAndApplyOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const PRIORITY_MAP: Record<number, string> = { 4: 'high', 3: 'normal', 2: 'normal', 1: 'low' };

function mapItem(item: TodoistSyncItem): {
  todoistId: string;
  title: string;
  description: string | null;
  dueDate: Date | null;
  priority: string;
  status: string;
  completedAt: Date | null;
} {
  const rawTitle = (item.content ?? '').slice(0, TITLE_MAX);
  const status = item.is_deleted ? 'cancelled' : item.checked ? 'done' : 'open';
  return {
    todoistId: item.id,
    title: rawTitle.length > 0 ? rawTitle : '(untitled)',
    description: item.description && item.description.length > 0 ? item.description : null,
    dueDate: item.due?.date ? new Date(item.due.date) : null,
    priority: PRIORITY_MAP[item.priority ?? 1] ?? 'normal',
    status,
    completedAt:
      status === 'done'
        ? item.completed_at
          ? new Date(item.completed_at)
          : new Date()
        : null,
  };
}

async function fetchSync(
  token: string,
  syncToken: string,
  opts?: PullAndApplyOptions
): Promise<SyncResponse> {
  const base = opts?.baseUrl ?? BASE_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? SYNC_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        sync_token: syncToken,
        resource_types: '["items"]',
      }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TodoistApiError('INTERNAL', `Todoist /sync 傳輸層錯誤: ${msg}`, {
      error_tag: 'sync_transport',
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new RateLimitError('Todoist /sync rate limited', {
      retry_after: retryAfter ? parseInt(retryAfter, 10) : undefined,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new ForbiddenError(`Todoist /sync 認證失敗 (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new TodoistApiError('INTERNAL', `Todoist /sync HTTP ${res.status}`, {
      error_tag: 'sync_http',
      http_code: res.status,
    });
  }

  return (await res.json()) as SyncResponse;
}

/**
 * 一次 sync tick：拉 Todoist 變更 → 單一 tx 套用 + 前進 sync_token。
 * 任何 API 錯誤直接 throw（poller 下輪重試，token 不前進）。
 */
export async function pullAndApply(
  sql: Sql,
  token: string,
  opts?: PullAndApplyOptions
): Promise<SyncResult> {
  const prev = await sql`SELECT sync_token FROM sync_state WHERE resource = ${RESOURCE}`;
  const syncToken: string = prev.length > 0 ? prev[0].sync_token : '*';

  const resp = await fetchSync(token, syncToken, opts);
  const items = resp.items ?? [];

  let upserted = 0;
  let completed = 0;
  let archived = 0;

  await sql.begin(async (tx: Sql) => {
    for (const raw of items) {
      const m = mapItem(raw);
      await tx`
        INSERT INTO tasks (project_id, title, description, due_date, priority, status,
                           source, todoist_id, completed_at, updated_at)
        VALUES (${PERSONAL_PROJECT_ID}, ${m.title}, ${m.description}, ${m.dueDate},
                ${m.priority}, ${m.status}, 'todoist', ${m.todoistId}, ${m.completedAt}, NOW())
        ON CONFLICT (todoist_id) WHERE todoist_id IS NOT NULL
        DO UPDATE SET
          title        = EXCLUDED.title,
          description  = EXCLUDED.description,
          due_date     = EXCLUDED.due_date,
          priority     = EXCLUDED.priority,
          status       = EXCLUDED.status,
          completed_at = EXCLUDED.completed_at,
          updated_at   = NOW()
      `;
      if (m.status === 'cancelled') archived += 1;
      else if (m.status === 'done') completed += 1;
      else upserted += 1;
    }

    // token 與資料同 tx 前進：中途失敗整包 rollback，下輪用舊 token 重拉（冪等 upsert 容忍重套）
    await tx`
      INSERT INTO sync_state (resource, sync_token, updated_at)
      VALUES (${RESOURCE}, ${resp.sync_token}, NOW())
      ON CONFLICT (resource)
      DO UPDATE SET sync_token = EXCLUDED.sync_token, updated_at = NOW()
    `;
  });

  return { upserted, completed, archived, newSyncToken: resp.sync_token };
}
