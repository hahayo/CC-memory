# 決策索引

> 本檔只提供導覽；各決策卡才是 SSOT（Single Source of Truth，單一真相來源）。語意相似是即時計算結果，只有卡片 frontmatter（檔頭）中的四種關係才是持久化關係。

## 正式決策

| ID | 狀態 | 日期 | 標題 | 決策卡 |
|---|---|---|---|---|
| `DEC-20260716T092938Z-cross-client-hook-driven-memory-flow` | active | 2026-07-16 | Claude Code 與 Codex 共用 hooks（掛鉤）驅動記憶流程 | [開啟](./DEC-20260716T092938Z-cross-client-hook-driven-memory-flow.md) |
| `DEC-20260714T182133Z-keep-parent-session-rollup` | active | 2026-07-15 | 多路徑擷取維持母工作階段彙總 | [開啟](./DEC-20260714T182133Z-keep-parent-session-rollup.md) |
| `DEC-20260714T170309Z-isolate-only-failed-capture-chunk` | active | 2026-07-15 | 大型語言模型最終失敗僅隔離單一分塊 | [開啟](./DEC-20260714T170309Z-isolate-only-failed-capture-chunk.md) |
| `DEC-20260711T052245Z-git-first-decision-wiki` | active | 2026-07-11 | 採用 Git-first 決策 Wiki | [開啟](./DEC-20260711T052245Z-git-first-decision-wiki.md) |
| `ADR-001` | active | 2026-06-09 | Phase 3 隔離策略：RLS → 獨立 Personal DB | [開啟](../personal-hub/decisions/ADR-001-phase3-separate-db.md) |

## 使用方式

重大架構、行為或 config（設定）決策前，先從本表找到相關卡，再沿 `supersedes`、`depends_on`、`conflicts_with`、`related_to` 讀取沿革。候選卡位於 [`_draft/`](./_draft/)，不具決策權威。
