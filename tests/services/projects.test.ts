// tests/services/projects.test.ts
//
// Stage 0.5：services/projects.ts 五層 resolveProjectId + listProjects + projectExists
//
// 5 層優先序：explicit > env CC_MEMORY_PROJECT_ID > CLAUDE.md marker > repo_name (owner/repo) > basename(cwd)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  resolveProjectId,
  listProjects,
  projectExists,
} from '../../src/services/projects.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

describe('resolveProjectId (5-layer priority)', () => {
  const originalEnv = process.env.CC_MEMORY_PROJECT_ID;

  beforeEach(() => {
    delete process.env.CC_MEMORY_PROJECT_ID;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CC_MEMORY_PROJECT_ID;
    else process.env.CC_MEMORY_PROJECT_ID = originalEnv;
  });

  it('layer 1: explicit argument wins over everything', () => {
    process.env.CC_MEMORY_PROJECT_ID = 'from-env';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj1-'));
    try {
      writeFileSync(
        join(dir, 'CLAUDE.md'),
        '<!-- cc-memory: project="from-marker" -->'
      );
      const id = resolveProjectId({ explicit: 'from-explicit', cwd: dir });
      expect(id).toBe('from-explicit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 2: env CC_MEMORY_PROJECT_ID wins over marker / repo / basename', () => {
    process.env.CC_MEMORY_PROJECT_ID = 'from-env';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj2-'));
    try {
      writeFileSync(
        join(dir, 'CLAUDE.md'),
        '<!-- cc-memory: project="from-marker" -->'
      );
      const id = resolveProjectId({ cwd: dir });
      expect(id).toBe('from-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 3: CLAUDE.md marker wins over repo_name / basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj3-'));
    try {
      writeFileSync(
        join(dir, 'CLAUDE.md'),
        '<!-- cc-memory: project="from-marker" -->'
      );
      // 也建 git origin，確保 marker 優先於 repo_name
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
      execFileSync(
        'git',
        ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git'],
        { stdio: 'pipe' }
      );
      const id = resolveProjectId({ cwd: dir });
      expect(id).toBe('from-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 4: repo_name (owner/repo) wins over basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj4-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
      execFileSync(
        'git',
        ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/owner/myrepo.git'],
        { stdio: 'pipe' }
      );
      const id = resolveProjectId({ cwd: dir });
      expect(id).toBe('owner/myrepo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 5: basename(cwd) as last resort', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj5-'));
    try {
      const id = resolveProjectId({ cwd: dir });
      // basename of the temp dir path
      const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      expect(id).toBe(parts[parts.length - 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 2 empty string does NOT win (falls through)', () => {
    process.env.CC_MEMORY_PROJECT_ID = '';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj2e-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '<!-- cc-memory: project="from-marker" -->');
      const id = resolveProjectId({ cwd: dir });
      expect(id).toBe('from-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layer 2 whitespace only does NOT win', () => {
    process.env.CC_MEMORY_PROJECT_ID = '   ';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-proj2w-'));
    try {
      const id = resolveProjectId({ cwd: dir });
      const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
      expect(id).toBe(parts[parts.length - 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --------- Codex review round 20 P1：cwdIsExplicit 跳過 env layer ---------
  it('cwdIsExplicit=true → env 被跳過，改用 path-derived marker/repo/basename', () => {
    // caller 明示送 path + server 也有 env 時，path 勝出
    process.env.CC_MEMORY_PROJECT_ID = 'from-env-should-be-ignored';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-explicit-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '<!-- cc-memory: project="from-marker" -->');
      const id = resolveProjectId({ cwd: dir, cwdIsExplicit: true });
      expect(id).toBe('from-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cwdIsExplicit=false（預設）→ env 仍 override path-derived', () => {
    process.env.CC_MEMORY_PROJECT_ID = 'from-env';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-nonexplicit-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '<!-- cc-memory: project="from-marker" -->');
      const id = resolveProjectId({ cwd: dir });
      expect(id).toBe('from-env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cwdIsExplicit=true 且 explicit project_id 也傳 → explicit 仍勝出（layer 1 不受影響）', () => {
    process.env.CC_MEMORY_PROJECT_ID = 'from-env';
    const dir = mkdtempSync(join(tmpdir(), 'cc-memory-both-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '<!-- cc-memory: project="from-marker" -->');
      const id = resolveProjectId({ explicit: 'from-caller', cwd: dir, cwdIsExplicit: true });
      expect(id).toBe('from-caller');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listProjects / projectExists (DB integration)', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const testPrefix = `projsvc-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    db = drizzle(
      postgres(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test', {
        max: 1,
      })
    );
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM project_memories WHERE project_id LIKE ${testPrefix + '%'}`;
    await sql`DELETE FROM tasks WHERE project_id LIKE ${testPrefix + '%'}`;
  });

  it('listProjects returns union of memories and tasks', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${testPrefix + '-A'}, 'session', 's')`;
    await sql`INSERT INTO tasks (project_id, title) VALUES (${testPrefix + '-B'}, 't')`;
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${testPrefix + '-A'}, 'decision', 's2')`;

    const projects = await listProjects(db);
    expect(projects).toContain(testPrefix + '-A');
    expect(projects).toContain(testPrefix + '-B');
    // dedup 檢查
    const countA = projects.filter((p) => p === testPrefix + '-A').length;
    expect(countA).toBe(1);
  });

  it('listProjects excludes archived memories and cancelled tasks only from their own source', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary, status) VALUES (${testPrefix + '-C'}, 'session', 's', 'archived')`;
    await sql`INSERT INTO tasks (project_id, title, status) VALUES (${testPrefix + '-C'}, 't', 'cancelled')`;
    const projects = await listProjects(db);
    expect(projects).not.toContain(testPrefix + '-C');
  });

  it('projectExists returns true when memories row exists', async () => {
    await sql`INSERT INTO project_memories (project_id, type, summary) VALUES (${testPrefix + '-D'}, 'session', 's')`;
    expect(await projectExists(db, testPrefix + '-D')).toBe(true);
  });

  it('projectExists returns true when only tasks row exists', async () => {
    await sql`INSERT INTO tasks (project_id, title) VALUES (${testPrefix + '-E'}, 't')`;
    expect(await projectExists(db, testPrefix + '-E')).toBe(true);
  });

  it('projectExists returns false when no rows anywhere', async () => {
    expect(await projectExists(db, testPrefix + '-NONE')).toBe(false);
  });
});
