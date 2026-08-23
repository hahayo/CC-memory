# Phase 0 量測：Pre-LLM Elapsed（tick 起點到第一次 llm.extract 前）

> 執行日期：2026-08-23  
> 分支：feature/codex-capture-primary  
> 量測腳本：`scripts/measure-pre-llm-elapsed.ts`  
> spool (本地緩衝) 狀態：18,043 個 session 檔、226 個專案、~120 MB

## 指令

```bash
DATABASE_URL=$(cat ~/.ccm-project-url) npx tsx scripts/measure-pre-llm-elapsed.ts
```

## 量測範圍

從 tick (執行輪次) 起點到**第一次 `llm.extract()` 呼叫前**的完整 elapsed (耗時)，涵蓋：

| 步驟 | 說明 |
|------|------|
| DB health check (資料庫健康檢查) | 對 `~/.ccm-project-url` 的 DSN 執行 `SELECT 1` |
| `totalSpoolBytes` | 遞迴 stat 18,043 個 spool 檔，加總大小 |
| `listSpoolSessions` | 枚舉 226 個專案目錄下的所有 session 路徑 |
| `archiveLegacySidecars` | 掃描舊格式 sidecar (側車) 檔案 |
| `loadTickCursor` | 讀取 cursor (游標) 狀態 |
| 取鎖與狀態讀取 | `acquireSpoolLock` + `loadOrMigrateCaptureState` for each session |
| session 迭代（直到第一個有 processable range 的 session） | 跨越所有 cursor-完成的 session、transcript-unavailable session 等 |

## 量測方式

注入一個 `extract()` 立刻 throw `CaptureLlmValidationError('CAPTURE_LLM_DISABLED')` 的假 adapter (適配器)，
並注入 no-op (空操作) `stateWriter` 防止任何狀態檔寫入。

**確認 CAPTURE_LLM_DISABLED 路徑不會寫 state**：
- throw 後 `runtimeStopped = true`，`snapshotCompleted = false`
- worker 跳過 snapshotCompleted branch（該 branch 才呼叫 stateWriter）
- retry/terminalError 路徑不被走到（error 在 CAPTURE_LLM_DISABLED 分支即 break）
- 因此 no-op stateWriter 足夠；無需改用 CC_READ_ONLY

**副作用說明**：
- `maybeRotateCaptureSpool` 在 cursor-完成的 session 仍被呼叫，嘗試 rename state 檔時因 no-op stateWriter 未建立該檔而得到 ENOENT，外層 catch 接住並計 `result.failed += 1`
- 此失敗不影響 spool 主體檔案（rename 在 state 檔 ENOENT 時中止，spool 檔未動到）
- 此為量測腳本的已知行為，不影響量測正確性

## 10 次原始數字

| Run | total elapsed (ms) | pre-extract elapsed (ms) | db-health (ms) |
|-----|-------------------|--------------------------|----------------|
| 1   | 31,143            | 31,124                   | 463            |
| 2   | 28,893            | 28,880                   | 78             |
| 3   | 27,723            | 27,709                   | 73             |
| 4   | 28,760            | 28,748                   | 75             |
| 5   | 26,078            | 26,065                   | 74             |
| 6   | 24,658            | 24,640                   | 71             |
| 7   | 24,531            | 24,511                   | 70             |
| 8   | 24,269            | 24,257                   | 70             |
| 9   | 25,266            | 25,253                   | 69             |
| 10  | 26,937            | 26,920                   | 69             |

## p95 與最壞值

| 指標 | 值 (ms) | 門檻 58,000 ms | 通過？ |
|------|---------|---------------|--------|
| p95 (第 95 百分位) | **31,124** | 58,000 | ✓ |
| 最壞值 | **31,124** | 58,000 | ✓ |

（p95 與最壞值相同：最長的是 Run 1，受 DB 首次連線冷啟動影響 —— db-health 463 ms vs 後續 69–78 ms。）

## DB health check 分項

| 指標 | 值 (ms) |
|------|---------|
| Run 1（冷啟動）| 463 |
| Run 2–10（暖機後）| 69–78 |
| p95 | 463 |
| 最壞 | 463 |

## 結論

**p95 31,124 ms ≤ 58,000 ms、最壞值 31,124 ms ≤ 58,000 ms，預算鏈無需調整。**

worker 開窗條件 `elapsed + 182,000 ≤ 240,000` 即 `elapsed ≤ 58,000` 滿足。
即使在最壞情況（含 DB 冷啟動）下，pre-LLM overhead 約 31 秒，尚有 27 秒緩衝。

## 備注

- Run 1 的 DB health check 463 ms 為 SSH tunnel 首次握手的冷啟動成本；正式 systemd 執行時 tunnel 長駐，預計恆定在 ~70 ms 範圍。
- pre-extract elapsed 幾乎等於 total elapsed（差值 < 20 ms）：adapter 本身無 LLM 呼叫，tick 一旦 extract() 被呼叫即停止有效工作，後續 session 迭代（剩餘 session 做 ENOENT 失敗計數）耗時極短。
- spool 有 18,043 個 session，大多數為 cursor-完成狀態，實際有 processable range 的 session 為前幾個（worker 依 cursor rotation 順序挑選）。
