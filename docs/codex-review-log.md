# Codex Review Loop 紀錄（v0.3 Phase A Stage 3）

> Scope：`git diff 399018f..HEAD` — 本期 Phase 2（schema 補完 + service layer）+ Phase 5-A（retrieval eval 被動記錄）。
> 指令：`codex exec review --base 399018f`
> **Loop 於 round 24 收斂結束**（codex 回「no actionable bugs, internally consistent」）。

## 當前狀態

- **Commits**：Stage 0 `26f8f47` → Stage 1 merges（3 worktree）→ Stage 2 `ebca384` → 23 round fixes → Stage 3 收斂
- **測試**：248 / 248 tests 綠（baseline 143 + codex-driven +105 tests）
- **Build / Lint**：乾淨
- **Migrations**：0002 / 0003 / 0004 / 0005 全部已 commit
- **Loop 狀態**：✅ 收斂完成（round 24 codex 無新 findings）
- **下一步**：收尾 Stage 3 + 寫 Phase A 完工 commit / tag

## 跑 codex review 的指令

```bash
# 若 codex hit usage limit 會回「reset at X AM」
codex exec review --base 399018f 2>&1 | tee /tmp/codex-review-round19.log | tail -80
```

完整 logs 於 `/tmp/codex-review-round{1..18}.log`（session 重啟會遺失，僅供本 session 參考）。

## 18 rounds 累積採納的 findings

每輪分 Blocking (P1) / Suggestion (P2/P3)；「合理採納不合理反駁」紀律下 100% 採納（0 反駁 — codex 每條都是真 bug 或真 input-validation gap）。

### Round 1（`8c0595a`）— 4 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` cc_memory_search | handler 強制 scope 消除 cross-project 搜尋能力 |
| P2 | `src/services/memories.ts` semanticSearchScored | embedding 失敗時 effectiveMode 謊報 |
| P2 | `src/services/tasks.ts` createTask | 重複 idempotency_key → INTERNAL（應為 IDEMPOTENCY_CONFLICT） |
| P3 | `src/index.ts` errorResponse | plain Error 的 .code 被丟掉 → INTERNAL |

### Round 2（`52ba0da`）— 3 P1 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/services/tasks.ts` updateTask | done → done no-op 重設 completed_at（毀稽核時間） |
| P1 | `src/services/tasks.ts` createTask | status='done' 沒 set completed_at |
| P1 | `src/services/memories.ts` computeContentHash | hash 未涵蓋 decisions / nextSteps（資料靜默丟失） |

### Round 3（`8b5a3a9`）— 2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` resolveCwdAndProjectId | 無 project selector fallback process.cwd() 誤 routing |
| P2 | `src/services/tasks.ts` resolveTaskByShortId | 大寫 UUID prefix LIKE case-sensitive false NOT_FOUND |

### Round 4（`be70bba`）— 2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` cc_task_{create,update} | due_date 無效字串 → INTERNAL |
| P3 | `src/services/memories.ts` saveMemory | 冪等重試仍跑 embedding（浪費 API） |

### Round 5（`ac3bb11`）— 2 P2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/services/tasks.ts` updateTask | 不 scope by projectId，跨 project UUID 可改 |
| P2 | `scripts/eval-retrieval.ts` | NULL query_project_id 全歸「(null)」錯位 Jaccard |

### Round 6（`d5d2f70`）— 2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` cc_task_update inputSchema | 缺 project_id 欄位（contract bug） |
| P2 | `src/utils/repo-name.ts` | local-path remote 被當 owner/repo |

### Round 7（`c8562f2`）— 1 P3 + 測試修

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P3 | `scripts/eval-retrieval.ts` | 內嵌 literal U+0000 → git 當 binary file |
| — | `vitest.config.ts`（新增） | singleFork 修併發 test DB race / hook timeout |

### Round 8（`71caa75`）— 2 P2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` inputSchemas | 未宣告 project selector 必填 → schema/runtime 不一致 |
| P2 | `src/services/tasks.ts` createTask/updateTask | title 長度驗證只在 DB 層 → INSERT 失敗變 INTERNAL |

### Round 9（`d71dc1b`）— 3 findings（1 P2 + 2 P3）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/services/tasks.ts` createTask | 空字串 idempotency_key 污染 unique index |
| P3 | `src/services/tasks.ts` createTask | status/priority/source 無 runtime enum 驗證 |
| P3 | `src/services/tasks.ts` updateTask | patch.status/priority 無驗證（壞值變 INVALID_TRANSITION/INTERNAL） |

### Round 10（`0810cae`）— 2 P2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` parseDueDate | 接受非 ISO 格式 + 爛日期 rollover（Feb 31 → Mar 3） |
| P2 | `src/services/memories.ts` saveMemory | idempotency_key 空字串 / whitespace-only 污染 |

### Round 11（`9294ab7`）— 3 findings（1 P1 + 2 P2）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` resolveCwdAndProjectId | 相對 project_path fallback 到 server cwd |
| P2 | `src/index.ts` cc_memory_search | project_id: "" 默默變 cross-project |
| P2 | `src/index.ts` ISO_8601_REGEX | timed due_date 無 TZ 用 server local timezone |

