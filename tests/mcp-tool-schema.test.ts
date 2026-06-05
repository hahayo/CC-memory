// tests/mcp-tool-schema.test.ts
//
// ListTools inputSchema 契約測試（drift guard）。
//
// 背景：runtime handler（resolveCwdAndProjectId）對 scope 工具 fail-fast 要求
// project_id 或 project_path，但 JSON schema 層的 selector required 宣告曾被誤刪，
// 造成 schema ↔ runtime drift（schema 沒宣告必填、runtime 仍擋）。
// 本測試直接 assert 匯出的 `tools` 陣列的 inputSchema，鎖住契約：
//   - 所有 scope 工具：schema 必須宣告 (project_id OR project_path) required combo
//   - cc_memory_search：刻意維持 optional（省略 selector = 全專案搜尋，是 feature）
//
// 不碰 DB，純結構斷言。

import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { tools, buildToolsForMode } from '../src/index.js';
import { loadScopeConfig } from '../src/services/scope-policy.js';

// scope 工具：runtime fail-fast 要求 project selector，schema 也必須宣告
const SCOPE_TOOLS = [
  'cc_memory_save',
  'cc_memory_list',
  'cc_memory_get',
  'cc_memory_stats',
  'cc_memory_delete',
  'cc_task_create',
  'cc_task_list',
  'cc_task_update',
  'cc_task_stats',
] as const;

// 刻意 optional selector（全專案搜尋 feature）
const OPTIONAL_SELECTOR_TOOLS = ['cc_memory_search'] as const;

interface SchemaLike {
  anyOf?: Array<{ required?: string[] }>;
  allOf?: Array<{ anyOf?: Array<{ required?: string[] }> }>;
}

/** 收集 schema 中（top-level anyOf + allOf[].anyOf）所有 branch 的 required 陣列 */
function selectorBranches(schema: SchemaLike): string[][] {
  const out: string[][] = [];
  const collect = (anyOf?: Array<{ required?: string[] }>) => {
    if (Array.isArray(anyOf)) {
      for (const b of anyOf) if (Array.isArray(b.required)) out.push(b.required);
    }
  };
  collect(schema.anyOf);
  if (Array.isArray(schema.allOf)) for (const a of schema.allOf) collect(a.anyOf);
  return out;
}

/** schema 是否強制 (project_id OR project_path) ── 至少一 branch 含 project_id、另有一 branch 含 project_path */
function requiresProjectSelector(schema: SchemaLike): boolean {
  const branches = selectorBranches(schema);
  if (branches.length === 0) return false;
  const hasId = branches.some((b) => b.includes('project_id'));
  const hasPath = branches.some((b) => b.includes('project_path'));
  return hasId && hasPath;
}

function toolByName(name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe('ListTools inputSchema 契約（schema↔runtime drift guard）', () => {
  it.each(SCOPE_TOOLS)('%s schema 宣告 project selector required combo', (name) => {
    const schema = toolByName(name).inputSchema as SchemaLike;
    expect(requiresProjectSelector(schema)).toBe(true);
  });

  it.each(OPTIONAL_SELECTOR_TOOLS)('%s schema 維持 selector optional（全專案搜尋 feature）', (name) => {
    const schema = toolByName(name).inputSchema as SchemaLike;
    expect(requiresProjectSelector(schema)).toBe(false);
  });
});

// forced-mode（CC_FORCE_PROJECT_ID）：無 selector→強制 forced project，因此 schema
// 不應再宣告 selector 必填（否則嚴格 client 會在送達 handler 前擋掉 no-selector 呼叫）。
// 採納 Codex P2：schema 隨 mode 動態。
describe('forced-mode ListTools schema：selector 非必填（採納 Codex P2）', () => {
  const forcedTools = buildToolsForMode(loadScopeConfig({ CC_FORCE_PROJECT_ID: '__personal__' }));
  const find = (name: string): Tool => {
    const t = forcedTools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };

  it.each(SCOPE_TOOLS)('%s 在 forced-mode 不要求 project selector', (name) => {
    expect(requiresProjectSelector(find(name).inputSchema as SchemaLike)).toBe(false);
  });

  it('forced-mode 仍保留 id-based base required（get/delete/update）', () => {
    expect((find('cc_memory_get').inputSchema as { required?: string[] }).required).toContain('id');
    expect((find('cc_memory_delete').inputSchema as { required?: string[] }).required).toContain('id');
    const upd = (find('cc_task_update').inputSchema as { required?: string[] }).required ?? [];
    expect(upd).toContain('id');
    expect(upd).toContain('expected_status');
  });

  it('project-mode（預設）仍維持 selector 必填（不回歸）', () => {
    const projectTools = buildToolsForMode(loadScopeConfig({}));
    const t = projectTools.find((x) => x.name === 'cc_task_create')!;
    expect(requiresProjectSelector(t.inputSchema as SchemaLike)).toBe(true);
  });
});
