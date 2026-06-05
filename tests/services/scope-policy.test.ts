// tests/services/scope-policy.test.ts
//
// ScopePolicy 純邏輯單元測試（無 DB）。
//
// 兩種 instance 模式：
//   - forced-mode（CC_FORCE_PROJECT_ID 設定）：此 instance 鎖定單一 namespace（如 __personal__）
//       無 selector → 強制套用；傳別的 → 拒絕。
//   - project-mode（未設 CC_FORCE_PROJECT_ID）：一般專案 instance
//       deny 保留 namespace（__personal__）；無 selector 的 scope 工具 fail-fast。
//
// 此模組是所有 tool（含 cc_memory_search 獨立分支）共用的 single source of truth。

import { describe, expect, it } from 'vitest';
import {
  PERSONAL_PROJECT_ID,
  isReservedProjectId,
  loadScopeConfig,
  applyScopePolicy,
} from '../../src/services/scope-policy.js';
import { InvalidArgumentError } from '../../src/services/errors.js';

describe('PERSONAL_PROJECT_ID / isReservedProjectId', () => {
  it('PERSONAL_PROJECT_ID 為保留字 __personal__', () => {
    expect(PERSONAL_PROJECT_ID).toBe('__personal__');
    expect(isReservedProjectId('__personal__')).toBe(true);
  });
  it('一般 project id 不是保留字', () => {
    expect(isReservedProjectId('AI_Copilot')).toBe(false);
    expect(isReservedProjectId('cc-memory')).toBe(false);
  });
});

describe('loadScopeConfig', () => {
  it('未設 env → project-mode（forcedProjectId null）', () => {
    expect(loadScopeConfig({}).forcedProjectId).toBeNull();
  });
  it('CC_FORCE_PROJECT_ID 設定 → forced-mode', () => {
    expect(loadScopeConfig({ CC_FORCE_PROJECT_ID: '__personal__' }).forcedProjectId).toBe(
      '__personal__'
    );
  });
  it('CC_FORCE_PROJECT_ID 空白 → 視同未設（project-mode）', () => {
    expect(loadScopeConfig({ CC_FORCE_PROJECT_ID: '   ' }).forcedProjectId).toBeNull();
  });
  it('CC_FORCE_PROJECT_ID 與 CC_MEMORY_PROJECT_ID 同時設 → 啟動 fail（config drift 防護）', () => {
    expect(() =>
      loadScopeConfig({ CC_FORCE_PROJECT_ID: '__personal__', CC_MEMORY_PROJECT_ID: 'AI_Copilot' })
    ).toThrow(/CC_FORCE_PROJECT_ID.*CC_MEMORY_PROJECT_ID|config/i);
  });
});

describe('applyScopePolicy — forced-mode（forcedProjectId = __personal__）', () => {
  const config = { forcedProjectId: PERSONAL_PROJECT_ID };

  it('scope 工具無 selector → 強制套用 forced id（不 fail-fast）', () => {
    expect(applyScopePolicy(undefined, { config, surface: 'scope' })).toBe(PERSONAL_PROJECT_ID);
  });
  it('search 無 selector → 強制 forced id（不可全專案搜尋）', () => {
    expect(applyScopePolicy(undefined, { config, surface: 'search' })).toBe(PERSONAL_PROJECT_ID);
  });
  it('傳入相同 forced id → 放行', () => {
    expect(applyScopePolicy(PERSONAL_PROJECT_ID, { config, surface: 'scope' })).toBe(
      PERSONAL_PROJECT_ID
    );
  });
  it('傳入別的 project_id（scope）→ 拒絕（不允許跨 project）', () => {
    expect(() => applyScopePolicy('AI_Copilot', { config, surface: 'scope' })).toThrow(
      InvalidArgumentError
    );
  });
  it('傳入別的 project_id（search）→ 拒絕', () => {
    expect(() => applyScopePolicy('AI_Copilot', { config, surface: 'search' })).toThrow(
      InvalidArgumentError
    );
  });
});

describe('applyScopePolicy — project-mode（forcedProjectId = null，deny 保留 namespace）', () => {
  const config = { forcedProjectId: null };

  it('scope 工具無 selector → fail-fast（訊息含 project_id 或 project_path）', () => {
    expect(() => applyScopePolicy(undefined, { config, surface: 'scope' })).toThrow(
      /project_id 或 project_path/
    );
  });
  it('search 無 selector → undefined（全專案搜尋，WHERE 另排除保留 namespace）', () => {
    expect(applyScopePolicy(undefined, { config, surface: 'search' })).toBeUndefined();
  });
  it('顯式 project_id=__personal__（scope）→ 拒絕（deny 保留 namespace）', () => {
    expect(() => applyScopePolicy(PERSONAL_PROJECT_ID, { config, surface: 'scope' })).toThrow(
      InvalidArgumentError
    );
  });
  it('解析到 __personal__（search）→ 拒絕', () => {
    expect(() => applyScopePolicy(PERSONAL_PROJECT_ID, { config, surface: 'search' })).toThrow(
      InvalidArgumentError
    );
  });
  it('一般 project id（scope）→ 放行', () => {
    expect(applyScopePolicy('AI_Copilot', { config, surface: 'scope' })).toBe('AI_Copilot');
  });
  it('一般 project id（search）→ 放行', () => {
    expect(applyScopePolicy('AI_Copilot', { config, surface: 'search' })).toBe('AI_Copilot');
  });
});
