// Step B dry-run：把崩塌 project_id 的既有列對到真正專案名，產可逆對照表。只讀 spool／transcript／檔案系統，不碰 DB。
// 執行：cd ~/CC_project/worktrees/ccm-remap && npx tsx <this file> <rows.jsonl> <all-rollups.jsonl> <out.jsonl>
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveProjectId } from '../src/services/projects.js';
import * as worker from '../src/services/capture-worker.js';
const readFirstTranscriptCwd = (worker as { readFirstTranscriptCwd: (p: string, n: number) => Promise<string | null> }).readFirstTranscriptCwd;
const TRANSCRIPT_CWD_SCAN_BYTES = 256 * 1024;

interface Row {
  table: 'observations' | 'project_memories';
  id: string;
  old_project_id: string;
  session_id: string | null;
  rollup_memory_id: string | null;
  status: string;
  content_hash: string | null;
  created_at: string;
}
interface RollupRow { id: string; project_id: string; idempotency_key: string; status: string }

const [rowsPath, rollupsPath, outPath] = process.argv.slice(2);
const rows: Row[] = readFileSync(rowsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const allRollups: RollupRow[] = readFileSync(rollupsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SPOOL = join(homedir(), '.cache', 'cc-memory', 'spool');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// --- 1. spool：session → transcript_path 集合 ---
const spoolDirs = readdirSync(SPOOL, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '.dead').map((d) => d.name);
function transcriptPathsForSession(sessionId: string): string[] {
  const out = new Set<string>();
  for (const dir of spoolDirs) {
    let names: string[];
    try { names = readdirSync(join(SPOOL, dir)); } catch { continue; }
    const matches = names.filter((n) => n === `${sessionId}.jsonl` || (n.startsWith(`${sessionId}.jsonl.`) && n.endsWith('.sealed')));
    for (const name of matches) {
    const p = join(SPOOL, dir, name);
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes('transcript_path')) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.transcript_path === 'string' && rec.transcript_path) out.add(rec.transcript_path);
      } catch { /* malformed */ }
    }
    }
  }
  return [...out];
}

