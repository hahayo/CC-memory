// tests/utils/repo-name.test.ts
import { describe, it, expect } from 'vitest';
import { parseRepoOwnerRepoFromRemoteUrl, resolveRepoName } from '../../src/utils/repo-name.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseRepoOwnerRepoFromRemoteUrl', () => {
  it('parses https URL with .git suffix', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('https://github.com/hahayo/CC-memory.git'))
      .toBe('hahayo/CC-memory');
  });

  it('parses https URL without .git suffix', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('https://github.com/hahayo/CC-memory'))
      .toBe('hahayo/CC-memory');
  });

  it('parses git ssh URL', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('git@github.com:hahayo/CC-memory.git'))
      .toBe('hahayo/CC-memory');
  });

  it('parses git ssh URL without .git suffix', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('git@github.com:hahayo/CC-memory'))
      .toBe('hahayo/CC-memory');
  });

  it('handles owner with hyphen', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('https://github.com/my-org/my-repo.git'))
      .toBe('my-org/my-repo');
  });

  it('handles GitLab style paths (uses last two segments)', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('https://gitlab.com/group/sub/repo.git'))
      .toBe('sub/repo');
  });

  it('returns null for unparseable URL', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('not a url')).toBeNull();
  });

  // --------- Codex review round 6 P2：local-path remote 不可假裝成 owner/repo ---------
  it('returns null for absolute local path remote', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('/srv/git/CC-memory.git')).toBeNull();
  });

  it('returns null for relative local path remote', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('../mirror/CC-memory.git')).toBeNull();
  });

  it('returns null for bare directory remote', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('./foo/bar')).toBeNull();
  });

  it('parses ssh:// URL', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('ssh://git@github.com/hahayo/CC-memory.git'))
      .toBe('hahayo/CC-memory');
  });

  it('returns null for empty string', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('')).toBeNull();
  });

  it('returns null for single segment path', () => {
    expect(parseRepoOwnerRepoFromRemoteUrl('https://example.com/repo')).toBeNull();
  });
});

describe('resolveRepoName (integration with git)', () => {
  it('returns null for non-git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-nogit-'));
    try {
      expect(resolveRepoName(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for git repo with no origin remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-norem-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
      expect(resolveRepoName(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns owner/repo when origin remote is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-origin-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
      execFileSync(
        'git',
        ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/hahayo/CC-memory.git'],
        { stdio: 'pipe' }
      );
      expect(resolveRepoName(dir)).toBe('hahayo/CC-memory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers origin over upstream when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-multi-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
      execFileSync(
        'git',
        ['-C', dir, 'remote', 'add', 'upstream', 'https://github.com/upstream-org/CC-memory.git'],
        { stdio: 'pipe' }
      );
      execFileSync(
        'git',
        ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/forker/CC-memory.git'],
        { stdio: 'pipe' }
      );
      expect(resolveRepoName(dir)).toBe('forker/CC-memory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
