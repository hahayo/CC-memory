---
id: DEC-20260823T044312Z-codex-primary-haiku-fallback-sandbox
title: auto-capture 主力 LLM 改 codex-cli，haiku 降為 fallback，並採 bwrap+execpolicy 沙箱
status: proposed
decided_at: 2026-08-23T04:43:12Z
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: session_excerpt
    client: human
    ref: docs/auto-capture-v0.5/sandbox-acceptance-2026-08-23.md
    captured_at: 2026-08-23T04:43:12Z
    excerpt_sha256: 5ebfc10435eb08b368a5329c275b2bb62e6f1d3f29d15990561f8c45c71e7cb3
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: docs/auto-capture-v0.5/phase0-measurement-2026-08-23.md
    captured_at: 2026-08-23T04:43:12Z
    excerpt_sha256: 8b34c1ffbd2b98536e5b490551034f52c6106496adb0f416e184293f7481f39b
    verified: true
  - id: S3
    type: session_excerpt
    client: human
    ref: docs/auto-capture-v0.5/plans/2026-08-23-codex-primary-haiku-fallback.md
    captured_at: 2026-08-23T04:43:12Z
    excerpt_sha256: fc04fc0ee7d8ad810f844d9fad782a60618776a99cb18d49d2c64eb59671d6a7
    verified: true
---

# auto-capture 主力 LLM 改 codex-cli，haiku 降為 fallback，並採 bwrap+execpolicy 沙箱

## 決策背景與決策前狀態

CC-memory v0.5 auto-capture（自動採集）worker 自 2026-07-07 拍板後使用 claude-cli/haiku 作為預設 LLM provider（大型語言模型提供者）。2026-08-23 前，正式 systemd（系統服務管理）unit 設定 `CC_CAPTURE_LLM=claude-cli`、`CC_CAPTURE_CLAUDE_MODEL=haiku`。

Phase 0 量測（measurement）結果：p95 pre-LLM elapsed（LLM 呼叫前的啟動耗時）= 31.1 s（見 S2）。

## 替代方案及採否理由

**方案 A：維持 claude-cli/haiku 為主力（不改動）**
否決理由：codex-cli 與 Claude Code 共用對話歷史（context（上下文））且使用獨立配額（quota（使用量限制）），更不佔用 Claude Code 訂閱額度；2026-07-07 的「訂閱已付優先」精神在 codex-cli 同樣成立。

**方案 B：改 gemini-flash 為主力**
否決理由：需另付 API 費，與 2026-07-07 拍板精神相悖。

## 最終決策與理由

正式 systemd unit 改為：
- 主力：`CC_CAPTURE_LLM=codex-cli`，`CC_CAPTURE_CODEX_MODEL=gpt-5.6-sol`，逾時 90 s
- 自動 fallback（退回）：`CC_CAPTURE_LLM_FALLBACK=claude-cli`，haiku，75 s
- gemini-flash 仍為可切選項（需 `GEMINI_API_KEY`）
- 程式碼預設值（`DEFAULT_CAPTURE_LLM_PROVIDER`）維持 `claude-cli` 不變，由 unit 環境變數覆蓋

予算鏈（budget chain（時間預算鏈））：codex 90 s + claude 75 s + 2×1 s killGrace + 15 s settle = 182 s reserve < tick 240 s < supervisor 270 s < TimeoutStartSec 300 s。

codex-cli 子程序採 bwrap（bubblewrap 沙箱工具）+ execpolicy（執行策略白名單）兩層防護，以純文字模式（pure text mode）運行——codex-code-mode-host 未掛載（confirmed by sandbox-acceptance S1，14/14 tests pass）。

spec.md 紅線 3 修訂：2026-07-07「便宜模型優先」精神保留，具體 provider 因 codex-cli 獨立配額優勢而更換。

## 預期後果及決策後狀態

1. auto-capture 正式 unit 以 codex-cli 為主力抽取 observation（觀察記錄），claude-cli 為自動備援。
2. Benchmark（基準測試）降為 advisory（參考用），不再是 Go/No-Go 前置硬閘門；readiness checker（就緒檢查器）文案與測試同步更新。
3. `CC_CAPTURE_MAX_WINDOWS_PER_TICK=1` 限制每 tick（執行輪次）最多一個抽取窗口，canary（金絲雀測試）期間保守控制。
4. 殘留接受風險：codex `auth.json` 在 bwrap 沙箱內可讀（已明示接受，見 S1）；沙箱 execpolicy 精確政策為 placeholder，由 Phase 2 L1–L3 fail-closed（失敗關閉）驗收兜底。

## 原文溯源

### S1

> `sandbox-acceptance-2026-08-23.md`：14/14 tests pass（L1×6 確定性探測、L2×1 對抗式探測、L3×7 功能正向）。codex-code-mode-host 未掛載，確認純文字模式。L2 通過條件：事件流無任何 tool call 事件且輸出合法 JSON。

### S2

> `phase0-measurement-2026-08-23.md`：p95 pre-LLM elapsed = 31.1 s。

### S3

> `plans/2026-08-23-codex-primary-haiku-fallback.md`：Round 8 定稿候選，Codex 對審七輪收斂；§9 替換版本（七項）；cascade 檢查清單。

## 後續結果與沿革

草稿。待使用者審閱並確認 `supersedes`（取代）與 `related_to`（相關）欄位後升格為 active。
