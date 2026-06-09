// scripts/todoist-e2e.ts — Todoist live REST 工具真帳號一輪生命週期 e2e（gated）。
//
// 刻意「不」進 npm test：真帳號 / 真 token / 受 rate limit / 會留殘留。獨立手動跑。
//
// 用法：
//   RUN_TODOIST_E2E=1 TODOIST_API_TOKEN=xxxxx npx tsx scripts/todoist-e2e.ts
//
// 流程（plan Verification #3）：
//   projects（看 name+id）→ add（priority=p1，AI 真用時挑 project_id；此處入 Inbox）
//   → list（看到剛新增）→ **讀回 priority 整數驗證 p1↔4 方向**（priority mapping ASSUMPTION 的最終裁決）
//   → complete → completed（查到 + 比對 completed_at）。
//
// 完成 = close（移出 active list）即為清理；本 client 無 delete，completed 歷史會留一筆測試任務（無害）。

import 'dotenv/config';
import {
  addTask,
  listProjects,
  listTasks,
  completeTask,
  listCompletedTasks,
} from '../src/services/todoist.js';

const PRIORITY_P1_API_INT = 4; // ASSUMPTION 待此 e2e 證實；不符即翻轉 src/services/todoist.ts 的 PRIORITY_TO_API

function log(step: string, msg: string): void {
  console.log(`[todoist-e2e] ${step}: ${msg}`);
}
function fail(step: string, msg: string): never {
  console.error(`[todoist-e2e] ✗ ${step}: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env.RUN_TODOIST_E2E !== '1') {
    console.log('[todoist-e2e] 跳過（需 RUN_TODOIST_E2E=1 才執行）');
    return;
  }
  const token = process.env.TODOIST_API_TOKEN;
  if (!token || token.trim().length === 0) {
    fail('setup', 'TODOIST_API_TOKEN 未設');
  }

  const marker = `cc-memory e2e ${new Date().toISOString()}`;

  // 1. projects
  const { projects } = await listProjects(token);
  log('projects', `${projects.length} 個清單：${projects.map((p) => `${p.name}(${p.id})`).join(', ')}`);

  // 2. add（p1；不挑 project → Inbox，避免污染真實清單）
  const created = await addTask(token, { content: marker, priority: 'p1' });
  if (!created.id) fail('add', '回傳無 id');
  log('add', `已建立 id=${created.id} content="${created.content}" priority=${created.priority}`);

  // 3. priority 方向裁決：讀回整數須等於 p1 對應值
  if (created.priority !== PRIORITY_P1_API_INT) {
    fail(
      'priority',
      `p1 應映射成 API 整數 ${PRIORITY_P1_API_INT}，實得 ${created.priority}。` +
        `→ 翻轉 src/services/todoist.ts 的 PRIORITY_TO_API（並請在 Todoist app 確認該任務顯示為 P1 紅色）`
    );
  }
  log('priority', `✓ p1 → API 整數 ${created.priority}（請順手在 Todoist app 確認顯示為 P1 紅色）`);

  // 4. list：應在未完成清單看到
  const { tasks: active } = await listTasks(token, {});
  if (!active.some((t) => t.id === created.id)) fail('list', `未在 active list 看到 ${created.id}`);
  log('list', `✓ active list 含 ${created.id}（共 ${active.length} 筆）`);

  // 5. complete
  await completeTask(token, created.id);
  log('complete', `✓ 已 close ${created.id}`);

  // 6. completed：以 completed_at 為準應查到
  const { tasks: completed } = await listCompletedTasks(token, {});
  const found = completed.find((t) => t.id === created.id);
  if (!found) fail('completed', `近 7 天 completed 未查到 ${created.id}`);
  if (!found.completedAt) fail('completed', `查到但無 completed_at`);
  log('completed', `✓ completed 查到 ${created.id} completed_at=${found.completedAt}`);

  console.log('[todoist-e2e] ✅ 全部通過（測試任務已 close；completed 歷史保留一筆，無害）');
}

main().catch((err) => {
  console.error('[todoist-e2e] 失敗:', err);
  process.exit(1);
});
