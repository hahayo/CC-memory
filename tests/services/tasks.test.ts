// tests/services/tasks.test.ts
//
// Stage 1 Track T：services/tasks.ts 全部方法
//
// 涵蓋：
//   - createTask 自動填 writer_host（env / os.hostname / 明示覆蓋）
//   - listTasks 預設排除 cancelled，含 writer_host
//   - updateTask optimistic locking + 狀態轉移矩陣（7 合法 + 1 禁止）
//   - resolveTaskByShortId prefix<6 throw / NOT_FOUND / FOUND / AMBIGUOUS（top 5）
//   - NotFoundError / StaleTaskError / InvalidTransitionError / InvalidArgumentError

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  resolveTaskByShortId,
} from '../../src/services/tasks.js';
import {
  InvalidTransitionError,
  StaleTaskError,
  NotFoundError,
  InvalidArgumentError,
  IdempotencyConflictError,
} from '../../src/services/errors.js';
import { connectTestDb, type Sql } from '../helpers/db.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/cc_memory_test';

describe('services/tasks — createTask / listTasks / getTask / updateTask / resolveTaskByShortId', () => {
  let sql: Sql;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  const testPrefix = `track-t-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = await connectTestDb();
    pg = postgres(TEST_DB_URL, { max: 1 });
    db = drizzle(pg);
  });

  afterAll(async () => {
    if (pg) await pg.end();
    if (sql) await sql.end();
  });

  afterEach(async () => {
    // 每個測試後清本 prefix 的 tasks（隔離）
    await sql`DELETE FROM tasks WHERE project_id LIKE 'track-t-%'`;
  });

  // ---------------------------------------------------------------------
  // createTask
  // ---------------------------------------------------------------------

  describe('createTask', () => {
    it('auto-fills writer_host via resolveWriterHost when not provided', async () => {
      const task = await createTask(db, {
        projectId: testPrefix + '-auto-host',
        title: 'auto host task',
      });
      expect(task.id).toBeDefined();
      expect(task.writerHost).toBeTruthy();
      expect(typeof task.writerHost).toBe('string');
      expect((task.writerHost as string).length).toBeGreaterThan(0);
    });

    it('honours explicit writerHost override', async () => {
      const task = await createTask(db, {
        projectId: testPrefix + '-custom-host',
        title: 'custom host task',
        writerHost: 'custom-host-xyz',
      });
      expect(task.writerHost).toBe('custom-host-xyz');
    });

    it('applies defaults: status=open, priority=normal, source=manual, tags=[]', async () => {
      const task = await createTask(db, {
        projectId: testPrefix + '-defaults',
        title: 'defaults task',
      });
      expect(task.status).toBe('open');
      expect(task.priority).toBe('normal');
      expect(task.source).toBe('manual');
      expect(task.tags).toEqual([]);
    });

    it('persists provided description / priority / tags / source / metadata', async () => {
      const task = await createTask(db, {
        projectId: testPrefix + '-full',
        title: 'full task',
        description: 'desc',
        priority: 'high',
        tags: ['a', 'b'],
        source: 'mcp',
        sourceRef: 'ref-1',
        metadata: { foo: 'bar' },
      });
      expect(task.description).toBe('desc');
      expect(task.priority).toBe('high');
      expect(task.tags).toEqual(['a', 'b']);
      expect(task.source).toBe('mcp');
      expect(task.sourceRef).toBe('ref-1');
      expect(task.metadata).toEqual({ foo: 'bar' });
    });
  });

  // ---------------------------------------------------------------------
  // listTasks
  // ---------------------------------------------------------------------

  describe('listTasks', () => {
    it('returns rows with writer_host populated', async () => {
      const proj = testPrefix + '-list-wh';
      await createTask(db, { projectId: proj, title: 't1' });
      await createTask(db, { projectId: proj, title: 't2', writerHost: 'w2' });

      const rows = await listTasks(db, { projectId: proj });
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.writerHost).toBeTruthy();
      }
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
      expect(byTitle['t2'].writerHost).toBe('w2');
    });

    it('excludes cancelled tasks by default', async () => {
      const proj = testPrefix + '-list-cancel';
      const a = await createTask(db, { projectId: proj, title: 'open-a' });
      const b = await createTask(db, { projectId: proj, title: 'to-cancel' });
      await updateTask(
        db,
        b.id,
        { status: 'cancelled' },
        { expectedStatus: 'open' }
      );

      const rows = await listTasks(db, { projectId: proj });
      expect(rows.map((r) => r.id)).toContain(a.id);
      expect(rows.map((r) => r.id)).not.toContain(b.id);
    });

    it('includes cancelled tasks when status explicitly requests them', async () => {
      const proj = testPrefix + '-list-cancel-explicit';
      const b = await createTask(db, { projectId: proj, title: 'to-cancel' });
      await updateTask(
        db,
        b.id,
        { status: 'cancelled' },
        { expectedStatus: 'open' }
      );

      const rows = await listTasks(db, { projectId: proj, status: 'cancelled' });
      expect(rows.map((r) => r.id)).toContain(b.id);
    });

    it('supports multiple statuses via array', async () => {
      const proj = testPrefix + '-list-multi';
      const a = await createTask(db, { projectId: proj, title: 'a' });
      const b = await createTask(db, { projectId: proj, title: 'b' });
      await updateTask(db, b.id, { status: 'in_progress' }, { expectedStatus: 'open' });

      const rows = await listTasks(db, {
        projectId: proj,
        status: ['open', 'in_progress'],
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('supports limit / offset pagination, ORDER BY created_at DESC', async () => {
      const proj = testPrefix + '-list-page';
      const titles: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await createTask(db, { projectId: proj, title: `t${i}` });
        titles.push(t.title);
        // 微延遲讓 created_at 嚴格遞增
        await new Promise((r) => setTimeout(r, 5));
      }

      const page1 = await listTasks(db, { projectId: proj, limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      // 最新建的 t4 應排第一
      expect(page1[0].title).toBe('t4');
      expect(page1[1].title).toBe('t3');

      const page2 = await listTasks(db, { projectId: proj, limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].title).toBe('t2');
    });
  });

  // ---------------------------------------------------------------------
  // getTask
  // ---------------------------------------------------------------------

  describe('getTask', () => {
    it('returns a task by id', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-get',
        title: 'get me',
      });
      const got = await getTask(db, t.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(t.id);
      expect(got!.title).toBe('get me');
    });

    it('returns null when task not found', async () => {
      const got = await getTask(db, randomUUID());
      expect(got).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // updateTask：狀態轉移矩陣
  // ---------------------------------------------------------------------

  describe('updateTask — status transitions (7 legal + 1 forbidden)', () => {
    async function createOpen(title = 'tr'): Promise<string> {
      const t = await createTask(db, {
        projectId: testPrefix + '-trans-' + randomUUID().slice(0, 6),
        title,
      });
      return t.id;
    }

    it('open → in_progress (completed_at stays null)', async () => {
      const id = await createOpen();
      const r = await updateTask(
        db,
        id,
        { status: 'in_progress' },
        { expectedStatus: 'open' }
      );
      expect(r.status).toBe('in_progress');
      expect(r.completedAt).toBeNull();
    });

    it('open → done (completed_at set)', async () => {
      const id = await createOpen();
      const r = await updateTask(
        db,
        id,
        { status: 'done' },
        { expectedStatus: 'open' }
      );
      expect(r.status).toBe('done');
      expect(r.completedAt).not.toBeNull();
    });

    it('open → cancelled', async () => {
      const id = await createOpen();
      const r = await updateTask(
        db,
        id,
        { status: 'cancelled' },
        { expectedStatus: 'open' }
      );
      expect(r.status).toBe('cancelled');
    });

    it('in_progress → done (completed_at set)', async () => {
      const id = await createOpen();
      await updateTask(db, id, { status: 'in_progress' }, { expectedStatus: 'open' });
      const r = await updateTask(
        db,
        id,
        { status: 'done' },
        { expectedStatus: 'in_progress' }
      );
      expect(r.status).toBe('done');
      expect(r.completedAt).not.toBeNull();
    });

    it('in_progress → cancelled', async () => {
      const id = await createOpen();
      await updateTask(db, id, { status: 'in_progress' }, { expectedStatus: 'open' });
      const r = await updateTask(
        db,
        id,
        { status: 'cancelled' },
        { expectedStatus: 'in_progress' }
      );
      expect(r.status).toBe('cancelled');
    });

    it('done → open (clears completed_at)', async () => {
      const id = await createOpen();
      const done = await updateTask(
        db,
        id,
        { status: 'done' },
        { expectedStatus: 'open' }
      );
      expect(done.completedAt).not.toBeNull();

      const reopened = await updateTask(
        db,
        id,
        { status: 'open' },
        { expectedStatus: 'done' }
      );
      expect(reopened.status).toBe('open');
      expect(reopened.completedAt).toBeNull();
    });

    it('cancelled → open', async () => {
      const id = await createOpen();
      await updateTask(db, id, { status: 'cancelled' }, { expectedStatus: 'open' });
      const r = await updateTask(
        db,
        id,
        { status: 'open' },
        { expectedStatus: 'cancelled' }
      );
      expect(r.status).toBe('open');
    });

    it('done → in_progress throws InvalidTransitionError (must go via open)', async () => {
      const id = await createOpen();
      await updateTask(db, id, { status: 'done' }, { expectedStatus: 'open' });
      await expect(
        updateTask(db, id, { status: 'in_progress' }, { expectedStatus: 'done' })
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    });
  });

  // ---------------------------------------------------------------------
  // updateTask：optimistic locking + NotFound
  // ---------------------------------------------------------------------

  describe('updateTask — optimistic locking / not found', () => {
    it('throws StaleTaskError when expectedStatus does not match current', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-stale',
        title: 'stale test',
      });
      // 把它推到 in_progress
      await updateTask(db, t.id, { status: 'in_progress' }, { expectedStatus: 'open' });
      // 再用 expectedStatus='open' 試 update → stale
      await expect(
        updateTask(db, t.id, { title: 'new title' }, { expectedStatus: 'open' })
      ).rejects.toBeInstanceOf(StaleTaskError);
    });

    it('throws NotFoundError when id does not exist', async () => {
      await expect(
        updateTask(
          db,
          randomUUID(),
          { title: 'never' },
          { expectedStatus: 'open' }
        )
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('updates non-status fields when no status change (same expectedStatus)', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-nochange',
        title: 'old',
      });
      const r = await updateTask(
        db,
        t.id,
        { title: 'new' },
        { expectedStatus: 'open' }
      );
      expect(r.title).toBe('new');
      expect(r.status).toBe('open');
    });
  });

  // ---------------------------------------------------------------------
  // resolveTaskByShortId
  // ---------------------------------------------------------------------

  describe('resolveTaskByShortId', () => {
    it('throws InvalidArgumentError when prefix < 6 chars', async () => {
      await expect(
        resolveTaskByShortId(db, 'abc', testPrefix + '-short')
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('returns NOT_FOUND when no task matches prefix', async () => {
      const proj = testPrefix + '-nf';
      await createTask(db, { projectId: proj, title: 't' });
      // 合理不可能命中的 6-char prefix（uuid 只有 0-9a-f）
      const result = await resolveTaskByShortId(db, 'zzzzzz', proj);
      expect(result.kind).toBe('NOT_FOUND');
    });

    it('returns FOUND when exactly one task matches prefix', async () => {
      const proj = testPrefix + '-one';
      const t = await createTask(db, { projectId: proj, title: 'only one' });
      const prefix = t.id.slice(0, 8);
      const result = await resolveTaskByShortId(db, prefix, proj);
      expect(result.kind).toBe('FOUND');
      if (result.kind === 'FOUND') {
        expect(result.task.id).toBe(t.id);
      }
    });

    it('returns AMBIGUOUS (top 5 by updated_at DESC) when > 1 matches', async () => {
      const proj = testPrefix + '-ambig';
      // 尋一個能「製造碰撞」的方式：我們無法預測 uuid prefix，所以
      // 直接 INSERT 我們可控的 uuid，讓前 6 字元共享同 prefix。
      const sharedPrefix = 'abcdef';
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        // uuid v4 格式：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        // 為了 CHECK 合法，我們造符合 uuid 格式的字串，前 6 字元皆 'abcdef'
        const tail = randomUUID().slice(8);
        const id = `${sharedPrefix}${Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0')}${tail}`;
        // 直接 SQL insert（繞過 createTask 讓我們控 id）
        await sql`
          INSERT INTO tasks (id, project_id, title)
          VALUES (${id}, ${proj}, ${'t-' + i})
        `;
        ids.push(id);
        // 確保 updated_at 嚴格遞增，方便斷言 top 5 順序
        await new Promise((r) => setTimeout(r, 5));
        await sql`UPDATE tasks SET updated_at = NOW() WHERE id = ${id}`;
      }

      const result = await resolveTaskByShortId(db, sharedPrefix, proj);
      expect(result.kind).toBe('AMBIGUOUS');
      if (result.kind === 'AMBIGUOUS') {
        // 最多 5 筆（我們插了 6 筆，遠超 prefix 可命中上限）
        expect(result.candidates.length).toBe(5);
        // 按 updated_at DESC：最後一筆（ids[5]）應該在最前
        expect(result.candidates[0].id).toBe(ids[5]);
        expect(result.candidates[1].id).toBe(ids[4]);
      }
    });

    it('does not leak cross-project matches (project_id isolated)', async () => {
      const projA = testPrefix + '-isoA';
      const projB = testPrefix + '-isoB';
      const t = await createTask(db, { projectId: projA, title: 'A-task' });
      const prefix = t.id.slice(0, 8);
      const result = await resolveTaskByShortId(db, prefix, projB);
      expect(result.kind).toBe('NOT_FOUND');
    });

    // --------- Codex review round 3 finding #2：uppercase prefix ---------
    it('uppercase hex prefix matches lowercase uuid via toLowerCase sanitize', async () => {
      const proj = testPrefix + '-upper';
      const t = await createTask(db, { projectId: proj, title: 'case-test' });
      const lowerPrefix = t.id.slice(0, 8);
      const upperPrefix = lowerPrefix.toUpperCase();
      // uuid 是隨機的，若恰好全是 digits 就略過（toUpperCase 無差異）
      if (upperPrefix === lowerPrefix) return;

      const result = await resolveTaskByShortId(db, upperPrefix, proj);
      expect(result.kind).toBe('FOUND');
      if (result.kind === 'FOUND') {
        expect(result.task.id).toBe(t.id);
      }
    });
  });

  // --------- Codex review round 14 P2：listTasks status=[] 不該 IN () ---------
  describe('listTasks empty status array', () => {
    it('status=[] 視為預設過濾（排除 cancelled），不生 IN () 無效 SQL', async () => {
      const proj = testPrefix + '-emptystatus';
      await createTask(db, { projectId: proj, title: 'open-t' });
      await createTask(db, { projectId: proj, title: 'done-t', status: 'done' });
      await createTask(db, { projectId: proj, title: 'cancel-t', status: 'cancelled' });

      const rows = await listTasks(db, { projectId: proj, status: [] });
      // 預設排除 cancelled → 2 筆（open + done）
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.title).sort()).toEqual(['done-t', 'open-t']);
    });

    it('status=[\'open\'] 只回 open', async () => {
      const proj = testPrefix + '-onestatus';
      await createTask(db, { projectId: proj, title: 'o1' });
      await createTask(db, { projectId: proj, title: 'd1', status: 'done' });
      const rows = await listTasks(db, { projectId: proj, status: ['open'] });
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe('o1');
    });

    it('status=[\'bogus\'] → InvalidArgumentError（不進 DB）', async () => {
      await expect(
        listTasks(db, { projectId: testPrefix + '-bogus', status: ['bogus' as never] })
      ).rejects.toThrow(InvalidArgumentError);
    });
  });

  // --------- Codex review round 9 findings：enum / empty idempotency_key ---------
  describe('input validation (round 9)', () => {
    it('createTask 空字串 idempotency_key 視為 undefined（不污染 unique）', async () => {
      const proj = testPrefix + '-emptykey';
      const t1 = await createTask(db, { projectId: proj, title: 'a', idempotencyKey: '' });
      const t2 = await createTask(db, { projectId: proj, title: 'b', idempotencyKey: '' });
      expect(t1.id).not.toBe(t2.id);
      expect(t1.idempotencyKey).toBeNull();
      expect(t2.idempotencyKey).toBeNull();
    });

    it('createTask whitespace-only idempotency_key 視為 undefined', async () => {
      const proj = testPrefix + '-wskey';
      const t1 = await createTask(db, { projectId: proj, title: 'a', idempotencyKey: '   ' });
      const t2 = await createTask(db, { projectId: proj, title: 'b', idempotencyKey: '\t\n' });
      expect(t1.id).not.toBe(t2.id);
    });

    it('createTask 無效 status → InvalidArgumentError（非 INTERNAL）', async () => {
      await expect(
        createTask(db, {
          projectId: testPrefix + '-bad',
          title: 'x',
          status: 'paused' as never,
        })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('createTask 無效 priority → InvalidArgumentError', async () => {
      await expect(
        createTask(db, {
          projectId: testPrefix + '-bad',
          title: 'x',
          priority: 'urgent' as never,
        })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('createTask 無效 source → InvalidArgumentError', async () => {
      await expect(
        createTask(db, {
          projectId: testPrefix + '-bad',
          title: 'x',
          source: 'slack' as never,
        })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('updateTask 無效 status → InvalidArgumentError（不被當 INVALID_TRANSITION）', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-up', title: 'x' });
      await expect(
        updateTask(db, t.id, { status: 'paused' as never }, { expectedStatus: 'open' })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('updateTask 無效 priority → InvalidArgumentError（不落到 DB INTERNAL）', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-up2', title: 'x' });
      await expect(
        updateTask(db, t.id, { priority: 'urgent' as never }, { expectedStatus: 'open' })
      ).rejects.toThrow(InvalidArgumentError);
    });
  });

  // --------- Codex review round 8 finding #2：title length pre-validation ---------
  describe('title length validation (service layer pre-check)', () => {
    it('createTask 空 title → InvalidArgumentError（不落到 DB CHECK）', async () => {
      await expect(
        createTask(db, { projectId: testPrefix + '-tlen', title: '' })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('createTask title > 500 字 → InvalidArgumentError', async () => {
      const tooLong = 'x'.repeat(501);
      await expect(
        createTask(db, { projectId: testPrefix + '-tlen', title: tooLong })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('createTask title = 500 字 → 成功', async () => {
      const maxTitle = 'x'.repeat(500);
      const t = await createTask(db, { projectId: testPrefix + '-tlen', title: maxTitle });
      expect(t.title).toBe(maxTitle);
    });

    it('updateTask patch.title 超長 → InvalidArgumentError（不落到 DB）', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-tlen2', title: 'ok' });
      await expect(
        updateTask(db, t.id, { title: 'x'.repeat(501) }, { expectedStatus: 'open' })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('updateTask patch.title 空字串 → InvalidArgumentError', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-tlen3', title: 'ok' });
      await expect(
        updateTask(db, t.id, { title: '' }, { expectedStatus: 'open' })
      ).rejects.toThrow(InvalidArgumentError);
    });
  });

  // --------- Codex review round 5 finding #1：updateTask projectId scope ---------
  describe('updateTask project scope guard', () => {
    it('projectId mismatch → NotFoundError（不洩露存在性）', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-scopeA', title: 'locked' });
      await expect(
        updateTask(
          db,
          t.id,
          { status: 'done' },
          { expectedStatus: 'open', projectId: testPrefix + '-scopeB' }
        )
      ).rejects.toThrow(NotFoundError);
    });

    it('projectId matches → 正常更新', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-scopeC', title: 'ok' });
      const updated = await updateTask(
        db,
        t.id,
        { status: 'done' },
        { expectedStatus: 'open', projectId: testPrefix + '-scopeC' }
      );
      expect(updated.status).toBe('done');
    });

    it('projectId undefined → 不做 scope 檢查（向後相容）', async () => {
      const t = await createTask(db, { projectId: testPrefix + '-scopeD', title: 'ok' });
      const updated = await updateTask(db, t.id, { status: 'done' }, { expectedStatus: 'open' });
      expect(updated.status).toBe('done');
    });
  });

  // --------- Codex review round 2 finding：createTask + updateTask completed_at ----------
  describe('completed_at lifecycle (round 2 fix)', () => {
    it('createTask with status=done auto-sets completed_at', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-cdone',
        title: 'already done',
        status: 'done',
      });
      expect(t.completedAt).not.toBeNull();
      expect(t.completedAt).toBeInstanceOf(Date);
    });

    it('createTask with default status=open keeps completed_at null', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-copen',
        title: 'open',
      });
      expect(t.completedAt).toBeNull();
    });

    it('updateTask no-op done→done does NOT reset completed_at', async () => {
      // 直接建一筆 done task（completed_at 會自動填）
      const t = await createTask(db, {
        projectId: testPrefix + '-noop',
        title: 'x',
        status: 'done',
      });
      const originalCompleted = t.completedAt!;
      // 稍等一個 tick 再更新，確保如果 bug 存在會看到時間差
      await new Promise((r) => setTimeout(r, 50));

      const updated = await updateTask(
        db,
        t.id,
        { status: 'done', title: 'x (updated)' },
        { expectedStatus: 'done' }
      );

      expect(updated.title).toBe('x (updated)');
      // completed_at 必須維持原時間（ms 級比對）
      expect(updated.completedAt?.getTime()).toBe(originalCompleted.getTime());
    });

    it('updateTask real transition in_progress→done sets completed_at', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-tip',
        title: 'working',
        status: 'in_progress',
      });
      expect(t.completedAt).toBeNull();

      const updated = await updateTask(
        db,
        t.id,
        { status: 'done' },
        { expectedStatus: 'in_progress' }
      );
      expect(updated.completedAt).not.toBeNull();
      expect(updated.completedAt).toBeInstanceOf(Date);
    });

    it('updateTask done→open clears completed_at', async () => {
      const t = await createTask(db, {
        projectId: testPrefix + '-reopen',
        title: 'will reopen',
        status: 'done',
      });
      expect(t.completedAt).not.toBeNull();

      const updated = await updateTask(
        db,
        t.id,
        { status: 'open' },
        { expectedStatus: 'done' }
      );
      expect(updated.completedAt).toBeNull();
    });
  });

  // --------- Codex review round 1 finding #3：重複 idempotency_key ----------
  describe('createTask idempotency_key duplicate handling', () => {
    it('duplicate idempotency_key → throws IdempotencyConflictError (非 INTERNAL)', async () => {
      const proj = testPrefix + '-idemp';
      const key = `idem-${randomUUID()}`;
      await createTask(db, {
        projectId: proj,
        title: 'first',
        idempotencyKey: key,
      });
      await expect(
        createTask(db, {
          projectId: proj,
          title: 'second (different payload)',
          idempotencyKey: key,
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    // --------- Codex review round 15 P1：task idempotency scope by project ---------
    it('same idempotency_key + different projects → 兩個 task 各自成功（cross-project 不衝突）', async () => {
      const key = `idem-tasks-xp-${randomUUID()}`;
      const t1 = await createTask(db, {
        projectId: testPrefix + '-tA',
        title: 'in proj A',
        idempotencyKey: key,
      });
      const t2 = await createTask(db, {
        projectId: testPrefix + '-tB',
        title: 'in proj B',
        idempotencyKey: key,
      });
      expect(t1.id).not.toBe(t2.id);
      expect(t1.projectId).not.toBe(t2.projectId);
    });

    it('different idempotency_keys → both succeed', async () => {
      const proj = testPrefix + '-idemp2';
      const t1 = await createTask(db, {
        projectId: proj,
        title: 'a',
        idempotencyKey: `idem-${randomUUID()}`,
      });
      const t2 = await createTask(db, {
        projectId: proj,
        title: 'b',
        idempotencyKey: `idem-${randomUUID()}`,
      });
      expect(t1.id).not.toBe(t2.id);
    });
  });
});
