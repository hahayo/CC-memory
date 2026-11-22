---
id: DEC-20261122T093907Z-switch-embedding-to-local-bge-m3
title: embedding 從 Gemini gemini-embedding-001 改用本機 bge-m3，並刪除未被使用的 observations HNSW 索引
status: active
decided_at: 2026-11-22T17:39:07+08:00
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: [DEC-20260818T125648Z-redact-embedding-egress-and-backfill-with-gemini-001]
sources:
  - id: S1
    type: session_excerpt
    client: claude-code
    ref: session-bf6dbc19-2026-11-22-option-switch
    captured_at: 2026-11-22T17:39:07+08:00
    excerpt_sha256: 55d60d1cc4ba851fe06256e6df861ec05ac60130b1296293029ba9e33b2f6044
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: session-bf6dbc19-2026-11-22-user-assent-switch
    captured_at: 2026-11-22T17:39:07+08:00
    excerpt_sha256: 99550278e79e84d8aaa11eb3fddb651bc2688301a94258fdfe3f58805485552e
    verified: true
  - id: S3
    type: session_excerpt
    client: claude-code
    ref: session-bf6dbc19-2026-11-22-option-drop-index
    captured_at: 2026-11-22T17:39:07+08:00
    excerpt_sha256: cbf9827655166952cf8cbdc4c2a8f08a2430574d32d5537faa32198bce4e2ba1
    verified: true
  - id: S4
    type: session_excerpt
    client: human
    ref: session-bf6dbc19-2026-11-22-user-assent-drop-index
    captured_at: 2026-11-22T17:39:07+08:00
    excerpt_sha256: 16f035758af8116560aabcb29c5744a8aabd2ff423b53110f8114d31d99dc738
    verified: true
  - id: S5
    type: session_excerpt
    client: human
    ref: session-bf6dbc19-2026-11-22-user-background
    captured_at: 2026-11-22T17:39:07+08:00
    excerpt_sha256: 6c7ac531df93889833fe1f5103044d7966e0482d1971e89e49eb2c437c309404
    verified: true
---

# embedding 從 Gemini gemini-embedding-001 改用本機 bge-m3，並刪除未被使用的 observations HNSW 索引

## 決策背景與決策前狀態

見 S5（使用者原話）。

## 替代方案及採否理由

見 S1「先不換」選項；未採用理由：Not recorded。

## 最終決策與理由

1. embedding 改用本機 BAAI/bge-m3（1024 維），由各機器 127.0.0.1 的 embed-service 計算，寫入 `embedding_bge_m3` 欄（`EMBEDDING_PROVIDER=local`）。依據 S1、S2。
2. 刪除 `observations_embedding_idx`（HNSW）。依據 S3、S4。

理由：見 S1「我選」一句。

## 預期後果及決策後狀態

Not recorded

## 原文溯源

### S1

> - **寫換模型計畫**：我先寫一頁計畫給你看，你點頭才動工。工作量大約半天到一天，換完一個月省 100 多元。
> - **先不換**：繼續用 Gemini，每月照付。測試結果先留著，以後想換再拿出來。
> 
> **我選「寫換模型計畫」**：品質沒變差、免費，記憶內容也不用再送到 Google。

### S2

> 寫換模型計畫 呼叫devin去實作

### S3

> **要不要刪掉 `observations_embedding_idx`（3 GB、從沒被用過）？**

### S4

> 刪掉

### S5

> 我確認一下 embedding model 我現在 每月大概 100多元 有可能 用什麼開源的model 是免費的嗎?

## 後續結果與沿革

- 2026-11-22：bge-m3 全量補算完成（project 393,982 筆、personal 48 筆，failed=0）；capture worker 與 MCP 啟動檔改為 `EMBEDDING_PROVIDER=local`。