### Round 12（包在 `3badfaf`）— 1 P1 + 1 P2

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` resolveCwdAndProjectId | whitespace-only project_id 繞過 fail-fast |
| P2 | `src/index.ts` formatTask | timed due_date 渲染丟時間、date-only 跨時區漂移 |

### Round 13（`9c1475e`）— 2 P2 findings

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` parseDueDate | 空字串 / whitespace 靜默變 undefined（掉 update） |
| P2 | `src/index.ts` cc_memory_search | whitespace-only project_id 污染 search_feedback |

### Round 14（`dc7fa69`）— 3 findings（1 P1 + 2 P2）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` resolveCwdAndProjectId | 有 project_id 時誤拒同時帶相對 project_path |
| P2 | `src/services/tasks.ts` listTasks | status=[] 生 SQL `IN ()` INTERNAL |
| P2 | `src/services/memories.ts` searchMemories | hybrid scores 存 RRF weights 污染 eval |

### Round 15（`d4ff615`）— 2 findings（1 P1 + 1 P2）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/db/schema.ts` + memories/tasks idempotency | 跨 project 冪等碰撞（global unique 應 composite with project_id） |
| P2 | `src/index.ts` cc_memory_search | whitespace-only project_path slip through |

### Round 16（`2965ace`）— 2 findings（1 P1 + 1 P2）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/utils/repo-name.ts` | multi-segment path 壓成 last 2（group-a/sub/repo == group-b/sub/repo） |
| P2 | `src/index.ts` resolveCwdAndProjectId | nonexistent project_path 靜默 fallback basename |

### Round 17（`83bc1ee`）— 3 findings（2 P2 + 1 P3）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P2 | `src/index.ts` cc_memory_search | 不驗 project_path 存在（繞過 round 16 helper） |
| P2 | `src/services/feedback.ts` + schema | search_feedback 沒記 type filter → eval 混淆 |
| P3 | `scripts/eval-retrieval.ts` | group key 沒 limit / filter_type |

### Round 18（`67dd32c`）— 3 findings（1 P1 + 2 P2）

| 嚴重度 | 位置 | 摘要 |
|---|---|---|
| P1 | `src/index.ts` cc_memory_delete | 不驗 project，跨 project UUID 可銷毀 |
| P2 | `src/index.ts` cc_memory_get | 不驗 project，跨 project UUID 可讀取 |
| P2 | `src/services/memories.ts` deleteByIdempotencyKey | 沒 scope by project（配合 round 15 composite unique 後會撈錯） |

### Round 19 — 3 findings（1 P1 + 2 P2；1 反駁）

| 嚴重度 | 位置 | 摘要 | 處置 |
|---|---|---|---|
| P1 | `src/index.ts` cc_memory_search | 同時帶 project_id + project_path 時誤驗 path → regression | ✅ 採納 |
| P2 | `src/services/memories.ts` saveMemory + partial unique index | archived row 被當 idempotent hit；archive 後同 key 無法再 save | ✅ 採納（migration 0005 + pre-check/race handler 加 `status='active'` filter） |
| P2 | `src/index.ts` formatDueDate | UTC 午夜 timed due_date 被壓成 date-only 顯示 | ❌ 反駁（Date 物件無法還原意圖；需加 schema column 存意圖，成本效益不符；round 12 收斂過 date-only 邏輯） |

### Round 20 — 2 findings（1 P1 + 1 P2；全採納；Round 19 Finding 3 反駁被 codex 接受）

| 嚴重度 | 位置 | 摘要 | 處置 |
|---|---|---|---|
| P1 | `src/services/projects.ts` resolveProjectId + `src/index.ts` resolveCwdAndProjectId / cc_memory_search | caller 送 explicit project_path 時 env `CC_MEMORY_PROJECT_ID` 仍 override → 跨 project misroute | ✅ 採納（新增 `cwdIsExplicit` flag，true 時跳過 layer 2 env） |
| P2 | `src/services/tasks.ts` listTasks | limit/offset 未驗證非負整數，Postgres 拒負數會 bubble 成 INTERNAL | ✅ 採納（listTasks pre-check `Number.isInteger && >= 0`） |

### Round 21 — 1 finding（P2；採納；Round 20 findings 被接受）

| 嚴重度 | 位置 | 摘要 | 處置 |
|---|---|---|---|
| P2 | `src/services/projects.ts` tryReadClaudeMdMarker | 只讀 `${cwd}/CLAUDE.md`；caller 從 subdirectory 呼叫時 repo-root marker 被漏 → 同 project 依 cwd 解出不同 ID | ✅ 採納（從 cwd 往上層逐層找 CLAUDE.md，最多 64 層到 filesystem root） |

### Round 22 — 2 findings（1 P1 + 1 P2；全採納；Round 21 walk-up 引入的新 bug）

