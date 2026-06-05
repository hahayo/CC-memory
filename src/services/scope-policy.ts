// src/services/scope-policy.ts
//
// ScopePolicy — 所有 tool（含 cc_memory_search 獨立分支）共用的單一 scope 決策核心。
//
// 解決兩個對稱的隱私邊界問題：
//   方向 1（personal → 專案外洩）：forced-mode instance 鎖定單一 namespace，
//     避免漏傳 selector 時 search 靜默變全專案、撈到其他專案內容。
//   方向 2（專案 → personal 外洩）：一般 project-mode instance 必須 deny 保留
//     namespace（__personal__），避免任何 client 顯式或經 path/marker 解析讀到個人資料。
//
// 設計重點（codex 多輪 P0）：
//   - 這是「應用層」邊界，可被 raw postgres / shell / 其他持有 DATABASE_URL 的 MCP 繞過。
//     終極硬隔離需 DB role / RLS / view（列為強烈建議，非本模組保證）。
//   - 規則作用在「已解析出的 projectId」上，因此 project_path / CLAUDE.md marker /
//     git / basename 解析出保留 namespace 的情況一律被涵蓋（deny 不只擋顯式 project_id）。

import { InvalidArgumentError } from './errors.js';

// ---------------------------------------------------------------------------
// 常數：保留 namespace
// ---------------------------------------------------------------------------

/** 個人近況/決策/待辦的保留 projectId。各 caller 明確帶入，不靠偵測。 */
export const PERSONAL_PROJECT_ID = '__personal__';

/** 所有保留 namespace（未來可擴充）。 */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set([PERSONAL_PROJECT_ID]);

export function isReservedProjectId(id: string): boolean {
  return RESERVED_PROJECT_IDS.has(id);
}

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

export interface ScopeConfig {
  /**
   * CC_FORCE_PROJECT_ID — 非 null = forced-mode（此 instance 鎖定單一 namespace）。
   * null = project-mode（一般專案 instance，deny 保留 namespace）。
   */
  forcedProjectId: string | null;
}

/** scope-required 工具（save/list/get/stats/delete/task_*）vs cross-project search */
export type ScopeSurface = 'scope' | 'search';

export interface ApplyScopeOptions {
  config: ScopeConfig;
  surface: ScopeSurface;
}

// ---------------------------------------------------------------------------
// 啟動期：從 env 解析 ScopeConfig（含 config drift 防護）
// ---------------------------------------------------------------------------

function nonEmptyEnv(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 從 env 解析 ScopeConfig。
 *
 * config drift 防護（codex 第九輪）：CC_FORCE_PROJECT_ID（強制 scope）與既有
 * CC_MEMORY_PROJECT_ID（resolveProjectId 的 fallback layer 2）語意不同，同時設定會
 * 造成「以為強制、實際只是 fallback」的軟邊界。→ 兩者同時非空即啟動 fail。
 */
export function loadScopeConfig(
  env: Record<string, string | undefined> = process.env
): ScopeConfig {
  const forced = nonEmptyEnv(env.CC_FORCE_PROJECT_ID);
  const legacyFallback = nonEmptyEnv(env.CC_MEMORY_PROJECT_ID);

  if (forced !== null && legacyFallback !== null) {
    throw new Error(
      'CC_FORCE_PROJECT_ID 與 CC_MEMORY_PROJECT_ID 不可同時設定：前者是強制 scope（硬邊界），' +
        '後者是 resolveProjectId 的 fallback layer，同時存在會讓隱私邊界退化成軟邊界。' +
        '請只保留 CC_FORCE_PROJECT_ID。'
    );
  }

  return { forcedProjectId: forced };
}

// ---------------------------------------------------------------------------
// 核心決策：applyScopePolicy
// ---------------------------------------------------------------------------

/**
 * 對「已解析出的 projectId」套用 scope policy，回傳最終 scope 或 throw。
 *
 * @param resolvedId  從 args 解析出的 projectId；undefined = caller 未提供任何 selector
 * @returns scope projectId；search 在 project-mode 無 selector 時回 undefined（= 全專案，
 *          WHERE 另排除保留 namespace）。其餘情況回非空字串。
 */
export function applyScopePolicy(
  resolvedId: string | undefined,
  opts: ApplyScopeOptions
): string | undefined {
  const { config, surface } = opts;

  // ---- forced-mode：此 instance 鎖定 forcedProjectId ----
  if (config.forcedProjectId !== null) {
    const forced = config.forcedProjectId;
    if (resolvedId === undefined) return forced; // 無 selector → 強制套用（含 search，不可全專案）
    if (resolvedId === forced) return forced; // 顯式傳相同 → 放行
    throw new InvalidArgumentError(
      `forced-mode：此 instance 鎖定 "${forced}"，不允許存取 "${resolvedId}"`,
      { forcedProjectId: forced, requested: resolvedId }
    );
  }

  // ---- project-mode：deny 保留 namespace ----
  if (resolvedId === undefined) {
    if (surface === 'search') return undefined; // 全專案搜尋（WHERE 排除保留 namespace）
    // scope 工具 fail-fast；訊息與既有契約一致（mcp-handler.test.ts 鎖 /project_id 或 project_path/）
    throw new InvalidArgumentError(
      '需提供 project_id 或 project_path（MCP server 的 process.cwd() 非 client cwd，無法可靠解析 project）',
      { hint: 'skills/{save,load}-memory.md 已示範：tool call 時傳 project_path 為當前工作目錄絕對路徑' }
    );
  }

  if (isReservedProjectId(resolvedId)) {
    throw new InvalidArgumentError(
      `不允許存取保留 namespace "${resolvedId}"：個人資料需透過 forced-mode（CC_FORCE_PROJECT_ID）instance 存取`,
      { reserved: resolvedId }
    );
  }

  return resolvedId;
}
