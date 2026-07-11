---
name: save-decision
description: Use when a high-value repository decision has been explicitly settled, or when the user asks to 存決策, save decision, 記這個決策, 開決策卡, or 翻案.
---

# Save Decision

## Core rule

Record one explicitly settled architecture（架構）, behavior（行為）, or config（設定） decision as one reviewable Git（版本控制） draft（草稿）. A proposed draft has no decision authority.

## HARD STOP — `NOT_SETTLED`

Evaluate this predicate（判定條件） before generating an ID（識別碼） or performing any write:

If any current request or current-session statement describes the decision's current state as **undecided, unselected, still discussing, tentative, or options open**, that fact controls—even when the same prompt names an option or commands “write,” “formalize,” or “commit” it. Stop immediately. Permit only read-only Git status（版本控制狀態） and contract/index checks. Generate no ID; create no draft or formal card; change no index or status; run no validator（驗證器）; make no commit（提交）.

Return exactly:

```text
NOT_SETTLED
Open choice: <concise unresolved choice>
Files changed: none
Commit: none
```

Proceed only with actual human selection evidence: an affirmative statement from a person with decision authority that selects the outcome. Never invent an approver, source, rationale, benchmark, metric, or other decision number.

| Red flag or rationalization（合理化藉口） | Required interpretation |
|---|---|
| “Write, formalize, or commit option X now” or naming X | File-operation pressure is not selection evidence. |
| Deadline, manager request, or handoff（交接） urgency | Pressure cannot settle an open choice. |
| “Don't ask” or “we can correct it later” | Neither erases an explicit unsettled statement. |

## Workflow（工作流程）

### 1. Gate the repository and decision

1. Locate the Git root, inspect its dirty state（未提交狀態）, and preserve unrelated work.
2. On every invocation, re-read repository instructions, `docs/decisions/README.md`, and `docs/decisions/INDEX.md`. They are the runtime SSOT（執行期單一真相來源） for fields, lifecycle, sources, index shape, and validation. Never infer those from this skill.
3. If either decision contract file is missing, stop and invoke `setup-decision-wiki`; never create a partial Wiki（知識庫）.
4. If `NOT_SETTLED` did not fire, verify direct human evidence explicitly selects one high-value outcome. Split multiple settled decisions into separate runs.

### 2. Create one exact proposed draft

1. Read the actual system clock（系統時鐘） and use it for the UTC（世界協調時間） ID and `captured_at`. Use an explicit human-provided decision time for `decided_at`; when none was supplied, use the actual current time. Never invent or round a timestamp. Create only `docs/decisions/_draft/<id>.md` with `status: proposed`.
2. Copy the exact frontmatter（檔頭） shape from the current README. Keep all four relationship fields in its required inline-array（行內陣列） syntax—for example, `supersedes: [DEC-...]` and `related_to: [DEC-...]`, never indented block lists.
3. A source excerpt is not a summary. Copy the selected source text into the visible blockquote byte-for-byte, except for the minimum substitution of each sensitive span with `[REDACTED]`. Do not add or paraphrase approval, locator, or explanation lines inside the blockquote. Store the durable locator（定位資訊） only in source metadata（中繼資料）. Normalize and SHA-256（安全雜湊演算法） hash exactly that visible redacted text as the repository specifies.
4. Never retain a full transcript（逐字紀錄） or invent provenance（溯源資訊）. Use only supplied or repository-established decision facts. When required rationale, alternatives, consequences, or outcomes are absent, write `Not recorded` or the repository's equivalent instead of filling gaps.

### 3. Constrain relationships and supersession

- Treat semantic similarity（語意相似度） only as an unpersisted hypothesis.
- Persist only `supersedes`, `depends_on`, `conflicts_with`, or `related_to`, and only when a human explicitly confirms that exact relationship. Otherwise leave it empty.
- A reversal creates a new proposed card pointing to the old formal record. Never revise the old decision body. After acceptance, change only the old card's lifecycle status to `superseded`.

### 4. Validate before preview

After writing the proposed draft and its confirmed relationships, run the validator named by the current repository contract against the draft/corpus. Fix every draft-caused mechanical failure, including exact inline-array syntax, and rerun until it exits `0`. Never preview an invalid draft. If validation is unavailable, remains nonzero, or exposes only out-of-scope existing failures, stop with the exact output; do not edit unrelated files or ask for acceptance.

### 5. Preview verbatim and confirm sequentially

Only after pre-preview validation exits `0`, show the entire draft file verbatim（逐字） in one fenced code block（圍欄程式碼區塊）, from the opening `---` through the final body line. Never replace any content with “Body complete,” an ellipsis, a summary, or omitted sections.

Use separate questions and wait for a separate user turn（使用者回合） after each applicable gate:

1. **Gate 1（關卡一） — exact draft acceptance:** ask only whether the displayed exact draft is accepted for formal landing. Make no formal change before an explicit yes.
2. **Gate 2 — sensitive-redaction safety:** only after Gate 1 passes, and only for sensitive sources, ask separately whether the displayed redaction and retained provenance are safe. Make no formal change before an explicit yes.

Silence, pressure to skip questions, and an earlier general request to formalize satisfy neither gate.

### 6. Land, validate, then ask about commit

After all applicable gates pass, change the new card to `active`, move it out of `_draft/`, add exactly one `./<id>.md` index row, and—when superseding—change only the old card's status. Preserve the old accepted body byte-for-byte.

Run the repository validator again after formal landing. On a nonzero result, stop, report the exact failure, keep all changes uncommitted, and do not ask about commit. On exit `0`, review the complete diff（差異） and prove unrelated work is excluded.

Only then start **Gate 3 — commit authorization** in a new, separate question: ask whether to commit exactly the new card, the necessary old-card status change, and `docs/decisions/INDEX.md`. Never combine Gate 3 with draft acceptance or sensitive-redaction confirmation, and never treat an earlier commit demand as this post-validation authorization.

If Gate 3 passes, commit only that exact scope. Never commit or push（推送） automatically, include unrelated files, or push as part of this workflow.
