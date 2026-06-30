# Addendum 2026-06-30: Plan B（fresh schema, skip data cutover）

**狀態**：Phase 0 跑出 unexpected discovery 後的 plan adjustment（user approved 2026-06-30）

## Phase 0 Discovery

Phase 0 Task 0.1 + 0.2 跑出來的真實 Zeabur 狀態：

| 項目 | 預期 (原 plan) | 實際 (Phase 0 發現) |
|---|---|---|
| `project_memories` | 有 prod data | **0 rows**（user 從沒用 project mode 寫過 memory）|
| `tasks` | 有 prod data | 0 rows |
| `search_feedback` | 有 prod data | 6 rows（早期 dev/test telemetry，無業務價值）|
| `reminder_log` / `sync_state` / `bot_user_state` | 有 prod data | 全 0 rows |
| `reminder_delivery_queue` | 表存在 | **表不存在**（migration 0009 沒 apply 到 prod）|
| `drizzle.__drizzle_migrations` | 表存在（migrate mode）| **schema 不存在**（prod 用 `drizzle-kit push` 不是 migrate）|

**真實情況**：Zeabur 是 dev/test 空殼，user 平常都用 Coolify `cc_memory_personal`（`__personal__` namespace）。Zeabur project mode 從沒實質寫過資料。

## 為什麼從 Plan A 切到 Plan B

| Plan | 動作 | 為什麼不適用 |
|---|---|---|
| A（原 plan）| dump Zeabur → restore Coolify → checksum 比對 | 沒實質資料要 dump；checksum 比對 0 vs 0 沒意義；之後還要補 missing `reminder_delivery_queue` migration |
| **B（user 選）**| Coolify 直接 `drizzle-kit push` from `src/db/schema.ts`（fresh schema）| 跟 plan A 結果一樣（Coolify 有完整 schema + 空表）但少 dump/restore 步驟 + 立刻拿到 latest schema |

**6 rows search_feedback 丟掉的影響**：無。它是 dev/test 跑 `cc_memory_search` 自動寫的 telemetry log，無業務價值。

## Plan B 步驟（取代原 task.md Phase 2-3）

| 原 Phase / Task | Plan B 動作 |
|---|---|
| Phase 0（Pre-flight）| ✅ 已跑（Task 0.1 / 0.2 done，0.3-0.6 視需要） |
| Phase 1（CREATE DATABASE）| ✅ 原 Task 1.0-1.3 照跑（cc_memory_project owner=cc_memory + pgvector extension） |
| Task 1.4（pgvector）| ✅ 照跑 |
| **Phase 2（dump）** | ❌ **SKIP**（沒實質資料） |
| **Phase 3（restore + verify）** | ❌ **SKIP**（沒資料要 verify checksum） |
| **NEW Phase 1.5（drizzle-kit push）** | 在 Coolify cc_memory_project 跑 `DATABASE_URL='<coolify-project-url>' npx drizzle-kit push --config drizzle.config.ts`，從 `src/db/schema.ts` 一步落地全 schema（含 reminder_delivery_queue + 7 tables） |
| **NEW Phase 1.5b（補 0008 per-DB CHECK constraint）** | `DATABASE_URL='<coolify-project-url>' npx tsx scripts/apply-migration.ts sql/migrations/0008_project_db_no_personal_check.sql`（或 fallback `psql '<coolify-project-url>' -f sql/migrations/0008_project_db_no_personal_check.sql`）。**為何必補**：0008 是 per-DB 不變量（每資料庫範圍 invariant，禁止 `__personal__` 寫入 project DB），不在 `src/db/schema.ts` 共用結構內，drizzle-kit push 不會自動套；漏補會失去 ADR-001 防 `__personal__` 回流 project DB 的結構性保證 |
| **NEW Phase 1.6（schema verify）**| (a) `\dt public.*` 應列 7 表；(b) `SELECT extversion FROM pg_extension WHERE extname='vector'` 應有；(c) `SELECT conname FROM pg_constraint WHERE conname LIKE '%no_personal_check'` 應列 3 個 constraint（`project_memories_no_personal_check` / `tasks_no_personal_check` / `search_feedback_no_personal_check`）|
| Phase 4（寫 wrapper + switch）| ✅ 照跑（Task 4.1-4.4）|
| Task 4.0 / Task 4.3.5（triple drift gate）| **簡化**：沒實質資料要凍結（Zeabur project 沒人在用），triple gate 改成 single sanity check（確認 wrapper + .claude.json 結構對） |
| Phase 5（restart + verify）| ✅ 照跑（cc_memory_stats 預期 0 rows；cc_memory_search 預期 empty）|
| Phase 6（mark Zeabur deprecated）| ✅ 照跑 |

## Plan B 估時

| Phase | 預估 |
|---|---|
| Phase 0 (剩) | 5 min |
| Phase 1 (CREATE DATABASE + pgvector) | 5-10 min |
| Phase 1.5 (drizzle-kit push) | 5 min |
| Phase 1.5b (補 0008 per-DB CHECK constraint) | 1-2 min |
| Phase 1.6 (schema verify) | 2 min |
| Phase 4 (wrapper + switch) | 10 min |
| Phase 5 (restart + verify) | 5 min |
| Phase 6 (mark deprecated) | 5 min |
| **總計** | **35-45 min**（plan A 原估 60-80 min） |

## Plan B 風險降低

| Risk | Plan A | Plan B |
|---|---|---|
| 資料遺失 | dump/restore 風險 | 無資料要保（0 rows）|
| Schema drift | 要事後補 missing migration | drizzle-kit push 一步到位 latest schema |
| Drift gate fail | cutover 期間若 user 寫 → 重做 | 沒 source data，drift gate 無意義 |
| Rollback | DROP DATABASE + 改回 .claude.json | 同 |

## 仍保留的核心驗證

雖然 Phase 2/3 跳，但下列仍要驗：

- [ ] **Wrapper 結構對稱**（Task 4.3 verify）：`diff ~/run-cc-memory-personal.sh ~/run-cc-memory-project.sh` 結構合理
- [ ] **`.claude.json` cc-memory entry 改對**（Task 4.4 verify）：command = wrapper, env.DATABASE_URL 不存在
- [ ] **MCP 連通**（Task 5.2）：`/mcp` 顯示 `cc-memory: ✓ connected`
- [ ] **Tool query 正常**（Task 5.3）：`cc_memory_stats project_id="cc-memory"` 回 0 筆但不報錯
- [ ] **Schema 完整**（NEW Phase 1.6）：7 tables + pgvector extension + 3 個 `*_no_personal_check` constraint（`project_memories_no_personal_check` / `tasks_no_personal_check` / `search_feedback_no_personal_check`）
- [ ] **Per-DB CHECK constraint 已套**（NEW Phase 1.5b）：0008_project_db_no_personal_check.sql apply 後，端對端 probe (探測) `INSERT INTO project_memories (project_id, type, summary, writer_host, idempotency_key) VALUES ('__personal__', 'session', 'should fail', 'test', 'cutover-probe')` 應被 `project_memories_no_personal_check` 拒

## References

- 原 spec.md / plan.md / task.md（git commit `1fb398a`）—— anchor 設計，作為 reference
- Phase 0 discovery raw output（不留 file，見對話）
