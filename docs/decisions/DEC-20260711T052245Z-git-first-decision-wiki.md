---
id: DEC-20260711T052245Z-git-first-decision-wiki
title: 採用 Git-first 決策 Wiki
status: active
decided_at: 2026-07-11T13:22:45+08:00
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: manual
    client: human
    ref: user-approval-2026-07-11
    captured_at: 2026-07-11T13:22:45+08:00
    excerpt_sha256: 08ee89cc272bd49b85f66a6bf0091011ee4b858d4ff27bd3a7db222289a71d65
    verified: true
---

# 採用 Git-first 決策 Wiki

## 決策背景與決策前狀態

CC-memory 已能保存 session（工作階段）摘要、decision observation（決策觀察紀錄）與語意搜尋結果，但沒有保證記錄決策背景、替代方案、理由、後果、取代關係及跨 session 沿革。Repo（程式碼儲存庫）雖已有完整 ADR（Architecture Decision Record，架構決策紀錄），格式尚未成為 Claude Code 與 Codex 的共同工作規則。

## 替代方案及採否理由

| 方案 | 結論 | 理由 |
|---|---|---|
| 新增 PostgreSQL 決策資料表與 MCP 工具 | 不採用 | 單人、多 client（客戶端）的 v1 不需要權限與交易治理，會擴大 schema（資料結構）及維運面。 |
| Git 決策卡為權威、資料庫作搜尋索引 | 延後 | 未證明 Markdown（標記文件）查詢不足，先避免雙重資料來源。 |
| Git 決策卡為唯一真相 | 採用 | 兩個 coding agent（程式代理）可直接共讀、Git 自帶版本沿革，且不影響現有服務。 |

## 最終決策與理由

在 `docs/decisions/` 建立 Git-first（以 Git 為主）的決策 Wiki。正式卡以結構化 frontmatter（檔頭）保存狀態、來源與四種人工確認關係，正文保存背景、選項、理由及後果。Semantic similarity（語意相似度）只在查詢時計算，不自動轉成持久化關係。

Claude Code 與 Codex 直接讀取同一批 repo 檔案；v1 不新增 PostgreSQL、MCP（Model Context Protocol，模型情境協定）或自動 session-end capture（工作階段結束擷取）。只有明確拍板才建立候選卡，人工接受時才移出 `_draft/` 並提交。

## 預期後果及決策後狀態

- 決策背景、替代方案、理由、後果與來源使用一致格式，兩個 agent 可跨 session 還原沿革。
- 語意相似與經確認關係有明確界線，避免模型把「內容相近」誤報為因果、衝突或取代。
- 不產生資料庫 migration（遷移）或新服務維運成本。
- 人工確認與索引更新成為必要步驟；若決策量顯著增加，可再評估可重建的搜尋索引。

## 原文溯源

### S1

> Git 決策卡（建議）
> Implement the plan.

## 後續結果與沿革

- 2026-07-11：使用者確認採用 Git 決策卡並要求開始實作。
