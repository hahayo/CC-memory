# 決策 Wiki 規範

本目錄是 CC-memory 的 Git-first（以 Git 為主）決策知識庫。正式決策卡是 SSOT（Single Source of Truth，單一真相來源）；`INDEX.md` 只提供導覽，不另存決策內容。Claude Code 與 Codex 直接讀取同一批檔案，不新增資料庫或 MCP（Model Context Protocol，模型情境協定）介面。

## 目錄與生命週期

- `_draft/`：尚未具決策權威的候選卡，只能使用 `status: proposed`。
- 根目錄 `DEC-*.md`：人工接受的正式卡，只能使用 `active`、`superseded` 或 `archived`。
- `INDEX.md`：正式卡及既有 ADR（Architecture Decision Record，架構決策紀錄）的導覽索引。

只有明確拍板的重大架構、行為或 config（設定）決策才建立草稿。Agent（代理程式）不得自行接受；人工確認內容、來源及關係後，才可把卡片移出 `_draft/`，並在同一個 commit（提交）更新索引。

## 檔名與資料模型

新卡的檔名必須等於 ID 加 `.md`，格式為 `DEC-YYYYMMDDTHHMMSSZ-<kebab-slug>`，例如 `DEC-20260711T052245Z-git-first-decision-wiki.md`。YAML frontmatter（YAML 檔頭）只使用下列受限格式：頂層純量、四個 inline array（行內陣列），以及 `sources` 下的純量 map（映射）。

```yaml
---
id: DEC-20260711T052245Z-example
title: 決策標題
status: proposed
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
    ref: user-confirmation-2026-07-11
    captured_at: 2026-07-11T13:22:45+08:00
    excerpt_sha256: 64-character-lowercase-hex
    verified: true
---
```

`type` 只能是 `session_excerpt`、`repo_file`、`git_commit` 或 `manual`。正式卡至少要有一個 `verified: true` 的來源；本機絕對路徑不能作為唯一 locator（定位資訊）。

## 關係與語意相似

持久化關係只有四種，均由宣告該欄位的卡指向目標 ID：

- `supersedes`：本決策取代舊決策。
- `depends_on`：本決策依賴目標決策成立。
- `conflicts_with`：本決策與目標決策不相容。
- `related_to`：經人工確認、但不屬於前三類的關聯。

Semantic similarity（語意相似度）只能在閱讀或搜尋時計算並標為推測，不得寫成 `similarity`、`semantic_similarity` 或 `similar_to` 欄位。若相似性值得永久保存，必須先經人工確認，再轉成 `related_to`。

## 正文與原文溯源

每張卡固定包含六節：

1. 決策背景與決策前狀態
2. 替代方案及採否理由
3. 最終決策與理由
4. 預期後果及決策後狀態
5. 原文溯源
6. 後續結果與沿革

每個 source 都要在「原文溯源」下使用 `### <source-id>`，後接連續 blockquote（引文區塊）行。寫入前先遮罩密鑰、個資及不應進 Git 的內容，不保存完整 transcript（逐字紀錄）。Hash 正規化規則固定為：移除每行開頭的 `> `，以 `\n` 連接，不加尾端換行，再用 UTF-8 計算 SHA-256。

## 接受、取代與既有資料

人工接受後，背景、替代方案、最終決策及理由不可原地改寫；只允許更新生命週期狀態、關係 metadata（中繼資料），或追加具日期的後續結果。翻案必須建立新卡，以 `supersedes` 指向舊卡，再把舊卡狀態改為 `superseded`。

既有正式 ADR 保留原路徑並加入索引，不搬動、不重寫。舊 spec（規格）、plan（計畫）、session memory（工作階段記憶）或資料庫記錄只能唯讀盤點；去重後先產生候選卡，不得自動接受或刪除來源。

接受前及修改關係後執行：

```bash
npm run decisions:validate
```