| 嚴重度 | 位置 | 摘要 | 處置 |
|---|---|---|---|
| P1 | `src/services/projects.ts` tryReadClaudeMdMarker | Round 21 walk-up 無邊界，走到 filesystem root 會撿 `~/CLAUDE.md` / monorepo 父目錄的 marker → misroute 到陌生 project | ✅ 採納（在 `.git` 目錄出現的 repo boundary 停止 walk-up） |
| P2 | `src/services/memories.ts` deleteMemory | 不過濾 `status='active'` → 重複 delete 已 archived 的 row 仍 UPDATE 到並回 true，違反 MCP handler 的 NOT_FOUND 契約 | ✅ 採納（deleteMemory 加 `status='active'` filter） |

### Round 23 — 1 finding（P1；採納；Round 22 修復仍有漏網）

| 嚴重度 | 位置 | 摘要 | 處置 |
|---|---|---|---|
| P1 | `src/services/projects.ts` tryReadClaudeMdMarker | cwd 不在 git repo 裡（例 `~/scratch/demo`）時，walk-up 仍一路走到 `~/CLAUDE.md` → 子目錄被解成祖先 marker 的陌生 project | ✅ 採納（先找 repo root；找不到 `.git` → marker 完全不適用，回 null 讓 layer 4/5 接手） |

### Round 24 — ✅ 收斂（0 findings）

Codex 回覆：
> "I did not find any discrete, actionable bugs in the introduced changes that clearly break existing behavior or would warrant blocking the patch. The new service layer, migrations, and MCP handler rewiring appear internally consistent."

Loop 終止條件達成：雙方意見一致、codex 無新 bug / risk 指摘。Stage 3 可收尾。

## 主要主題歸納

| 主題 | 出現 rounds | 說明 |
|---|---|---|
| 跨 project 資料隔離 | 1, 5, 15, 16, 17, 18 | search / update / delete / get / eval / idempotency 全要 scope 保護 |
| Input validation | 4, 8, 9, 10, 11, 12, 13 | due_date / enum / title / idempotency_key / project_id / project_path 全要 pre-check |
| Contract（schema vs runtime） | 6, 8, 14, 18 | inputSchema 標的 required / required combo 必須對齊 handler 強制條件 |
| Feedback 語意純淨 | 5, 14, 17 | scores / filter_type / limit 正確存才能讓 eval 有意義 |
| 安全性 | 3, 11, 15, 16 | UUID prefix injection 防護 / shell 安全 / path 驗證 / owner/repo 不可偽造 |

## 下 session 銜接步驟

1. `git log --oneline ebca384..HEAD` 看已完成 commits
2. `npx vitest run` 驗 229/229 綠
3. `codex exec review --base 399018f` 跑 round 19
4. 若回「無 blocking / no findings」→ 收尾 Stage 3，寫 Phase A 完工 commit 並 mark TaskUpdate #4 completed
5. 若仍有 findings → 採「合理採納不合理反駁」紀律繼續修，每輪：
   - 修 → `npm test` 綠 → `npm run build` + `lint` → 補測試 → commit
6. 手動端對端驗收（plan.md Verification 區）：
   - 跨電腦 `cc_memory_save` + `cc_memory_list` 看 `writer_host`
   - Codex CLI 呼 `cc_memory_search` 能拿結果
   - `npx tsx scripts/eval-retrieval.ts` 產報表
   - DB smoke：idempotency 二次 INSERT / search_feedback 四陣列 CHECK / writer_host 可見

## Loop 終止條件（依使用者 /loop 指令）

> 直到雙方遇見趨於一致且 codex 沒有 review 出新 bug or risks，就可以結束 loop

✅ **Round 24 收斂**：codex 無新 findings，雙方意見一致。Loop 結束。

findings 走勢：19:3 → 20:2 → 21:1 → 22:2 → 23:1 → 24:0。

Stage 3 共 6 rounds（19-24），累積採納 7 findings + 反駁 1 findings（round 19 Finding 3 formatDueDate UTC 午夜；codex round 20 起未再提 → 接受反駁）。

## 反駁紀錄（回送給 codex 的論點）

### Round 19 Finding 3 — formatDueDate UTC 午夜

**Codex 主張**：`2026-04-22T00:00:00Z` 被渲染成 `2026-04-22`，混淆 date-only 和 timed-midnight 語意。

**反駁要點**：
1. `new Date("2026-04-22")` 和 `new Date("2026-04-22T00:00:00Z")` 產生同一個 Date 物件，DB 也存相同 timestamp。只從儲存值無法還原「使用者原始意圖」。
2. 若要區分，須新增 schema column（`due_date_is_date_only: boolean` 或 `due_date_raw: text`）+ 全 call site 同步，含 migration、API schema、parseDueDate、formatDueDate。
3. 當前邏輯是 round 12 收斂過的 date-only 顯示決定，改動會重新打開那輪已解決的 timezone 漂移問題。
4. 成本效益不符：極邊角 case（恰好輸入 `T00:00:00Z` 想要 timed 語意的使用者），不值得加 schema column。

**若 codex 仍堅持**：請說明為何邊角 case 值得 schema 複雜度，或提出不改 schema 的替代方案。
