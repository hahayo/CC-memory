// tests/scripts/delete-personal-data.test.ts
//
// delete script integration test（P0 修復核心；兩個真 test DB）：
//   project 側 cc_memory_test（無 0007）/ personal 側 cc_memory_test_personal（0000-0007）
//   由 scripts/test-db-setup.ts 建立。
//
// seed 矩陣（plan Batch 5）：個人列、非個人列、search_feedback 混合列
// （query_project_id IS NULL AND '__personal__'=ANY(result_project_ids)——最易漏刪，
// Codex B10）、非空 jsonb metadata、微秒 timestamp。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_DB_URL,
  TEST_PERSONAL_DB_URL,
  connectDb,
  resetAllTables,
  type Sql,
} from '../helpers/db.js';
import {
  DeleteAbortError,
  runDeletePersonalData,
} from '../../scripts/delete-personal-data.js';

const PERSONAL = '__personal__';
const noLog = () => {};

let project: Sql;
let personal: Sql;

// 個人列三件組（兩側 DB 完全相同——含微秒 ts、非空 jsonb、created_at 顯式值，
// checksum 比對要求 byte-identical）
async function seedIdenticalPersonalRows(): Promise<void> {
  const taskId = randomUUID();
  const memId = randomUUID();
  const logId = randomUUID();
  for (const db of [project, personal]) {
    await db`
      INSERT INTO tasks (id, project_id, title, status, priority, tags, source,
                         remind_at, created_at, updated_at, metadata)
      VALUES (${taskId}, ${PERSONAL}, 'personal task', 'open', 'high', ARRAY['p-tag'], 'manual',
              '2026-06-15T08:09:10.123456+00'::timestamptz,
              '2026-05-01T00:00:00.000111+00'::timestamptz,
              '2026-05-01T00:00:00.000111+00'::timestamptz,
              '{"nested": {"deep": true}, "中文": "值"}'::jsonb)
    `;
    await db`
      INSERT INTO project_memories (id, project_id, type, summary, keywords, status,
                                    metadata, created_at, updated_at)
      VALUES (${memId}, ${PERSONAL}, 'decision', 'personal memory', ARRAY['kw'], 'active',
              '{"refs": [{"f": "a.ts"}]}'::jsonb,
              '2026-05-02T00:00:00.000222+00'::timestamptz,
              '2026-05-02T00:00:00.000222+00'::timestamptz)
    `;
    await db`
      INSERT INTO reminder_log (id, task_id, scheduled_for, fired_at, channel, writer_host)
      VALUES (${logId}, ${taskId}, '2026-06-15T08:09:10.123456+00'::timestamptz,
              '2026-06-15T08:09:11.999999+00'::timestamptz, 'hermes', 'test-host')
    `;
  }
}

// 非個人列（只在 project DB）＋ search_feedback 三型（個人 query / 混合 / 純專案）
async function seedProjectOnlyRows(): Promise<void> {
  const projTaskId = randomUUID();
  await project`
    INSERT INTO tasks (id, project_id, title) VALUES (${projTaskId}, 'proj-x', 'project task')
  `;
  await project`
    INSERT INTO project_memories (project_id, type, summary) VALUES ('proj-x', 'session', 'project memory')
  `;
  await project`
    INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${projTaskId}, now())
  `;
  // search_feedback：row1 個人 query；row2 混合列（query NULL + result 含 personal）；row3 純專案
  await project`
    INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                 result_ids, result_project_ids, rank_positions)
    VALUES ('q-personal', 'mcp', ${PERSONAL}, 'keyword', 5,
            ${[randomUUID()]}::uuid[], ${[PERSONAL]}::text[], ${[1]}::int[])
  `;
  await project`
    INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                 result_ids, result_project_ids, rank_positions)
    VALUES ('q-mixed', 'mcp', NULL, 'keyword', 5,
            ${[randomUUID(), randomUUID()]}::uuid[], ${[PERSONAL, 'proj-x']}::text[], ${[1, 2]}::int[])
  `;
  await project`
    INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                 result_ids, result_project_ids, rank_positions)
    VALUES ('q-project', 'mcp', 'proj-x', 'keyword', 5,
            ${[randomUUID()]}::uuid[], ${['proj-x']}::text[], ${[1]}::int[])
  `;
}

async function countAll(db: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of ['project_memories', 'tasks', 'reminder_log', 'search_feedback']) {
    const r = await db.unsafe(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = (r[0] as { n: number }).n;
  }
  return counts;
}

beforeAll(async () => {
  project = await connectDb(TEST_DB_URL);
  personal = await connectDb(TEST_PERSONAL_DB_URL);
});

