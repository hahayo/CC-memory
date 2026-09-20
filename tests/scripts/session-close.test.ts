import { openSync, closeSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('hooks/session-close.sh');
describe('local session close command', () => {
  it.each(['claude', 'codex'])('records close and transcript boundary for %s without DB or LLM', client => {
    const root = mkdtempSync(join(tmpdir(), 'close-test-'));
    try {
      const cwd = join(root, 'project'); mkdirSync(cwd);
      writeFileSync(join(cwd, 'CLAUDE.md'), '<!-- cc-memory: project="demo" -->');
      mkdirSync(join(cwd, '.git')); writeFileSync(join(cwd, '.git/HEAD'), 'ref: refs/heads/main');
      const transcript = join(root, 'transcript.jsonl'); writeFileSync(transcript, 'hello\n');
      const payload = join(root, 'payload.json');
      writeFileSync(payload, JSON.stringify({ cwd, session_id: `${client}-session`, transcript_path: transcript }));
      const fd = openSync(payload, 'r');
      const result = spawnSync('bash', [script], { encoding: 'utf8', timeout: 5000,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, CC_MEMORY_CAPTURE_CHILD: '', CC_MEMORY_SPOOL_DIR: join(root, 'spool') },
        stdio: [fd, 'pipe', 'pipe'],
      });
      closeSync(fd);
      expect(result.status).toBe(0);
      const spool = join(root, 'spool/demo', `${client}-session.jsonl`);
      expect(existsSync(`${spool}.close`)).toBe(true);
      expect(JSON.parse(readFileSync(spool, 'utf8')).hwm_offset).toBe(6);
      expect(JSON.parse(readFileSync(`${spool}.finalize.json`, 'utf8'))).toEqual({ projectId: 'demo', sessionId: `${client}-session` });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('always exits zero for invalid input and capture children', () => {
    for (const child of ['', '1']) {
      const fd = openSync('/dev/null', 'r');
      const result = spawnSync('bash', [script], { stdio: [fd, 'pipe', 'pipe'], timeout: 5000, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CC_MEMORY_CAPTURE_CHILD: child } });
      closeSync(fd);
      expect(result.status).toBe(0);
    }
  });
});

it.each(['personal', 'child'])('does not write any marker for a valid %s request', mode => {
  const root = mkdtempSync(join(tmpdir(), 'close-deny-'));
  try {
    mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(root, 'CLAUDE.md'), `<!-- cc-memory: project="${mode === 'personal' ? '__personal__' : 'demo'}" -->`);
    const transcript = join(root, 't'); writeFileSync(transcript, 'hello');
    const payload = join(root, 'payload.json');
    writeFileSync(payload, JSON.stringify({ cwd: root, session_id: 's', transcript_path: transcript }));
    const fd = openSync(payload, 'r');
    const result = spawnSync('bash', [script], { stdio: [fd, 'pipe', 'pipe'], timeout: 5000,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, CC_MEMORY_SPOOL_DIR: join(root, 'spool'),
        CC_MEMORY_CAPTURE_CHILD: mode === 'child' ? '1' : '' },
    });
    closeSync(fd);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'spool'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
