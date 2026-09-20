<!-- SSOT_STATUS_BLOCK_START v1.0 -->
SpecConsistency:
  status: PENDING
  verification_basis: 本次工作階段收尾規格；首輪連動檢查三項發現已修，待針對性複查。
  last_checked_diff_hash: cead90a5d5ad
  audit_tool_version: 1.3.1
  audit_scope_hash: 82f4bc142784a14b2db24e764cf99529da9bcf205ef74ea34fcf71607dd0ad0f
  checked_tree_hash: 9740843
  checked_tree_note: 基底提交；目前待驗證，不宣稱對應最終內容。
  audit_command: node /home/haha/.claude/hooks/spec-cascade-check.js --mode review --force-cascade --paths docs/auto-capture-v0.5/spec.md,docs/auto-capture-v0.5/plan.md,docs/auto-capture-v0.5/task.md,CLAUDE.md --status-block-path .claude/spec-status.md --codex-timeout 480
CascadeTerms: ["工作階段收尾", "Session Finalization", "最後一窗說了算", "收尾成功後以收尾摘要為準", "21600000", "65536", "1800000", "/session-close", "finalize_retry", "CC_CAPTURE_FINALIZE_QUIET_MS"]
AffectedSections: ["docs/auto-capture-v0.5/spec.md#Session Finalization", "docs/auto-capture-v0.5/plan.md#Session Finalization Environment Variables", "docs/auto-capture-v0.5/task.md#工作階段收尾（2026-09-20 甲案）", "CLAUDE.md#Skills", "CLAUDE.md#Environment Variables"]
UnresolvedItems: ["三项連動發現已修；待工具確認閉環"]
LastCascadeAudit:
  date: 2026-09-20T16:29:23.491791+00:00
  result: INCONSISTENT（首輪）；技能漏列已補，新增表格移至末尾，既有行號錨點未再位移。
ChangedPaths: ["docs/auto-capture-v0.5/spec.md", "docs/auto-capture-v0.5/plan.md", "docs/auto-capture-v0.5/task.md", "CLAUDE.md", "skills/session-close/SKILL.md", ".claude/spec-status.md"]
<!-- SSOT_STATUS_BLOCK_END -->

以下保留本機既有歷史稽核紀錄，不作為本次通過證據。