// --- 2. transcript 目錄名反查真實 cwd（transcript 已被 30 天清理刪除時的備援證據）---
// Claude Code 把 cwd 編成目錄名：舊版把 `/`、`_`、`.` 等非英數全換 `-`；新版只換 `/`（保留 `_` 與中文）。
function encodeOld(p: string): string { return p.replace(/[^A-Za-z0-9㐀-鿿豈-﫿]/g, '-'); }
function encodeNew(p: string): string { return p.replace(/\//g, '-'); }
const SKIP = new Set(['node_modules', '.git', '.cache', '.local', '.npm', '.codex', '.claude', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target']);
const encodedIndex = new Map<string, Set<string>>();
function walk(dir: string, depth: number): void {
  if (depth > 6) return;
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    for (const enc of [encodeOld(full), encodeNew(full)]) {
      if (!encodedIndex.has(enc)) encodedIndex.set(enc, new Set());
      encodedIndex.get(enc)!.add(full);
    }
    walk(full, depth + 1);
  }
}
walk(homedir(), 0);
encodedIndex.set(encodeNew(homedir()), new Set([homedir()]));

function cwdFromEncodedDir(transcriptPath: string): { cwd: string | null; candidates: string[] } {
  if (!transcriptPath.startsWith(PROJECTS_DIR + '/')) return { cwd: null, candidates: [] };
  const enc = transcriptPath.slice(PROJECTS_DIR.length + 1).split('/')[0];
  const cands = [...(encodedIndex.get(enc) ?? [])];
  return { cwd: cands.length === 1 ? cands[0] : null, candidates: cands };
}

// --- 3. 每個 session 推導唯一 new_project_id ---
interface Evidence { type: 'transcript-cwd' | 'encoded-dir'; transcript_path: string; cwd: string }
interface SessionResolution { newId: string | null; evidence: Evidence[]; reason: string }
const sessionCache = new Map<string, SessionResolution>();
async function resolveSession(sessionId: string): Promise<SessionResolution> {
  const cached = sessionCache.get(sessionId);
  if (cached) return cached;
  const paths = transcriptPathsForSession(sessionId);
  const evidence: Evidence[] = [];
  const ids = new Set<string>();
  for (const tp of paths) {
    let cwd: string | null = null;
    let type: Evidence['type'] = 'transcript-cwd';
    if (existsSync(tp)) cwd = await readFirstTranscriptCwd(tp, TRANSCRIPT_CWD_SCAN_BYTES);
    if (!cwd) {
      const enc = cwdFromEncodedDir(tp);
      if (enc.cwd) { cwd = enc.cwd; type = 'encoded-dir'; }
    }
    if (!cwd) continue;
    const id = resolveProjectId({ cwd, cwdIsExplicit: true });
    evidence.push({ type, transcript_path: tp, cwd });
    ids.add(id);
  }
  let result: SessionResolution;
  const hasTranscriptEvidence = evidence.some((e) => e.type === 'transcript-cwd');
  if (paths.length === 0) result = { newId: null, evidence, reason: 'spool 內找不到此 session 的 transcript_path' };
  else if (ids.size === 0) result = { newId: null, evidence, reason: 'transcript 已刪且目錄名對不到唯一真實路徑' };
  else if (ids.size > 1) result = { newId: null, evidence, reason: `同 session 對到多個專案：${[...ids].join(', ')}` };
  else if (!hasTranscriptEvidence) result = { newId: null, evidence, reason: `needs_human：只有 encoded-dir 證據（候選 ${[...ids][0]}），transcript 已刪，需人工核准` };
  else result = { newId: [...ids][0], evidence, reason: 'ok' };
  sessionCache.set(sessionId, result);
  return result;
}

// --- 4. 產對照表 ---
async function main(): Promise<void> {
  const activeRollupByKey = new Map<string, RollupRow>();
  for (const r of allRollups) if (r.status === 'active') activeRollupByKey.set(`${r.project_id}|${r.idempotency_key}`, r);
  const rollupRowById = new Map(allRollups.map((r) => [r.id, r]));

  const out: Record<string, unknown>[] = [];
  const summary = { mapped_obs: 0, mapped_pm_update: 0, mapped_pm_archive: 0, unmapped: 0, reasons: {} as Record<string, number>, new_ids: {} as Record<string, number> };
  const archivedRollupToNew = new Map<string, string>();

  // 先處理 rollup（決定 archive 與否），再處理 observation（rollup_memory_id 可能要改指）
  const pmRows = rows.filter((r) => r.table === 'project_memories');
  const obsRows = rows.filter((r) => r.table === 'observations');
  for (const r of pmRows) {
    const res = r.session_id ? await resolveSession(r.session_id) : { newId: null, evidence: [], reason: 'rollup key 無 session' };
    const guard = res.newId && res.newId !== '__personal__' && res.newId !== r.old_project_id ? null
      : (res.newId === '__personal__' ? '推導為 __personal__' : res.newId === r.old_project_id ? 'new == old' : res.reason);
    if (guard) {
      out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, session_id: r.session_id, action: 'skip', reason: guard, evidence: res.evidence });
      summary.unmapped += 1; summary.reasons[guard.split('：')[0]] = (summary.reasons[guard.split('：')[0]] ?? 0) + 1;
      continue;
    }
    const newKey = `capture:v05:${res.newId}:${r.session_id}`;
    const oldKey = `capture:v05:${r.old_project_id}:${r.session_id}`;
    const existing = activeRollupByKey.get(`${res.newId}|${newKey}`);
    if (existing) {
      // 同 session 已有新 id 的 active rollup：合併 capture metadata（observation_ids／transcript_sources／summarize_count…）
      // 尚未定義，本版不自動 archive（Codex R2 high 5）→ needs_human；其 observations 也一併 skip，避免跨 project FK
      archivedRollupToNew.set(r.id, existing.id);
      out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, session_id: r.session_id, action: 'skip',
        reason: `needs_human：新 id ${res.newId} 已有 active rollup ${existing.id}，需先定義 metadata 合併`, existing_new_rollup_id: existing.id, evidence: res.evidence });
      summary.mapped_pm_archive += 1;
    } else {
      out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, new_project_id: res.newId, session_id: r.session_id,
        action: 'update', old_status: r.status, old_idempotency_key: oldKey, new_idempotency_key: newKey, evidence: res.evidence });
      summary.mapped_pm_update += 1;
    }
    summary.new_ids[res.newId!] = (summary.new_ids[res.newId!] ?? 0) + 1;
  }
  for (const r of obsRows) {
    const res = await resolveSession(r.session_id!);
    const guard = res.newId && res.newId !== '__personal__' && res.newId !== r.old_project_id ? null
      : (res.newId === '__personal__' ? '推導為 __personal__' : res.newId === r.old_project_id ? 'new == old' : res.reason);
    if (guard) {
      out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, session_id: r.session_id, action: 'skip', reason: guard, evidence: res.evidence });
      summary.unmapped += 1; summary.reasons[guard.split('：')[0]] = (summary.reasons[guard.split('：')[0]] ?? 0) + 1;
      continue;
    }
    if (r.rollup_memory_id && archivedRollupToNew.has(r.rollup_memory_id)) {
      out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, session_id: r.session_id, action: 'skip',
        reason: `needs_human：其 rollup ${r.rollup_memory_id} 屬需人工合併的 session`, evidence: res.evidence });
      summary.unmapped += 1; summary.reasons['needs_human（rollup 合併）'] = (summary.reasons['needs_human（rollup 合併）'] ?? 0) + 1;
      continue;
    }
    const rollupProject = r.rollup_memory_id ? rollupRowById.get(r.rollup_memory_id)?.project_id ?? null : null;
    out.push({ table: r.table, id: r.id, old_project_id: r.old_project_id, new_project_id: res.newId, session_id: r.session_id,
      action: 'update', old_status: r.status, content_hash: r.content_hash, old_rollup_memory_id: r.rollup_memory_id,
      rollup_project_id: rollupProject, evidence: res.evidence });
    summary.mapped_obs += 1;
  }
  writeFileSync(outPath, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.log(JSON.stringify({ rows: rows.length, ...summary, encoded_index_size: encodedIndex.size }, null, 2));

}
main().catch((e) => { console.error(e); process.exit(1); });
