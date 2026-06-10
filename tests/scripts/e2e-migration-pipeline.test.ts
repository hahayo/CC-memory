// tests/scripts/e2e-migration-pipeline.test.ts
//
// 全管線 e2e 演練（staging 演練前移、本地可重複，Codex A-extra4）：
//   seed → migrate dry-run → migrate → preflight post-copy → delete dry-run
//   → delete --execute（manifest 落盤）→ 套 0008 → preflight post-delete
//   （--manifest + --skip-scope-tests，Codex B4）→ 0008 拒寫個人列 assert
//
// 全程 spawnSync 跑真 CLI（鏡像 runbook 指令路徑，不走 import 捷徑）；
// seed 含微秒 timestamp、非空 jsonb metadata、keywords array、search_feedback
// 混合列（Codex B10）。
//
// 0008 constraint 在 afterAll 清除（鏡像 scripts/test-db-setup.ts 自癒邏輯），
// 不污染一般 suite 的 __personal__ seed。

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DB_URL,
  TEST_PERSONAL_DB_URL,
  connectDb,
  resetAllTables,
  type Sql,
} from '../helpers/db.js';

const PERSONAL = '__personal__';
const MANIFEST_PATH = join(tmpdir(), `cc-memory-e2e-manifest-${process.pid}.json`);

let project: Sql;
let personal: Sql;