<!-- HISTORICAL_STATUS_BLOCK_START v1.0 -->
SpecConsistency:
  status: PENDING
  verified_at: 2026-07-05
  verification_basis: |
    v0.5 auto-capture SDD change set（commits e322a50 + 掃尾 a766c1d/4c99a9b/84103f6）。
    7 輪完整 audit（R1-R3 pre-commit working tree；R5b/R6/R7 於 audit worktree 對已 commit 內容重現 diff）：
      R1: INCONSISTENT 5 → 全修（root trio 檔頭/Non-goals/執行計畫 M1 pending_observations）
      R2(deep): INCONSISTENT 11 → 全修（root trio 深層 Phase C 章節 12 處 inline SUPERSEDED marker）
      R3: INCONSISTENT 2（皆 repo 外 plan archive 舊測試基準）→ 全修；repo 內全數 still_valid
      R4: DETECTOR_FAILURE（codex usage limit）；R5: LOW_SKIPPED 假象（commit 後空 diff，不採）
      R5b(worktree): INCONSISTENT 7 → 全修（commit a766c1d：root docs Phase A Zeabur 5 處 + load-memory skill + 執行計畫 Phase 3 雙側部署）
      R6: INCONSISTENT 7 → 全修（commit 4c99a9b：personal-hub Zeabur 13 處 + ADR-001 provider 後記 + retrieval-eval）
      R7: INCONSISTENT 16 → 全修（commit 84103f6：personal-hub Phase 3 交付狀態簿記 + 根 task.md Phase C 驗收段 marker）
      R8: operator-killed（0 output）——使用者中止，依既定停損收斂
    **關鍵事實**：v0.5 變更集本體（docs/auto-capture-v0.5/**、v0.4 SUPERSEDED markers、INDEX.md）自 R3 起每一輪完整 audit 均 still_valid、零 finding；R5b 之後所有 unresolved 皆為與本變更集無關的前存 corpus 債（Track 2/3 交付簿記與 Zeabur 殘留），且已全數修畢。
  deviation_note: |
    閉環硬條件 (a)「最近一次 audit verdict=OK」未滿足——R8 被操作者中止。
    人工裁決依據：84103f6 的 delta（11 行）與 R7 enumerated findings 1:1 對映（本 session 逐項核對）；
    Track 3 先例（2026-07-01）允許 documented manual judgement 收斂。
    殘留風險登記於 UnresolvedItems: corpus-debt-backlog。
  last_checked_diff_hash: 325fd7addff0
  last_checked_diff_note: |
    R7（最後完成輪）對 c24641b→4c99a9b 內容之 diff；84103f6 delta 未經機器複驗（見 deviation_note）。
    2026-07-06 mini-cascade（OQ1 RESOLVED change set）：spec.md OQ1 標 RESOLVED（additive，判準原文保留）
    + plan.md Dependencies 表 2 項標已解除 + 新檔 oq1-gate-report.json + prod-runbook 套用紀錄。
    人工 cascade：中英並查 timestamp/排序/offset/OQ1——task.md:100 thin event 含 timestamp 欄位為
    記錄用非排序用，與新斷言「timestamp 不可當寫入順序信號」不矛盾；其餘命中皆 search ranking 無關。
    工具 unresolved 5 項皆 Status Block 既有登記之 known drift，非本次引入。
    Codex 對審（codex review，單輪收斂）：P2「byte-offset 排序需 cascade 到 cc_memory_timeline
    （task.md:192 依 observed_at 排鄰接）」——採納：spec OQ1 註記補連帶影響 + task.md M3 3b 標
    PENDING（observed_at 賦值單調紀律 vs additive offset 欄位，M2b 開工定案、M3 timeline 前必解）。
    修法粒度偏離 Codex 原建議（其建議直接改 schema 持久化 offset）：M1 schema 已上 prod，
    加欄位屬 M2b additive 決策，spec 層先記賦值紀律即可。
    2026-07-06 深夜 mini-cascade 2（observed_at PENDING 定案，commit 828adab）：工具 verdict OK/
    unresolved 0（searched_terms 23，Changed Assertions 表與人工分析一致）。
    2026-07-07 mini-cascade 3（capture LLM 改 claude-cli，使用者拍板，commit 82bbf5a）：人工
    cascade——中英並查 Gemini Flash/gemini-flash/GEMINI_API_KEY/CC_CAPTURE 全引用點（spec:39/51/
    159/171/186、plan:29/129/241-242/303、task:118/134-135、m2b-cron-draft），同 commit 全數修正
    （歷史對照表加後記不改原文；紅線 3 改版；env 表加 CC_CAPTURE_CLAUDE_MODEL）；新增斷言
    「遞迴 capture 斷路器」入 plan 污染防線。未重跑工具 review（已 commit 後 diff-based 工具
    需 audit worktree 重現，本輪引用點窮舉 + 同 commit 修正證據鏈充分，人工 judgement 收斂）。
    2026-08-23 mini-cascade 4（capture 主力改 codex-cli、haiku 備援、bwrap 沙箱、Go/No-Go 降 canary，
    使用者拍板，分支 feature/codex-capture-primary commit 111e4f4）：人工 cascade——紅線 3 反轉
    加 2026-08-23 修訂段（不改原文）；spec:41/53 後記；plan 架構圖/env 表/斷路器/交付說明；
    task M2b；cutover §0/§2.5/§9 七條替換；production-readiness 三硬指標改 advisory；決策卡草稿
    DEC-20260823T044312Z（proposed，待人工接受）。實作計畫與沙箱驗收報告見
    docs/auto-capture-v0.5/plans/ 與 sandbox-acceptance-2026-08-23.md。
  audit_tool_version: 1.3.0
  checked_tree_hash: 1eb4e75162797ffd2074044212b41df94eed11c9
  checked_tree_note: 4c99a9b^{tree}（R7 audit 對應內容）；最終內容 84103f6^{tree}=b0c0a6e48ff1771534578c54b9844d126b49bc09
  audit_command: node ~/.claude/hooks/spec-cascade-check.js --mode review --status-block-path .claude/spec-status.md（於 audit worktree 內以 git restore --source=<commit> 重現已 commit diff 執行）
CascadeTerms: ["auto-capture v0.5", "observations", "session rollup", "canonical rollup", "session_summaries", "pending_observations", "capture-runner", "reinject", "discovery_tokens", "cc_memory_timeline", "cc_memory_get_observations", "refine_delete", "Gemini Flash", "Claude CLI subprocess", "CC_CAPTURE_LLM", "codex-cli", "gpt-5.6-luna", "gpt-5.6-sol", "CC_CAPTURE_LLM_FALLBACK", "bwrap", "CC_MEMORY_INJECT_RECENT", "CC_MEMORY_INCLUDE_OBSERVATIONS", "CC_MEMORY_SKIP_TOOLS", "spool", "hwm_offset", "0011_add_observations", "0012_observations_no_personal_check", "0013_observations_personal_only_check", "248 tests", "306+", "490+", "592 tests", "RAM 三紅線", "v0.4 決策覆寫表", "三側 schema 矩陣", "SUPERSEDED", "Stage 2", "Phase C", "Zeabur", "Coolify", "roadmap", "已交付"]
AffectedSections: ["docs/auto-capture-v0.5/spec.md（新檔全文，v0.5 SoT）", "docs/auto-capture-v0.5/plan.md（新檔全文）", "docs/auto-capture-v0.5/task.md（新檔全文）", "docs/INDEX.md#Track 總表/長期目標/文件清單/版號說明", "docs/spec.md#檔頭 scoped blanket + v0.4 方向調整 + US 列表 + Phase C section + Non-goals 註 + Scope 註 + Constraints×2 + 必守 + 品質閘 + 驗收 marker + Phase A Constraints Coolify", "docs/plan.md#檔頭 + Phase 劃分 + 架構圖 + env 表 + Data Model marker + Files Impact marker + Phase C rollout marker + 風險表 + Phase B Deployment 標題", "docs/task.md#檔頭 + Phase 劃分 + Phase C section marker + Phase C 驗收段 marker", "docs/superpowers/{specs,plans} 兩檔 top banner", "docs/personal-hub/{spec,plan,task}.md#Phase 3 交付狀態 + Zeabur→Coolify 全面", "docs/personal-hub/decisions/ADR-001#provider 遷移後記", "docs/retrieval-eval.md#prod 註解", "skills/load-memory.md#範例", "（repo 外）~/.claude/plans/plan-mode-plan-radiant-coral.md#M1 表/測試基準×2/Phase 3 部署"]
UnresolvedItems:
  - id: corpus-debt-backlog
    type: known_drift_backlog
    text: "corpus 他處可能仍有與 v0.5 變更集無關的歷史債（LLM audit 每輪抽樣不同區域，R5b-R7 各挖出不同批）"
    reason: "非本變更集引入；已修 41 項（去重）。後續任何 spec 改動的 audit 會繼續逐步開採；若要一次清完可另開『corpus 歷史債總盤點』任務（非 v0.5 M1 前置）。"
  - id: plan.md:23
    type: intentional_residual
    text: "Source of truth：./spec.md"
    reason: "（Track 3 audit 2026-07-01 登記，仍有效）metadata 行表達 Plan A 階段 SoT 鏈接歷史事實；行號指 docs/migrations/2026-06-29-cc-memory-project-cutover/plan.md。"
  - id: task.md:35
    type: intentional_residual
    text: "Source of truth：./spec.md + ./plan.md"
    reason: "（Track 3 登記，仍有效）同 plan.md:23；行號指 cutover task.md。"
  - id: task.md:768
    type: intentional_residual
    text: "cutover 前 vs 後 top-5 結果完全一樣"
    reason: "（Track 3 登記，仍有效）Plan A reference anchor 原文保留；inline marker 已明示 Plan B 期望；行號指 cutover task.md。"
  - id: task.md:782
    type: intentional_residual
    text: "dump 檔路徑（scratchpad）：保留 30 天"
    reason: "（Track 3 登記，仍有效）同 task.md:768；行號指 cutover task.md。"
LastCascadeAudit:
  date: 2026-07-05
  operator: claude (Fable 5 main loop；spec-cascade-check.js 7 完整輪 + Codex gpt-5.5 起草/修訂 2 輪對審 + manual judgement on R8 中止收斂)
  scope: docs/** 全 corpus + skills/ + CLAUDE.md + ~/.claude/plans archive（hook 內建 corpus 定義）
  result: |
    v0.5 SDD change set cascade audit 收斂於 4 個 commit：
      e322a50（SDD 三件套 + R1/R2 修正）→ a766c1d（root Zeabur 掃尾）→
      4c99a9b（personal-hub Zeabur 掃尾）→ 84103f6（Phase 3 交付簿記）。
    Why VERIFIED with deviation: R8 operator-killed；v0.5 本體四輪零 finding；
    R7 findings 與 84103f6 修正 1:1 人工對映；殘留為 corpus 歷史債 backlog（與變更集無關）。
ChangedPaths: ["docs/auto-capture-v0.5/{spec,plan,task}.md", "docs/{INDEX,spec,plan,task}.md", "docs/superpowers/specs/2026-04-22-auto-capture-design.md", "docs/superpowers/plans/2026-04-23-v04-phase-c-implementation.md", "docs/personal-hub/{spec,plan,task}.md", "docs/personal-hub/decisions/ADR-001-phase3-separate-db.md", "docs/retrieval-eval.md", "skills/load-memory.md", ".claude/spec-status.md"]
<!-- HISTORICAL_STATUS_BLOCK_END -->

<!-- session-finalize audit: 2026-09-21 -->
工作階段收尾規格連動檢查進行中；首次沙箱初始化失敗，升權後逾時，尚無通過結論。
