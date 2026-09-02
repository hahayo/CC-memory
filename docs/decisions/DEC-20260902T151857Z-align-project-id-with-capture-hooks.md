---
id: DEC-20260902T151857Z-align-project-id-with-capture-hooks
title: project_id 解析對齊 capture hooks：server 第 4 層改為 git 根目錄名，不再用 git origin owner/repo
status: active
decided_at: 2026-09-02T15:18:57Z
scope: CC-memory
supersedes: []
depends_on: []
conflicts_with: []
related_to: []
sources:
  - id: S1
    type: session_excerpt
    client: claude-code
    ref: claude-code-session-01JRTNhnQcsX1cLBMh2EHfWS-2026-09-02-option-block
    captured_at: 2026-09-02T15:18:57Z
    excerpt_sha256: ca3c1c70c8abd235bd81b6ff6871b8b3d943e652743c12976071d582a7895a47
    verified: true
  - id: S2
    type: session_excerpt
    client: human
    ref: claude-code-session-01JRTNhnQcsX1cLBMh2EHfWS-2026-09-02-user-reply
    captured_at: 2026-09-02T15:18:57Z
    excerpt_sha256: 559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd
    verified: true
---

# project_id 解析對齊 capture hooks：server 第 4 層改為 git 根目錄名，不再用 git origin owner/repo

## 決策背景與決策前狀態

Codex 堅持的一點：沒有 CLAUDE.md 標記、但有 GitHub 遠端的 repo（例如 recycling-recognition），hook 寫的專案名是 `recycling-recognition`，MCP server 搜尋時卻用 `hahayo/recycling-recognition`，兩邊對不上。這問題改版前就有，不是這次弄壞的。

## 替代方案及採否理由

選項 B：hook 也改用 `hahayo/xxx` 格式。但舊資料會跟新資料分家。

## 最終決策與理由

選項 A：server 那邊拿掉「用 GitHub 遠端當名字」那一層，全部以「標記 → 根目錄名」為準，跟 hook 一致。

理由：跟 hook 一致。舊資料不用動。

## 預期後果及決策後狀態

Not recorded

## 原文溯源

### S1

> Codex 堅持的一點：沒有 CLAUDE.md 標記、但有 GitHub 遠端的 repo（例如 recycling-recognition），hook 寫的專案名是 `recycling-recognition`，MCP server 搜尋時卻用 `hahayo/recycling-recognition`，兩邊對不上。這問題改版前就有，不是這次弄壞的。
> - **選項 A（我選這個）**：server 那邊拿掉「用 GitHub 遠端當名字」那一層，全部以「標記 → 根目錄名」為準，跟 hook 一致。舊資料不用動。
> - **選項 B**：hook 也改用 `hahayo/xxx` 格式。但舊資料會跟新資料分家。

### S2

> A

## 後續結果與沿革

- 2026-09-02：實作於 PR #22（`src/services/projects.ts` 第 4 層改為 `findRepoRoot` 的根目錄 basename，`src/utils/repo-name.ts` 移除）。Codex 對審指出跨裝置一致性自此為條件式：需 CLAUDE.md marker 相同或 clone 目錄名相同，已寫入 `docs/spec.md` US-2 與 `docs/auto-capture-v0.5/memory-ops-cutover.md` §4.1。
