// tests/services/transcript-source.test.ts
//
// 對話檔來源退路契約：原檔優先；原檔不在才讀 `<path>.zst`；壞檔、symlink、兩者皆無 → null。

import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compressedTranscriptPath,
  readCompressedTranscript,
  readTranscriptSource,
  transcriptSourceLength,
} from '../../src/services/transcript-source.js';

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ccm-transcript-source-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readTranscriptSource', () => {
  it('prefers the plain file when both exist', async () => {
    const root = makeRoot();
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, 'plain\n');
    writeFileSync(compressedTranscriptPath(path), zstdCompressSync(Buffer.from('compressed\n')));
    expect((await readTranscriptSource(path))?.toString('utf8')).toBe('plain\n');
    expect(await transcriptSourceLength(path)).toBe(6);
  });

  it('falls back to <path>.zst when the plain file is gone and returns decompressed bytes', async () => {
    const root = makeRoot();
    const path = join(root, 'rollout.jsonl');
    const body = `${JSON.stringify({ type: 'session_meta', cwd: '/home/x/repo' })}\n${'y'.repeat(5000)}\n`;
    writeFileSync(path, body);
    writeFileSync(compressedTranscriptPath(path), zstdCompressSync(Buffer.from(body)));
    unlinkSync(path);
    expect((await readTranscriptSource(path))?.toString('utf8')).toBe(body);
    expect(await transcriptSourceLength(path)).toBe(Buffer.byteLength(body));
  });

  it('returns null when neither file exists, when the .zst is corrupt, or when the .zst is a symlink', async () => {
    const root = makeRoot();
    const missing = join(root, 'missing.jsonl');
    expect(await readTranscriptSource(missing)).toBeNull();
    expect(await transcriptSourceLength(missing)).toBeNull();

    const corrupt = join(root, 'corrupt.jsonl');
    writeFileSync(compressedTranscriptPath(corrupt), Buffer.from('not a zstd frame'));
    expect(await readTranscriptSource(corrupt)).toBeNull();

    const linked = join(root, 'linked.jsonl');
    const real = join(root, 'real.zst');
    writeFileSync(real, zstdCompressSync(Buffer.from('via symlink\n')));
    symlinkSync(real, compressedTranscriptPath(linked));
    expect(await readCompressedTranscript(linked)).toBeNull();
  });
});
