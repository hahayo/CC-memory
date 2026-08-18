---
id: DEC-20260818T125648Z-redact-embedding-egress-and-backfill-with-gemini-001
title: 遮蔽 embedding 外送內容並以 gemini-embedding-001 完成補算
status: active
decided_at: 2026-08-18T20:56:48+08:00
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: session_excerpt
    client: human
    ref: current-session-user-go-embedding-001
    captured_at: 2026-08-18T20:56:48+08:00
    excerpt_sha256: 8c14e333b28bb62d77b2be90ba1e7ee34c07716724b9cb5b89c7d6afc8726f0b
    verified: true
---

## 決策背景與決策前狀態

Not recorded

## 替代方案及採否理由

Not recorded

## 最終決策與理由

沿用 Paid Tier 的 `gemini-embedding-001`；在 embedding egress（向量資料送出邊界）對敏感片段做 deterministic redaction（可重現遮蔽），資料庫原文不變；先跑 500 筆並完成 Fable 5 code review（程式碼審查），再執行全量 embedding backfill（向量補算）與 hybrid benchmark（混合檢索基準測試）。

理由：Not recorded

## 預期後果及決策後狀態

Not recorded

## 原文溯源

### S1

> 好 那就go吧

## 後續結果與沿革

Not recorded
