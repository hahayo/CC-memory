// tests/scripts/capture-hook-project-id.test.ts
//
// hooks/post-tool-use-capture.sh 與 hooks/stop-capture-sentinel.sh 的 project_id 解析契約。
// 解析順序：CLAUDE.md marker（cwd 往上走到 repo root 為止，同 tryReadClaudeMdMarker）
//   → git repo root basename → cwd basename → unknown。
// 刻意不做 resolveProjectId 的 git-origin owner/repo 層（需 spawn git；既有 corpus 皆目錄名）。
// 非 ASCII（中文）目錄名保留原字寫進記錄行；spool 目錄名以 _uXXXX 編碼（不碰撞）。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('capture hooks resolve project_id (marker → repo root → cwd basename; no git-origin layer)', () => {
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
    expect(spoolDirs()).toEqual(['_u624b_u6a5f_u9060_u7aef_u63a7_u5236']);
    expect(firstRecord('_u624b_u6a5f_u9060_u7aef_u63a7_u5236').project_id).toBe('手機遠端控制');
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

  it('keeps two non-git non-ASCII dirs of one session in two spool files (no collision)', () => {
    const a = join(sandbox, '甲乙');
    const b = join(sandbox, '丙丁');
    mkdirSync(a); mkdirSync(b);

    runHook(POST_HOOK, a);
    runHook(POST_HOOK, b);

    expect(spoolDirs()).toEqual(['_u4e19_u4e01', '_u7532_u4e59']);
    expect(firstRecord('_u7532_u4e59').project_id).toBe('甲乙');
    expect(firstRecord('_u4e19_u4e01').project_id).toBe('丙丁');
  });

  it('detects a worktree .git file that has no trailing newline', () => {
    const worktree = join(sandbox, 'wt-nonl');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/wt-nonl', 'utf8');
    const cwd = join(worktree, 'sub');
    mkdirSync(cwd);

    runHook(POST_HOOK, cwd);

    expect(spoolDirs()).toEqual(['wt-nonl']);
  });

  it('strips repeated trailing slashes like Node basename', () => {
    mkdirSync(join(sandbox, 'proj'));

    runHook(POST_HOOK, `${join(sandbox, 'proj')}//`);

    expect(spoolDirs()).toEqual(['proj']);
    expect(firstRecord('proj').project_id).toBe('proj');
  });

  it('trims marker whitespace and treats a whitespace-only marker as absent', () => {
    const spaced = makeGitRepo('spaced');
    writeFileSync(join(spaced, 'CLAUDE.md'), '<!-- cc-memory: project="  spaced-id  " -->\n', 'utf8');
    runHook(POST_HOOK, spaced, 'session-a');
    expect(firstRecord('spaced-id', 'session-a').project_id).toBe('spaced-id');

    const blank = makeGitRepo('blank-marker');
    writeFileSync(join(blank, 'CLAUDE.md'), '<!-- cc-memory: project="   " -->\n', 'utf8');
    runHook(POST_HOOK, blank, 'session-b');
    expect(firstRecord('blank-marker', 'session-b').project_id).toBe('blank-marker');
  });

  it('ignores a CLAUDE.md that is a FIFO instead of hanging', () => {
    const root = makeGitRepo('fifo-repo');
    const fifo = join(root, 'CLAUDE.md');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const cwd = join(root, 'sub');
    mkdirSync(cwd);

    const started = Date.now();
    const result = runHook(POST_HOOK, cwd);

    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(spoolDirs()).toEqual(['fifo-repo']);
  });

  it('decodes surrogate pairs and keeps a literal backslash-u sequence intact', () => {
    const emoji = join(sandbox, '😀log');
    mkdirSync(emoji);
    runHook(POST_HOOK, emoji, 'session-emoji');
    expect(spoolDirs()).toContain('_u1f600log');
    expect(firstRecord('_u1f600log', 'session-emoji').project_id).toBe('😀log');

    const literal = join(sandbox, 'x\\u002fy');
    mkdirSync(literal);
    runHook(POST_HOOK, literal, 'session-literal');
    expect(spoolDirs()).toContain('x_u005cu002fy');
    expect(firstRecord('x_u005cu002fy', 'session-literal').project_id).toBe('x\\u002fy');
  });

  it('refuses to follow a pre-planted symlink at the spool project directory', () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside);
    mkdirSync(spoolRoot, { recursive: true });
    symlinkSync(outside, join(spoolRoot, 'linked'));
    const cwd = join(sandbox, 'linked');
    mkdirSync(cwd);

    const result = runHook(POST_HOOK, cwd);

    expect(result.status).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('keeps walking up past a .git file that is not a gitdir pointer', () => {
    const outer = makeGitRepo('outer-repo');
    const inner = join(outer, 'vendor', 'thing');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, '.git'), 'not a pointer\n', 'utf8');
    const cwd = join(inner, 'src');
    mkdirSync(cwd);

    runHook(POST_HOOK, cwd);

    expect(spoolDirs()).toEqual(['outer-repo']);
  });

  it('ignores a CLAUDE.md marker located above the repo root', () => {
    writeFileSync(join(sandbox, 'CLAUDE.md'), '<!-- cc-memory: project="too-high" -->\n', 'utf8');
    const root = makeGitRepo('inner-repo');
    const cwd = join(root, 'sub');
    mkdirSync(cwd);

    runHook(POST_HOOK, cwd);

    expect(spoolDirs()).toEqual(['inner-repo']);
  });

  it('encodes dot-prefixed and literal _u ids without colliding (bash side matches TS)', () => {
    const names = ['.x', '..x', '_x', '_u002f'];
    names.forEach((name, index) => {
      mkdirSync(join(sandbox, name));
      runHook(POST_HOOK, join(sandbox, name), `session-${index}`);
    });

    expect(spoolDirs()).toEqual(['_u002e.x', '_u002ex', '_u005fu002f', '_x']);
    expect(firstRecord('_u005fu002f', 'session-3').project_id).toBe('_u002f');
    expect(firstRecord('_u002e.x', 'session-1').project_id).toBe('..x');
  });

  it('bounds the CLAUDE.md read to 64 KiB of bytes, not characters', () => {
    const root = makeGitRepo('big-claude-md');
    // 70,000 個三位元組字元（210 KB）後才出現 marker：64 KiB 位元組上限內讀不到 → 落到根目錄名
    writeFileSync(join(root, 'CLAUDE.md'), `${'中'.repeat(70000)}\n<!-- cc-memory: project="late-marker" -->\n`, 'utf8');
    const cwd = join(root, 'sub');
    mkdirSync(cwd);

    const started = Date.now();
    runHook(POST_HOOK, cwd);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(spoolDirs()).toEqual(['big-claude-md']);
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
