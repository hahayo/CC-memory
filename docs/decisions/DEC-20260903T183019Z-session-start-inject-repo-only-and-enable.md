---
id: DEC-20260903T183019Z-session-start-inject-repo-only-and-enable
title: SessionStart 注入：DSN 一律讀 ~/.ccm-project-url、非 git 且無 marker 不注入、開關 CC_MEMORY_INJECT_RECENT 打開
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
    ref: claude-code-session-3a5b3e5e-a896-467d-8928-23e2a379c777-2026-09-03-plan-hard-conditions
    captured_at: 2026-09-03T18:30:19Z
    excerpt_sha256: af97b83370b52662dfadf489914a44b842a6134a840b5a334958caea6d089eb2
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: claude-code-session-3a5b3e5e-a896-467d-8928-23e2a379c777-2026-09-03-plan-approval
    captured_at: 2026-09-03T18:30:19Z
    excerpt_sha256: c7c7f5db1814de2eb48dc874022d021daad36c47d5841ba8618981174190caab
    verified: true
---

# SessionStart 注入：DSN 一律讀 ~/.ccm-project-url、非 git 且無 marker 不注入、開關 CC_MEMORY_INJECT_RECENT 打開

## 決策背景與決策前狀態

Not recorded

## 替代方案及採否理由

Not recorded

## 最終決策與理由

SessionStart 注入只在能解析出有效 git 根目錄或有效 CLAUDE.md marker 時才注入；否則不注入。DATABASE_URL 一律被 `~/.ccm-project-url` 覆蓋，不信任繼承值。PR merge 後在 `~/.claude/settings.json` 的 `env` 加 `"CC_MEMORY_INJECT_RECENT": "on"`。不動注入內容豐富度（20 條 rollup 摘要／1200 token）、不關 claude-mem——兩套並跑幾天再決定。

理由：避免啟動環境殘留舊 DSN／測試 DSN／personal DSN 被直接沿用；避免不相干的同名目錄（例如 `/tmp/CC-memory`）注入到真正 CC-memory 專案的近期活動。

## 預期後果及決策後狀態

回復方式：復原備份或刪該行。

## 原文溯源

### S1

> 目標：注入正確、打開、可驗證。**不動**注入內容豐富度（20 條 rollup 摘要／1200 token）、**不關** claude-mem——兩套並跑幾天再決定。
> 
> 1. **DATABASE_URL 一律被 `~/.ccm-project-url` 覆蓋，不信任繼承值。** 不是「未設定才讀檔」，是「一律讀檔覆蓋」——避免啟動環境殘留舊 DSN／測試 DSN／personal DSN 被直接沿用。
> 
> 4. **非 git 目錄的政策要先拍板**：`resolveProjectId` 在找不到 git 根目錄時會退到 `basename(cwd)`，可能讓不相干的同名目錄（例如 `/tmp/CC-memory`）注入到真正 CC-memory 專案的近期活動。**採用建議方案：SessionStart 注入只在能解析出有效 git 根目錄或有效 CLAUDE.md marker 時才注入；否則不注入**（不是「不炸」，是「不注入」）。
> 
> 合併前先用暫時 export 的 `CC_MEMORY_INJECT_RECENT=on` 做真 DB 驗證。全部通過、PR merge 後才動 `~/.claude/settings.json`：備份、暫存檔寫入、JSON parse 驗證、原子替換，`env` 加 `"CC_MEMORY_INJECT_RECENT": "on"`；記錄改動前後兩份供比對。回復方式：復原備份或刪該行。

### S2

> Implement the following plan:

## 後續結果與沿革

- 2026-09-03：實作於 PR #28（merge commit 2d65293）；`~/.claude/settings.json` 已加 `CC_MEMORY_INJECT_RECENT=on`（備份 `settings.json.bak-inject-20260903-230459`）。
