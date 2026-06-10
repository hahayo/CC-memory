// tests/scripts/inventory.test.ts
//
// inventory SoT 對真 DB 跑：
//   - discoverInventory == EXPECTED_INVENTORY（schema 漂移 CI 先爆，工具鏈才不會
//     silent 漏表/多表）
//   - FK 邊界 throw 用臨時表驗（探到不支援的 schema 形狀必須 fail-fast）
//   - feedback_personal predicate 抓得到混合列（Codex B10）

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, resetAllTables, type Sql } from '../helpers/db.js';
import {
  COPY_ORDER,
  DELETE_ORDER,
  EXPECTED_INVENTORY,
  countPersonalRows,
  diffInventory,
  discoverInventory,
} from '../../scripts/lib/inventory.js';

const PERSONAL = '__personal__';

let db: Sql;

beforeAll(async () => {
  db = await connectTestDb();
  await resetAllTables(db);
  // 防上次中斷殘留的臨時表
  await db`DROP TABLE IF EXISTS tmp_child`;
  await db`DROP TABLE IF EXISTS tmp_parent`;
  await db`DROP TABLE IF EXISTS tmp_fk_no_id`;
  await db`DROP TABLE IF EXISTS tmp_second`;
});

afterAll(async () => {
  await resetAllTables(db);
  await db.end({ timeout: 5 });
});

describe('discoverInventory', () => {
  it('與 EXPECTED_INVENTORY 一致（diff 為空；schema 漂移在 CI 先爆）', async () => {
    const actual = await discoverInventory(db);
    expect(diffInventory(actual, EXPECTED_INVENTORY)).toEqual([]);
  });

  it('COPY_ORDER / DELETE_ORDER 與 inventory 覆蓋一致（copy 不含 search_feedback；delete 全含）', () => {
    const copyDeleteTables = new Set(EXPECTED_INVENTORY.map((e) => e.table));
    expect(new Set([...DELETE_ORDER])).toEqual(copyDeleteTables);
    expect([...COPY_ORDER].every((t) => copyDeleteTables.has(t))).toBe(true);
    expect([...COPY_ORDER]).not.toContain('search_feedback'); // 拍板：只刪不搬
  });

  it('FK ref 欄位非 id → throw', async () => {
    await db`CREATE TABLE tmp_parent (project_id text NOT NULL, alt text UNIQUE)`;
    await db`CREATE TABLE tmp_child (id uuid PRIMARY KEY, parent_alt text REFERENCES tmp_parent(alt))`;
    try {
      await expect(discoverInventory(db)).rejects.toThrow(/非 id/);
    } finally {
      await db`DROP TABLE IF EXISTS tmp_child`;
      await db`DROP TABLE IF EXISTS tmp_parent`;
    }
  });

  it('FK 表無 id 欄 → throw', async () => {
    await db`CREATE TABLE tmp_fk_no_id (ref_id uuid REFERENCES tasks(id), note text)`;
    try {
      await expect(discoverInventory(db)).rejects.toThrow(/無 id 欄/);
    } finally {
      await db`DROP TABLE IF EXISTS tmp_fk_no_id`;
    }
  });

  it('二層 FK → throw', async () => {
    await db`CREATE TABLE tmp_second (id uuid PRIMARY KEY, log_id uuid REFERENCES reminder_log(id))`;
    try {
      await expect(discoverInventory(db)).rejects.toThrow(/二層 FK/);
    } finally {
      await db`DROP TABLE IF EXISTS tmp_second`;
    }
  });
});

describe('countPersonalRows / personalWhere — search_feedback 混合列（Codex B10）', () => {
  it('query_project_id=personal、混合列（query NULL + result 含 personal）都算；純專案列不算', async () => {
    const feedbackEntry = EXPECTED_INVENTORY.find((e) => e.table === 'search_feedback')!;
    const mkIds = (n: number) => Array.from({ length: n }, () => randomUUID());

    // row 1：query 端 personal
    await db`
      INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                   result_ids, result_project_ids, rank_positions)
      VALUES ('q1', 'mcp', ${PERSONAL}, 'keyword', 5,
              ${mkIds(1)}::uuid[], ${[PERSONAL]}::text[], ${[1]}::int[])
    `;
    // row 2：混合列——query_project_id IS NULL 且結果含 personal（最易漏刪）
    await db`
      INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                   result_ids, result_project_ids, rank_positions)
      VALUES ('q2', 'mcp', NULL, 'keyword', 5,
              ${mkIds(2)}::uuid[], ${[PERSONAL, 'proj-x']}::text[], ${[1, 2]}::int[])
    `;
    // row 3：純專案列——不在個人範圍
    await db`
      INSERT INTO search_feedback (query, query_surface, query_project_id, mode, "limit",
                                   result_ids, result_project_ids, rank_positions)
      VALUES ('q3', 'mcp', 'proj-x', 'keyword', 5,
              ${mkIds(1)}::uuid[], ${['proj-x']}::text[], ${[1]}::int[])
    `;

    expect(await countPersonalRows(db, feedbackEntry)).toBe(2);
    await db`DELETE FROM search_feedback`;
  });

  it('project_id_eq / task_fk predicate 計數正確', async () => {
    const memEntry = EXPECTED_INVENTORY.find((e) => e.table === 'project_memories')!;
    const logEntry = EXPECTED_INVENTORY.find((e) => e.table === 'reminder_log')!;

    await db`INSERT INTO project_memories (project_id, type, summary) VALUES (${PERSONAL}, 'session', 'p1')`;
    await db`INSERT INTO project_memories (project_id, type, summary) VALUES ('proj-x', 'session', 'x1')`;

    const personalTask = randomUUID();
    const projectTask = randomUUID();
    await db`INSERT INTO tasks (id, project_id, title) VALUES (${personalTask}, ${PERSONAL}, 't-personal')`;
    await db`INSERT INTO tasks (id, project_id, title) VALUES (${projectTask}, 'proj-x', 't-project')`;
    await db`INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${personalTask}, now())`;
    await db`INSERT INTO reminder_log (task_id, scheduled_for) VALUES (${projectTask}, now())`;

    expect(await countPersonalRows(db, memEntry)).toBe(1);
    expect(await countPersonalRows(db, logEntry)).toBe(1);
  });
});
