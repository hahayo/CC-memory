# docs/ 導覽索引

> 建立於 2026-07-05（repo 盤點後的文件止血）。**新 session 接手：先讀 repo 根目錄 `CLAUDE.md`（工具全貌 + env vars），再讀本檔搞清楚哪條 track（工作軌道）是活的，最後才進該 track 的 spec。**
>
> 維護規則：track 狀態變動（啟動/交付/擱置）時同步更新本檔；新增 spec/plan 文件時在下方清單登記一行。

## Track 總表

| Track | 目錄 | 狀態 | 一句話 |
|---|---|---|---|
| **Track 1：memory 核心（v0.3 → v0.5）** | `docs/auto-capture-v0.5/` + `docs/{spec,plan,task}.md` | Phase A ✅（tag `v0.3-phase-a`）／Phase B ❌ 取消／**v0.5 M1-M6 已交付（2026-07-08，PR #9-#18）；benchmark Go/No-Go 預計 2026-07-21** | auto-capture（自動採集）是「取代 claude-mem」主線；v0.4 Phase C 休眠設計已被 v0.5 observation-first（觀察紀錄優先）SDD 取代 |
| **Track 2：personal-hub 個人中樞** | `docs/personal-hub/` | ✅ **已交付**（2026-06-10 prod cutover） | Phase 0-3 + Todoist 5 tools + at-least-once（至少一次投遞）queue 全上線；維運見 `personal-hub/prod-runbook.md` |
| **Track 3：project DB cutover** | `docs/migrations/2026-06-29-cc-memory-project-cutover/` | ✅ **EXECUTED**（2026-07-01） | Zeabur → Coolify，Plan B fresh schema（全新結構）；`addendum-2026-06-30-plan-b.md` 是 actual runbook；剩 Step F（Zeabur 退役）待做 |

## 長期目標：取代 claude-mem（v0.5 SDD active）

- **目前載體**：`docs/auto-capture-v0.5/{spec,plan,task}.md`。v0.4 Phase C 舊設計只供溯源，不再是實作依據。
- **明文出處**：v0.5 SDD 的 Go/No-Go 品質閘（quality gate，品質關卡）三硬指標：10 組 benchmark query（基準查詢，固定 5 + 真實 5）中 ≥7 組 Top-5 交集 ≥3、10 組平均人工 first-relevant rank ≤ claude-mem 平均 rank、錯抓率 <10%，AND 全達才停用。`docs/spec.md` 的 Goal 8 是舊 v0.4 口徑，已在 Phase C 章節加 SUPERSEDED marker。
- **2026-07-05 盤點結論**：CC-memory 的儲存/檢索核心（pgvector 語義 + hybrid 搜尋、跨裝置 PostgreSQL、治理）已強於 claude-mem；差距集中 4 項——① 全自動 capture 管線（hook + 背景 worker，難度 L）② session-start 自動注入 + token 經濟學（M）③ 細粒度 observation（觀察紀錄）模型（M）④ 3 層 token 節約檢索含 timeline（M）。v0.5 已把 ③/④ 納入主線。
- **授權紅線**：claude-mem 為 AGPL-3.0，只抄架構思路（hook 佈局、佇列語義、taxonomy、3 層檢索），不搬任何原始碼。

## 文件清單與狀態

### Active（活的，以此為準）