function runCli(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('npx', ['tsx', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      DATABASE_URL_PERSONAL: TEST_PERSONAL_DB_URL,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function dropProjectNoPersonalChecks(): Promise<void> {
  await project`SET client_min_messages = 'warning'`; // 靜音 DROP IF EXISTS 的 NOTICE
  await project`ALTER TABLE project_memories DROP CONSTRAINT IF EXISTS project_memories_no_personal_check`;
  await project`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_no_personal_check`;
  await project`ALTER TABLE search_feedback DROP CONSTRAINT IF EXISTS search_feedback_no_personal_check`;
}

beforeAll(async () => {
  project = await connectDb(TEST_DB_URL);
  personal = await connectDb(TEST_PERSONAL_DB_URL);
  await dropProjectNoPersonalChecks(); // 防上次中斷殘留
  await resetAllTables(project);
  await resetAllTables(personal);
});

afterAll(async () => {
  await dropProjectNoPersonalChecks(); // 鏡像 test-db-setup 自癒：不污染一般 suite
  await resetAllTables(project);
  await resetAllTables(personal);
  await project.end({ timeout: 5 });
  await personal.end({ timeout: 5 });
  rmSync(MANIFEST_PATH, { force: true });
});

describe('全管線 e2e：migrate → post-copy → delete → 0008 → post-delete', () => {
  it(
    '完整 runbook 順序全綠 + 資料無失真 + 0008 拒回流',
    async () => {
      // ---- seed（project DB）----
      const personalTaskId = randomUUID();
      await project`
        INSERT INTO tasks (id, project_id, title, remind_at, snooze_until, recurrence_interval_days, metadata, tags)
        VALUES (${personalTaskId}, ${PERSONAL}, 'e2e personal task',
                '2026-06-20T01:02:03.123456+00'::timestamptz,
                '2026-06-21T04:05:06.654321+00'::timestamptz, 3,
                '{"todoist": {"id": 987}, "嵌套": {"深": [1, 2]}}'::jsonb,
                ARRAY['e2e','個人'])
      `;
      await project`
        INSERT INTO project_memories (project_id, type, summary, keywords, metadata)
        VALUES (${PERSONAL}, 'decision', 'e2e personal memory',
                ARRAY['關鍵字一','kw2'], '{"score": 0.987654321}'::jsonb)
      `;
      await project`
        INSERT INTO reminder_log (task_id, scheduled_for, channel)
        VALUES (${personalTaskId}, '2026-06-20T01:02:03.123456+00'::timestamptz, 'hermes')
      `;
      // 非個人列
      const projTaskId = randomUUID();
      await project`INSERT INTO tasks (id, project_id, title) VALUES (${projTaskId}, 'proj-x', 'project task')`;
      await project`INSERT INTO project_memories (project_id, type, summary) VALUES ('proj-x', 'session', 'project memory')`;
      // search_feedback：個人 query / 混合列（query NULL + result 含 personal）/ 純專案
      await project`
        INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                     result_ids, result_project_ids, rank_positions)
        VALUES ('e2e-personal', 'mcp', ${PERSONAL}, 'keyword', 5,
                ${[randomUUID()]}::uuid[], ${[PERSONAL]}::text[], ${[1]}::int[])
      `;
      await project`
        INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                     result_ids, result_project_ids, rank_positions)
        VALUES ('e2e-mixed', 'mcp', NULL, 'keyword', 5,
                ${[randomUUID(), randomUUID()]}::uuid[], ${[PERSONAL, 'proj-x']}::text[], ${[1, 2]}::int[])
      `;
      await project`
        INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                     result_ids, result_project_ids, rank_positions)
        VALUES ('e2e-project', 'mcp', 'proj-x', 'keyword', 5,
                ${[randomUUID()]}::uuid[], ${['proj-x']}::text[], ${[1]}::int[])
      `;

      // ---- Step 1: migrate dry-run → 實跑 ----
      const dryMigrate = runCli(['scripts/migrate-personal-data.ts', '--dry-run']);
      expect(dryMigrate.status, `migrate dry-run 應 exit 0：\n${dryMigrate.out}`).toBe(0);
      const personalCountAfterDry = await personal`SELECT COUNT(*)::int AS n FROM tasks`;
      expect(personalCountAfterDry[0].n).toBe(0); // dry-run 零寫入

      const migrate = runCli(['scripts/migrate-personal-data.ts']);
      expect(migrate.status, `migrate 應 exit 0：\n${migrate.out}`).toBe(0);

      // 資料無失真：微秒 timestamp + jsonb metadata 原樣到 personal DB
      const copied = await personal<{ remind_at_text: string; meta_equal: boolean }[]>`
        SELECT remind_at::text AS remind_at_text,
               (metadata = '{"todoist": {"id": 987}, "嵌套": {"深": [1, 2]}}'::jsonb) AS meta_equal
        FROM tasks WHERE id = ${personalTaskId}
      `;
      expect(copied).toHaveLength(1);
      expect(copied[0].remind_at_text).toContain('.123456');
      expect(copied[0].meta_equal).toBe(true);

      // ---- Step 2: preflight post-copy 全 PASS ----
      const postCopy = runCli(['scripts/preflight.ts', '--mode', 'post-copy']);
      expect(postCopy.status, `post-copy 應 exit 0：\n${postCopy.out}`).toBe(0);

      // ---- Step 3: delete dry-run（零寫入）→ --execute ----
      const dryDelete = runCli(['scripts/delete-personal-data.ts']);
      expect(dryDelete.status, `delete dry-run 應 exit 0：\n${dryDelete.out}`).toBe(0);
      const stillThere = await project`SELECT 1 FROM tasks WHERE project_id = ${PERSONAL}`;
      expect(stillThere).toHaveLength(1);

      const doDelete = runCli([
        'scripts/delete-personal-data.ts',
        '--execute',
        '--manifest-out',
        MANIFEST_PATH,
      ]);
      expect(doDelete.status, `delete --execute 應 exit 0：\n${doDelete.out}`).toBe(0);
      expect(existsSync(MANIFEST_PATH)).toBe(true);
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      expect(manifest.executed).toBe(true);
      expect(manifest.tables.search_feedback.deleted).toBe(2); // 個人 query + 混合列

      // project DB：個人列全清、非個人列原封
      expect(await project`SELECT 1 FROM tasks WHERE project_id = ${PERSONAL}`).toHaveLength(0);
      expect(
        await project`SELECT 1 FROM search_feedback WHERE ${PERSONAL} = ANY(result_project_ids)`
      ).toHaveLength(0);
      expect(await project`SELECT 1 FROM tasks WHERE id = ${projTaskId}`).toHaveLength(1);
      expect(await project`SELECT 1 FROM search_feedback WHERE query = 'e2e-project'`).toHaveLength(1);

      // ---- Step 4: 套 0008（鏡像 runbook Step 5.5）----
      const apply0008 = spawnSync(
        'npx',
        ['tsx', 'scripts/apply-migration.ts', 'sql/migrations/0008_project_db_no_personal_check.sql'],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DATABASE_URL: TEST_DB_URL } }
      );
      expect(apply0008.status, `apply 0008 應 exit 0：\n${apply0008.stderr}`).toBe(0);

      // ---- Step 5: preflight post-delete（--manifest 精確比對 + --skip-scope-tests）----
      const postDelete = runCli([
        'scripts/preflight.ts',
        '--mode',
        'post-delete',
        '--manifest',
        MANIFEST_PATH,
        '--skip-scope-tests',
      ]);
      expect(postDelete.status, `post-delete 應 exit 0：\n${postDelete.out}`).toBe(0);
      expect(postDelete.out).toContain('[SKIP] #D5'); // SKIP 顯式標示，不算 FAIL

      // ---- Step 6: 0008 拒寫個人列（防回流結構性保證，Codex A-extra4）----
      await expect(
        project`INSERT INTO tasks (project_id, title) VALUES (${PERSONAL}, '回流 probe')`
      ).rejects.toThrow(/no_personal_check/);
      await expect(
        project`
          INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                       result_ids, result_project_ids, rank_positions)
          VALUES ('回流-mixed', 'mcp', NULL, 'keyword', 1,
                  ${[randomUUID()]}::uuid[], ${[PERSONAL]}::text[], ${[1]}::int[])
        `
      ).rejects.toThrow(/no_personal_check/);
    },
    180_000
  );
});
