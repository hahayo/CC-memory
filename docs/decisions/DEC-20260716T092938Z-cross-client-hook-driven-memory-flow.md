---
id: DEC-20260716T092938Z-cross-client-hook-driven-memory-flow
title: Claude Code 與 Codex 共用 hooks（掛鉤）驅動記憶流程
status: active
decided_at: 2026-07-16T17:29:38+08:00
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: session_excerpt
    client: human
    ref: current-session-user-no-hermes
    captured_at: 2026-07-16T17:29:38+08:00
    excerpt_sha256: 8621af86b013dbb84c5175e3f78b9ac692c9188116da5e5444b171c6bf0e5d61
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: current-session-user-use-hooks
    captured_at: 2026-07-16T17:29:38+08:00
    excerpt_sha256: 6ec95b2da3f6419641b4b3718c4725ce9610047ad0f918172de377fcc74c8f78
    verified: true
  - id: S3
    type: session_excerpt
    client: human
    ref: current-session-user-include-codex
    captured_at: 2026-07-16T17:29:38+08:00
    excerpt_sha256: 2e7ebc90674fd45553a64441871e036b2330b7cc611b0d55a3289d54b4b36225
    verified: true
  - id: S4
    type: session_excerpt
    client: human
    ref: current-session-user-semantics-confirmed
    captured_at: 2026-07-16T17:29:38+08:00
    excerpt_sha256: 0febcc086a69c1d3cf1ca14af84e8e41524128526d45605c81d0d45773fcd1d3
    verified: true
---

## 決策背景與決策前狀態

是說 應該調用hooks 來處理這件事 參考 claude-mem的作法

## 替代方案及採否理由

Not recorded

## 最終決策與理由

Claude Code 與 Codex 共用 PostToolUse、Stop、SessionStart hooks（掛鉤）。PostToolUse 只 append（附加）本地 spool（緩衝暫存區）；Stop 先 append sentinel（哨兵），再快速 kick（觸發）`cc-memory-auto-capture.service`；SessionStart 注入 recent activity（近期活動），並快速 kick backlog（待處理積壓）。`cc-memory-auto-capture.service` 是 systemd oneshot supervisor（單次執行監督服務），不使用 timer（計時器），也不由 Hermes 驅動。reminders（提醒）與 Todoist 使用 systemd timers。不建立常駐 memory daemon（記憶守護程序）。

理由：我不要靠hermes來驅動

## 預期後果及決策後狀態

Not recorded

## 原文溯源

### S1

> 不確定 你是指什麼 但我這東西 排成 我不要靠hermes來驅動

### S2

> 是說 應該調用hooks 來處理這件事 參考 claude-mem的作法

### S3

> 好 照你建議 不過提醒: 除了claude code要用這套機制以外 codex也需要

### S4

> cross-client semantics confirmed

## 後續結果與沿革

- 2026-07-17：Claude Code 與 Codex 均已追加共用 SessionStart hook；五個 systemd user units 已安裝，沒有 auto-capture timer。
- 2026-07-17：reminder／Todoist 手動 services 與首輪 timers 均 PASS，三個 Hermes jobs 全部 paused。
- 2026-07-17：auto-capture quick-kick 已到達 systemd，但因 memory 專用 `~/.ccm-memory-alert.env` 尚未建立而安全跳過；Codex 新 hook 尚待 `/hooks` 人工信任。
