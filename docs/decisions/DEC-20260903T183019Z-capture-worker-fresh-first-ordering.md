---
id: DEC-20260903T183019Z-capture-worker-fresh-first-ordering
title: auto-capture worker 改為 fresh-first：最近有動的 session 先處理，並修掉 cursor 消失就從頭重來
status: active
decided_at: 2026-09-03T18:30:19Z
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: session_excerpt
    client: claude-code
    ref: claude-code-session-3a5b3e5e-a896-467d-8928-23e2a379c777-2026-09-04-option-block
    captured_at: 2026-09-03T18:30:19Z
    excerpt_sha256: 49da2fc93a913ea72e9b98dfa4f4903361272224d8cd36e0710c48baf56a3356
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: claude-code-session-3a5b3e5e-a896-467d-8928-23e2a379c777-2026-09-04-user-choice
    captured_at: 2026-09-03T18:30:19Z
    excerpt_sha256: 932f38f8e5e025e95d4b78dda6238af6a25076f73fbdee012d936467061ca396
    verified: true
  - id: S3
    type: session_excerpt
    client: human
    ref: claude-code-session-3a5b3e5e-a896-467d-8928-23e2a379c777-2026-09-04-user-go
    captured_at: 2026-09-03T18:30:19Z
    excerpt_sha256: d9d9fd46221059764242c8b1395cbc81f5bb84e55d73ca8506dea3c12b3a7e7e
    verified: true
---

# auto-capture worker 改為 fresh-first：最近有動的 session 先處理，並修掉 cursor 消失就從頭重來

## 決策背景與決策前狀態

spool（本地緩衝）裡有 12,682 個 session，12,601 個還沒處理完（53 MB）。worker 每輪只處理 1 個，一小時約 16 輪，而且照檔案路徑排序輪流。兩個問題：(1) 處理完一個 session 後檔案會被封存改名，游標找不到原路徑就從頭重來，所以永遠在前段打轉；(2) 就算不重來，CC-memory 排在第 9,724 位，前面有 9,672 個等著，輪到要一個月。整體 8 月只寫了 632 筆、7 月寫了 13,979 筆，不是只有 CC-memory 壞。

## 替代方案及採否理由

只修游標 bug：改動最小，順序照舊。輪一圈要一個月，CC-memory 還是要等很久才有新記憶，比較測試做不了。

## 最終決策與理由

新的先做：修掉游標重來的 bug，並改成「最近有動的 session 先處理」。

理由：Not recorded

## 預期後果及決策後狀態

你今天用的 session 幾分鐘到一小時內就會進記憶；7 月舊 backlog 用空檔慢慢消化，可能永遠消不完，之後另外決定要不要封存。

## 原文溯源

### S1

> 補洞要改 worker（採集背景程式）的處理順序，選哪個做法？
> 
> 背景：spool（本地緩衝）裡有 12,682 個 session，12,601 個還沒處理完（53 MB）。worker 每輪只處理 1 個，一小時約 16 輪，而且照檔案路徑排序輪流。兩個問題：(1) 處理完一個 session 後檔案會被封存改名，游標找不到原路徑就從頭重來，所以永遠在前段打轉；(2) 就算不重來，CC-memory 排在第 9,724 位，前面有 9,672 個等著，輪到要一個月。整體 8 月只寫了 632 筆、7 月寫了 13,979 筆，不是只有 CC-memory 壞。
> 
> - 新的先做（推薦）：修掉游標重來的 bug，並改成「最近有動的 session 先處理」。你今天用的 session 幾分鐘到一小時內就會進記憶；7 月舊 backlog 用空檔慢慢消化，可能永遠消不完，之後另外決定要不要封存。
> - 只修游標 bug：改動最小，順序照舊。輪一圈要一個月，CC-memory 還是要等很久才有新記憶，比較測試做不了。

### S2

> 新的先做（推薦）

### S3

> 好 開始補洞

## 後續結果與沿革

- 2026-09-04：實作於 PR #29（merge commit c53bf4f）：`src/services/capture-worker.ts` 新增 `orderSessionsForTick`（spool 檔 mtime 在 `CC_CAPTURE_FRESH_WINDOW_MS`、預設 72 小時內的 session 先處理、新到舊；其餘依路徑輪流，round-robin cursor 只在 stale 層推進），`rotateSessionsAfterCursor` 在 cursor 路徑消失時改從下一個接續。
