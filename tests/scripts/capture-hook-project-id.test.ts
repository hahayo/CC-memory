// tests/scripts/capture-hook-project-id.test.ts
//
// hooks/post-tool-use-capture.sh 與 hooks/stop-capture-sentinel.sh 的 project_id 解析契約。
// 對齊 src/services/projects.ts resolveProjectId 的 layer 3-5：
//   CLAUDE.md marker（cwd 往上走到 repo root 為止）→ repo root basename → cwd basename。
// 非 ASCII（中文）目錄名保留原字，只有 spool 目錄名做 sanitize。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POST_HOOK = join(REPO_ROOT, 'hooks', 'post-tool-use-capture.sh');
const STOP_HOOK = join(REPO_ROOT, 'hooks', 'stop-capture-sentinel.sh');

let sandbox: string;
let spoolRoot: string;
let transcriptPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ccm-hook-pid-'));
  spoolRoot = join(sandbox, 'spool');
  transcriptPath = join(sandbox, 'transcript.jsonl');
  writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runHook(hook: string, cwd: string, sessionId = 'session-1'): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    hook_event_name: hook === POST_HOOK ? 'PostToolUse' : 'Stop',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'pwd' },
  });
  return spawnSync('bash', [hook], {
    input: payload,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: sandbox,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      CC_MEMORY_SPOOL_DIR: spoolRoot,
    },
  });
}

function spoolDirs(): string[] {
  return readdirSync(spoolRoot).sort();
}

function firstRecord(dirName: string, sessionId = 'session-1'): Record<string, unknown> {
  const content = readFileSync(join(spoolRoot, dirName, `${sessionId}.jsonl`), 'utf8');
  const firstLine = content.split('\n').find((line) => line.length > 0) ?? '{}';
  return JSON.parse(firstLine) as Record<string, unknown>;
}

function makeGitRepo(name: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return root;
}

describe('capture hooks resolve project_id like resolveProjectId', () => {
  it('uses the git repo root basename when cwd is a non-ASCII subdirectory', () => {
    const root = makeGitRepo('recycling-recognition');
    const cwd = join(root, '文件', '評選簡報');
    mkdirSync(cwd, { recursive: true });

    const result = runHook(POST_HOOK, cwd);

    expect(result.status).toBe(0);
    expect(spoolDirs()).toEqual(['recycling-recognition']);
    expect(firstRecord('recycling-recognition').project_id).toBe('recycling-recognition');
  });

  it('prefers the CLAUDE.md cc-memory marker found walking up from cwd to the repo root', () => {
    const root = makeGitRepo('ops-ten-year-v4');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# CLAUDE.md\n\n<!-- cc-memory: project="AI_Copilot" -->\n',
      'utf8'
    );
    const cwd = join(root, '營運策略2036');
    mkdirSync(cwd, { recursive: true });

    const result = runHook(POST_HOOK, cwd);

    expect(result.status).toBe(0);
    expect(spoolDirs()).toEqual(['AI_Copilot']);
    expect(firstRecord('AI_Copilot').project_id).toBe('AI_Copilot');
  });

  it('takes the nearest CLAUDE.md marker below the repo root (same as the server walk-up)', () => {
    const root = makeGitRepo('monorepo');
    writeFileSync(join(root, 'CLAUDE.md'), '<!-- cc-memory: project="monorepo-root" -->\n', 'utf8');
    const pkg = join(root, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'CLAUDE.md'), '<!-- cc-memory: project="api-service" -->\n', 'utf8');
    const cwd = join(pkg, 'src');
    mkdirSync(cwd, { recursive: true });

    runHook(POST_HOOK, cwd);

    expect(firstRecord('api-service').project_id).toBe('api-service');
  });

  it('treats a git worktree (.git file with gitdir:) as the repo root', () => {
    const worktree = join(sandbox, 'worktrees', 'ccm-feature');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/ccm-feature\n', 'utf8');
    const cwd = join(worktree, '文件');
    mkdirSync(cwd, { recursive: true });

    runHook(POST_HOOK, cwd);

    expect(spoolDirs()).toEqual(['ccm-feature']);
    expect(firstRecord('ccm-feature').project_id).toBe('ccm-feature');
  });

  it('keeps the raw non-ASCII basename outside git and only sanitizes the spool directory name', () => {
    const cwd = join(sandbox, '手機遠端控制');
    mkdirSync(cwd, { recursive: true });

    const result = runHook(POST_HOOK, cwd);

    expect(result.status).toBe(0);
    const dirs = spoolDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^_+$/);
    expect(firstRecord(dirs[0]).project_id).toBe('手機遠端控制');
  });

  it('escapes double quotes and backslashes in the raw project_id', () => {
    const cwd = join(sandbox, 'odd "name" \\ dir');
    mkdirSync(cwd, { recursive: true });

    runHook(POST_HOOK, cwd);

    const [dir] = spoolDirs();
    expect(firstRecord(dir).project_id).toBe('odd "name" \\ dir');
  });

  it('accepts a cwd whose non-ASCII characters arrive as \\uXXXX JSON escapes', () => {
    const root = makeGitRepo('escaped-repo');
    const cwd = join(root, '文件');
    mkdirSync(cwd, { recursive: true });
    const escapedCwd = cwd.replace(/[\u0080-\uffff]/g, (ch) =>
      `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
    const payload = `{"session_id":"session-1","transcript_path":"${transcriptPath}","cwd":"${escapedCwd}","tool_name":"Bash"}`;

    const result = spawnSync('bash', [POST_HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: sandbox, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CC_MEMORY_SPOOL_DIR: spoolRoot },
    });

    expect(result.status).toBe(0);
    expect(spoolDirs()).toEqual(['escaped-repo']);
    expect(firstRecord('escaped-repo').project_id).toBe('escaped-repo');
  });

  it('falls back to "unknown" when cwd is empty (regression guard)', () => {
    runHook(POST_HOOK, '');

    expect(spoolDirs()).toEqual(['unknown']);
    expect(firstRecord('unknown').project_id).toBe('unknown');
  });

  it('Stop sentinel lands in the same spool file as PostToolUse for the same session', () => {
    const root = makeGitRepo('CC-memory');
    writeFileSync(join(root, 'CLAUDE.md'), '<!-- cc-memory: project="CC-memory" -->\n', 'utf8');
    const cwd = join(root, 'docs', '中文子目錄');
    mkdirSync(cwd, { recursive: true });

    runHook(POST_HOOK, cwd);
    const stop = runHook(STOP_HOOK, cwd);

    expect(stop.status).toBe(0);
    expect(spoolDirs()).toEqual(['CC-memory']);
    const lines = readFileSync(join(spoolRoot, 'CC-memory', 'session-1.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).project_id).toBe('CC-memory');
    expect(JSON.parse(lines[1])).toHaveProperty('hwm_offset');
  });
});