| 檔案 | 角色 |
|---|---|
| `../CLAUDE.md` | repo 總覽：21 個 MCP tools、env vars、設計模式（第一入口） |
| `../README.md` | 安裝 + Coolify 部署（SSH tunnel 流程） |
| `INDEX.md`（本檔） | track 導覽 |
| `decisions/{README,INDEX,_draft/,DEC-*.md}` | Git（版本控制）決策卡：跨 Claude Code／Codex 共用的決策 SSOT（單一真相來源），涵蓋規範、索引、候選草稿與正式決策 |
| `auto-capture-v0.5/{spec,plan,task}.md` | Track 1 v0.5 auto-capture SDD（Spec-Driven Development，規格驅動開發）三件套；取代 v0.4 Phase C 休眠設計 |
| `auto-capture-v0.5/memory-ops-cutover.md` | Claude Code／Codex hook-driven auto-capture＋reminder/Todoist systemd timers 維運遷移手冊（Active） |
| `auto-capture-v0.5/benchmark-fixtures.md` | benchmark（基準測試）查詢 fixture（固定資料）集（Active） |
| `auto-capture-v0.5/m4-settings-draft.md` | Claude Code／Codex SessionStart settings 落地紀錄（Active；2026-07-17 applied，Codex trust 待人工完成） |
| `auto-capture-v0.5/m4-gate-estimator-accuracy.json` | M4 token estimator 精度量測紀錄（Active） |
| `auto-capture-v0.5/oq1-gate-report.json` | OQ1 PostToolUse payload gate 報告（Active） |
| `personal-hub/prod-runbook.md` | 維運手冊（2026-07-05 已更新為 Coolify 拓樸） |
| `personal-hub/{spec,plan,task}.md` + `decisions/ADR-001-*.md` | Track 2 SDD（已交付，仍為維運依據）；ADR-001 = 獨立 personal DB 決策 SSOT |
| `migrations/2026-06-29-cc-memory-project-cutover/` 四件 | Track 3 SDD（EXECUTED；addendum 為 actual runbook） |
| `../.claude/spec-status.md` | cascade 稽核 Status Block（目前只覆蓋 Track 3 四件套 + CLAUDE.md） |
| `retrieval-eval.md` | search_feedback 被動記錄的設計依據 |
| `schema-alignment.md` | 「Drizzle schema 為唯一真相」的依據（歷史紀錄，結論仍有效） |

### Dormant（休眠——內容有效但未動工，重啟前需 refresh）

（空）——v0.4 Phase C 已移至 Superseded；v0.5 SDD active。

### Superseded / Historical / Stale（已標記，僅供溯源）

| 檔案 | 標記 |
|---|---|
| `auto-capture-v0.5/m2a-settings-draft.md` | Historical（M2a hook settings 草稿；已由 M4 草稿取代） |
| `auto-capture-v0.5/m2b-cron-draft.md` | Historical（Hermes cron draft；已由 hook-driven systemd oneshot 取代） |
| `next-session-handoff.md` | SUPERSEDED（2026-04-23 的交接，主線早已轉向） |
| `TODO.md` | ARCHIVED（v0.1 checklist，2026-02 後未維護） |
| `plans/2026-02-01-cc-memory-design.md` | HISTORICAL（v0.1 原始設計） |
| `codex-review-log.md` | HISTORICAL（Phase A review loop，round 24 收斂） |
| `usage.md`、`setup.md` | PARTIALLY STALE（只涵蓋 v0.1 手動流程 + Zeabur，全面更新待排） |
| `plans/archive/v0.2-spec-v1.2-revision.md` | 已在 archive/（正確歸檔範例） |
| `docs/{spec,plan,task}.md` 的 Phase C 章節 | SUPERSEDED（被 `auto-capture-v0.5/{spec,plan,task}.md` 取代；章節內文保留溯源） |
| `superpowers/specs/2026-04-22-auto-capture-design.md` | SUPERSEDED（被 `auto-capture-v0.5/spec.md` 取代；架構思路可溯源） |
| `superpowers/plans/2026-04-23-v04-phase-c-implementation.md` | SUPERSEDED（被 `auto-capture-v0.5/plan.md` + `task.md` 取代；M1-M5 慣例可溯源） |
| `superpowers/plans/2026-06-10-personal-hub-remaining-roadmap.md`、`2026-06-10-todoist-sync-polling.md` | 已執行完畢（A3b-A3d 全 merge） |

## 版號說明

- `package.json` **0.5.0**（2026-07-08 bump）= 現況：Phase A（v0.3）+ personal-hub Phase 0-3 + Todoist + project DB cutover + v0.5 auto-capture M1-M6 已交付。
- ⚠️ 「v0.4」在歷史文件裡有兩個用法：`docs/spec.md` 的 v0.4 = Phase C auto-capture（未實作且已 superseded）；ADR-001 的「Phase 3 v0.4」= personal DB 分離（已交付）。Track 1 auto-capture 後續以 **v0.5 / 0.5.x** 指涉。
