import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditAutoCaptureRecovery } from '../../scripts/audit-auto-capture-recovery.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): { root: string; spool: string; project: string; dead: string } {
  const root = mkdtempSync(join(tmpdir(), 'cc-memory-recovery-audit-'));
  roots.push(root);
  const spool = join(root, 'spool');
  const project = join(spool, 'project-a');
  const dead = join(spool, '.dead');
  mkdirSync(project, { recursive: true, mode: 0o700 });
  mkdirSync(dead, { recursive: true, mode: 0o700 });
  return { root, spool, project, dead };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeSpool(path: string, records: Array<Record<string, unknown>>): number {
  const content = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  return Buffer.byteLength(content);
}

describe('audit auto-capture recovery manifest', () => {
  it('classifies an exact single-path chunk as recoverable without replaying it', async () => {
    const fixture = makeRoot();
    const transcript = join(fixture.root, 'source.transcript.jsonl');
    writeFileSync(transcript, '{"message":"recoverable"}\n', { mode: 0o600 });
    const sessionId = 'session-recoverable';
    const spoolPath = join(fixture.project, `${sessionId}.jsonl`);
    const spoolSize = writeSpool(spoolPath, [
      { session_id: sessionId, transcript_path: transcript, transcript_offset: 0 },
      { transcript_path: transcript, hwm_offset: statSync(transcript).size },
    ]);
    const pathHash = sha256(transcript);
    writeFileSync(join(fixture.dead, `${'a'.repeat(64)}.json`), JSON.stringify({
      metadata: {
        session_id: sessionId,
        offset: { start: 0, end: spoolSize },
        source: { path_hash: pathHash, start: 0, end: statSync(transcript).size },
      },
    }), { mode: 0o600 });
    const output = join(fixture.root, 'manifest.json');

    const manifest = await auditAutoCaptureRecovery({
      spoolDir: fixture.spool,
      outputPath: output,
      now: new Date('2026-07-15T00:00:00.000Z'),
    });

    expect(manifest.would_replay).toBe(false);
    expect(manifest.entries[0]).toMatchObject({
      spool_kind: 'active',
      classifications: ['single_transcript_path', 'recoverable_single_path'],
      would_replay: false,
    });
    expect(manifest.entries[0].candidate_ranges).toEqual([{
      path_hash: pathHash,
      start: 0,
      end: statSync(transcript).size,
      source_exists: true,
    }]);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(output, 'utf8');
    expect(serialized).not.toContain(transcript);
    expect(serialized).not.toContain(fixture.spool);
  });

  it('marks mixed legacy paths and unknowable earlier chunk commits as ambiguous', async () => {
    const fixture = makeRoot();
    const parent = join(fixture.root, 'parent.transcript.jsonl');
    const child = join(fixture.root, 'child.transcript.jsonl');
    writeFileSync(parent, 'parent', { mode: 0o600 });
    writeFileSync(child, 'child', { mode: 0o600 });
    const sessionId = 'session-mixed';
    const spoolPath = join(fixture.project, `${sessionId}.jsonl.123.sealed`);
    const spoolSize = writeSpool(spoolPath, [
      { session_id: sessionId, transcript_path: parent, transcript_offset: 0 },
      { session_id: sessionId, transcript_path: child, transcript_offset: 0 },
      { transcript_path: parent, hwm_offset: 6 },
      { transcript_path: child, hwm_offset: 5 },
    ]);
    writeFileSync(join(fixture.dead, `${'b'.repeat(64)}.json`), JSON.stringify({
      metadata: {
        session_id: sessionId,
        offset: { start: 0, end: spoolSize },
        hwm_offset: { start: 0, end: 6 },
      },
    }), { mode: 0o600 });

    const manifest = await auditAutoCaptureRecovery({
      spoolDir: fixture.spool,
      outputPath: join(fixture.root, 'mixed-manifest.json'),
    });

    expect(manifest.entries[0].spool_kind).toBe('sealed');
    expect(manifest.entries[0].classifications).toEqual(expect.arrayContaining([
      'mixed_transcript_paths',
      'prior_chunk_commit_unknown',
    ]));
    expect(manifest.entries[0].candidate_ranges).toHaveLength(2);
    expect(manifest.entries[0].recommended_action).toContain('do not replay automatically');
  });

  it('classifies a missing transcript source without exposing its path', async () => {
    const fixture = makeRoot();
    const missing = join(fixture.root, 'missing.transcript.jsonl');
    const sessionId = 'session-missing';
    const spoolPath = join(fixture.project, `${sessionId}.jsonl`);
    const spoolSize = writeSpool(spoolPath, [
      { session_id: sessionId, transcript_path: missing, transcript_offset: 0 },
      { transcript_path: missing, hwm_offset: 42 },
    ]);
    writeFileSync(join(fixture.dead, `${'c'.repeat(64)}.json`), JSON.stringify({
      metadata: {
        session_id: sessionId,
        offset: { start: 0, end: spoolSize },
        source: { path_hash: sha256(missing), start: 0, end: 42 },
      },
    }), { mode: 0o600 });
    const output = join(fixture.root, 'missing-manifest.json');

    const manifest = await auditAutoCaptureRecovery({ spoolDir: fixture.spool, outputPath: output });

    expect(manifest.entries[0].classifications).toEqual(expect.arrayContaining(['source_missing']));
    expect(manifest.entries[0].candidate_ranges[0].source_exists).toBe(false);
    expect(readFileSync(output, 'utf8')).not.toContain(missing);
    expect(manifest.entries[0].would_replay).toBe(false);
  });

  it('does not associate a dead letter with another session sentinel-only record', async () => {
    const fixture = makeRoot();
    const unrelated = join(fixture.root, 'unrelated.transcript.jsonl');
    const target = join(fixture.root, 'target.transcript.jsonl');
    writeFileSync(unrelated, 'unrelated', { mode: 0o600 });
    writeFileSync(target, 'target', { mode: 0o600 });
    writeSpool(join(fixture.project, 'a-unrelated.jsonl'), [
      { session_id: 'unrelated-session', transcript_path: unrelated, transcript_offset: 0 },
      { transcript_path: unrelated, hwm_offset: 9 },
    ]);
    const targetProject = join(fixture.spool, 'project-b');
    mkdirSync(targetProject, { recursive: true, mode: 0o700 });
    writeSpool(join(targetProject, 'target-session.jsonl'), [
      { session_id: 'target-session', transcript_path: target, transcript_offset: 0 },
      { transcript_path: target, hwm_offset: 6 },
    ]);
    writeFileSync(join(fixture.dead, `${'d'.repeat(64)}.json`), JSON.stringify({
      metadata: {
        project_id: 'project-b',
        session_id: 'target-session',
        hwm_offset: { start: 0, end: 6 },
      },
    }), { mode: 0o600 });

    const manifest = await auditAutoCaptureRecovery({
      spoolDir: fixture.spool,
      outputPath: join(fixture.root, 'session-match.json'),
    });

    expect(manifest.entries[0].candidate_ranges).toEqual([{
      path_hash: sha256(target),
      start: 0,
      end: 6,
      source_exists: true,
    }]);
  });

  it('forces an existing manifest output back to mode 0600', async () => {
    const fixture = makeRoot();
    const output = join(fixture.root, 'existing-manifest.json');
    writeFileSync(output, '{}', { mode: 0o666 });
    const { chmodSync } = await import('node:fs');
    chmodSync(output, 0o666);

    await auditAutoCaptureRecovery({ spoolDir: fixture.spool, outputPath: output });

    expect(statSync(output).mode & 0o777).toBe(0o600);
  });
});
