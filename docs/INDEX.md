# docs/ 導覽索引

> 建立於 2026-07-05（repo 盤點後的文件止血）。**新 session 接手：先讀 repo 根目錄 `CLAUDE.md`（工具全貌 + env vars），再讀本檔搞清楚哪條 track（工作軌道）是活的，最後才進該 track 的 spec。**
>
> 維護規則：track 狀態變動（啟動/交付/擱置）時同步更新本檔；新增 spec/plan 文件時在下方清單登記一行。

## Track 總表

| Track | 目錄 | 狀態 | 一句話 |
|---|---|---|---|
| **Track 1：memory 核心（v0.3 → v0.4）** | `docs/{spec,plan,task}.md` | Phase A ✅（tag `v0.3-phase-a`）／Phase B ❌ 取消／**Phase C 🟡 dormant（休眠）** | Phase C = auto-capture（自動採集），是「取代 claude-mem」的主線；設計完成（2026-04-23）、實作 0%，重啟前需 design refresh（見下） |
| **Track 2：personal-hub 個人中樞** | `docs/personal-hub/` | ✅ **已交付**（2026-06-10 prod cutover） | Phase 0-3 + Todoist 5 tools + at-least-once（至少一次投遞）queue 全上線；維運見 `personal-hub/prod-runbook.md` |
| **Track 3：project DB cutover** | `docs/migrations/2026-06-29-cc-memory-project-cutover/` | ✅ **EXECUTED**（2026-07-01） | Zeabur → Coolify，Plan B fresh schema（全新結構）；`addendum-2026-06-30-plan-b.md` 是 actual runbook；剩 Step F（Zeabur 退役）待做 |

## 長期目標：取代 claude-mem（進度 0%，卡在 Track 1 Phase C）

- **明文出處**：`docs/spec.md` Goal 8 品質閘（quality gate）三硬指標（Top-5 交集 ≥3／人工命中 rank ≤ claude-mem／錯抓率 <10%，AND 全達才停用）+ `docs/superpowers/specs/2026-04-22-auto-capture-design.md` Goal 5。
- **2026-07-05 盤點結論**：CC-memory 的儲存/檢索核心（pgvector 語義 + hybrid 搜尋、跨裝置 PostgreSQL、治理）已強於 claude-mem；差距集中 4 項——① 全自動 capture 管線（hook + 背景 worker，難度 L）② session-start 自動注入 + token 經濟學（M）③ 細粒度 observation（觀察紀錄）模型（M）④ 3 層 token 節約檢索含 timeline（M）。
- **重啟 Phase C 前置**：對照上述 4 項差距做一次 design refresh——檢查 `docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md` 是否涵蓋 ③ 與 ④，再動工。
- **授權紅線**：claude-mem 為 AGPL-3.0，只抄架構思路（hook 佈局、佇列語義、taxonomy、3 層檢索），不搬任何原始碼。

## 文件清單與狀態

### Active（活的，以此為準）

| 檔案 | 角色 |
|---|---|
| `../CLAUDE.md` | repo 總覽：18 個 MCP tools、env vars、設計模式（第一入口） |
| `../README.md` | 安裝 + Coolify 部署（SSH tunnel 流程） |
| `INDEX.md`（本檔） | track 導覽 |
| `personal-hub/prod-runbook.md` | 維運手冊（2026-07-05 已更新為 Coolify 拓樸） |
| `personal-hub/{spec,plan,task}.md` + `decisions/ADR-001-*.md` | Track 2 SDD（已交付，仍為維運依據）；ADR-001 = 獨立 personal DB 決策 SSOT |
| `migrations/2026-06-29-cc-memory-project-cutover/` 四件 | Track 3 SDD（EXECUTED；addendum 為 actual runbook） |
| `../.claude/spec-status.md` | cascade 稽核 Status Block（目前只覆蓋 Track 3 四件套 + CLAUDE.md） |
| `retrieval-eval.md` | search_feedback 被動記錄的設計依據 |
| `schema-alignment.md` | 「Drizzle schema 為唯一真相」的依據（歷史紀錄，結論仍有效） |

### Dormant（休眠——內容有效但未動工，重啟前需 refresh）

| 檔案 | 角色 |
|---|---|
| `docs/{spec,plan,task}.md` 的 Phase C 章節 | Track 1 v0.4 骨架 + 品質閘指標 |
| `superpowers/specs/2026-04-22-auto-capture-design.md` | auto-capture 完整設計（1056 行，Phase C 的 source of truth） |
| `superpowers/plans/2026-04-23-v04-phase-c-implementation.md` | Phase C 實作 plan（M1-M5） |

### Superseded / Historical / Stale（已標記，僅供溯源）

| 檔案 | 標記 |
|---|---|
| `next-session-handoff.md` | SUPERSEDED（2026-04-23 的交接，主線早已轉向） |
| `TODO.md` | ARCHIVED（v0.1 checklist，2026-02 後未維護） |
| `plans/2026-02-01-cc-memory-design.md` | HISTORICAL（v0.1 原始設計） |
| `codex-review-log.md` | HISTORICAL（Phase A review loop，round 24 收斂） |
| `usage.md`、`setup.md` | PARTIALLY STALE（只涵蓋 v0.1 手動流程 + Zeabur，全面更新待排） |
| `plans/archive/v0.2-spec-v1.2-revision.md` | 已在 archive/（正確歸檔範例） |
| `superpowers/plans/2026-06-10-personal-hub-remaining-roadmap.md`、`2026-06-10-todoist-sync-polling.md` | 已執行完畢（A3b-A3d 全 merge） |

## 版號說明

- `package.json` **0.4.0**（2026-07-05 bump）= 現況：Phase A（v0.3）+ personal-hub Phase 0-3 + Todoist + project DB cutover。
- ⚠️ 「v0.4」在歷史文件裡有兩個用法：`docs/spec.md` 的 v0.4 = Phase C auto-capture（未實作）；ADR-001 的「Phase 3 v0.4」= personal DB 分離（已交付）。命名衝突已存在，本索引一律以 **track 名稱**指涉；未來 Phase C 實作時建議另立 0.5.x 並同步修正 spec 命名。