afterAll(async () => {
  await resetAllTables(project);
  await resetAllTables(personal);
  await project.end({ timeout: 5 });
  await personal.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetAllTables(project);
  await resetAllTables(personal);
  await seedIdenticalPersonalRows();
  await seedProjectOnlyRows();
});

describe('runDeletePersonalData', () => {
  it('dry-run（預設）：零寫入，manifest.executed=false', async () => {
    const before = await countAll(project);
    const manifest = await runDeletePersonalData({
      projectUrl: TEST_DB_URL,
      personalUrl: TEST_PERSONAL_DB_URL,
      execute: false,
      log: noLog,
      printManifest: false,
    });
    expect(manifest.executed).toBe(false);
    expect(manifest.tables.tasks.counted).toBe(1);
    expect(manifest.tables.search_feedback.counted).toBe(2); // 個人 query + 混合列
    expect(manifest.tables.search_feedback.copiedToPersonal).toBe(false);
    expect(await countAll(project)).toEqual(before); // 零寫入
  });

  it('--execute：個人列全清（含混合列）、非個人列原封、personal DB 不動', async () => {
    const personalBefore = await countAll(personal);
    const manifest = await runDeletePersonalData({
      projectUrl: TEST_DB_URL,
      personalUrl: TEST_PERSONAL_DB_URL,
      execute: true,
      log: noLog,
      printManifest: false,
    });

    expect(manifest.executed).toBe(true);
    expect(manifest.tables).toMatchObject({
      reminder_log: { counted: 1, deleted: 1, copiedToPersonal: true },
      tasks: { counted: 1, deleted: 1, copiedToPersonal: true },
      project_memories: { counted: 1, deleted: 1, copiedToPersonal: true },
      search_feedback: { counted: 2, deleted: 2, copiedToPersonal: false },
    });
    // checksum 比對通過（兩側 byte-identical seed）
    for (const t of ['project_memories', 'tasks', 'reminder_log']) {
      expect(manifest.checksums[t].project).toBe(manifest.checksums[t].personal);
    }

    // project DB：個人列 0、非個人列原封
    const after = await countAll(project);
    expect(after).toEqual({
      project_memories: 1, // 只剩 proj-x
      tasks: 1,
      reminder_log: 1,
      search_feedback: 1, // 只剩純專案列
    });
    const personalLeft = await project`SELECT 1 FROM tasks WHERE project_id = ${PERSONAL}`;
    expect(personalLeft).toHaveLength(0);
    const mixedLeft = await project`
      SELECT 1 FROM search_feedback WHERE ${PERSONAL} = ANY(result_project_ids)
    `;
    expect(mixedLeft).toHaveLength(0); // 混合列已刪（Codex B10）

    // personal DB 原封不動
    expect(await countAll(personal)).toEqual(personalBefore);
  });

  it('checksum mismatch → DeleteAbortError + project DB 原樣（ROLLBACK 語意）', async () => {
    // 弄出內容分歧：personal 側改 title（count 仍相等，checksum 不等——A3 要抓的 case）
    await personal`UPDATE tasks SET title = 'diverged' WHERE project_id = ${PERSONAL}`;
    const before = await countAll(project);

    await expect(
      runDeletePersonalData({
        projectUrl: TEST_DB_URL,
        personalUrl: TEST_PERSONAL_DB_URL,
        execute: true,
        log: noLog,
        printManifest: false,
      })
    ).rejects.toThrow(/checksum mismatch/);

    expect(await countAll(project)).toEqual(before); // 原樣
  });

  it('兩 URL 同物理 DB → abort', async () => {
    await expect(
      runDeletePersonalData({
        projectUrl: TEST_DB_URL,
        personalUrl: TEST_DB_URL,
        execute: false,
        log: noLog,
        printManifest: false,
      })
    ).rejects.toThrow(/同一物理 DB/);
  });

  it('URL 對調 → 0007 方向檢查抓到（project 端帶 0007 marker）', async () => {
    await expect(
      runDeletePersonalData({
        projectUrl: TEST_PERSONAL_DB_URL, // 對調
        personalUrl: TEST_DB_URL,
        execute: false,
        log: noLog,
        printManifest: false,
      })
    ).rejects.toThrow(/0007/);
  });

  it('缺 personal URL → abort（必填）', async () => {
    await expect(
      runDeletePersonalData({
        projectUrl: TEST_DB_URL,
        personalUrl: '',
        execute: false,
        log: noLog,
        printManifest: false,
      })
    ).rejects.toThrow(DeleteAbortError);
  });
});
