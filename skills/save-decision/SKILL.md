---
name: save-decision
description: Use when a high-value repository decision has been explicitly settled, or when the user asks to 存決策, save decision, 記這個決策, 開決策卡, or 翻案.
---

# Save Decision

## Core rule

Record one explicitly settled architecture（架構）, behavior（行為）, or config（設定） decision as one reviewable Git（版本控制） draft（草稿）. A proposed draft has no decision authority. Urgency, handoff（交接） pressure, or “write one option for now” never settles an unresolved choice.

## Workflow（工作流程）

### 1. Gate the repository and decision

1. Locate the Git root, inspect its dirty state（未提交狀態）, and preserve unrelated work.
2. On every invocation, re-read repository instructions, `docs/decisions/README.md`, and `docs/decisions/INDEX.md`. They are the runtime SSOT（執行期單一真相來源） for fields, lifecycle, sources, index shape, and validator（驗證器）. Never infer those from this skill.
3. If either decision contract file is missing, stop and invoke `setup-decision-wiki`; never create a partial Wiki（知識庫）.
4. Require an authorized human to have explicitly selected one high-value outcome. If the choice remains unsettled, create no ID（識別碼）, draft, formal card, index or status edit, or commit（提交）; report the open choice. Split multiple settled decisions into separate runs.

### 2. Create one safe proposed draft

1. Generate a fresh UTC（世界協調時間） ID in the repository-required `DEC-YYYYMMDDTHHMMSSZ-<slug>` form. Create only `docs/decisions/_draft/<id>.md` with `status: proposed`.
2. Require each source to have a durable locator（定位資訊）, a short visible excerpt, and SHA-256（安全雜湊演算法）. Never invent missing provenance（溯源資訊） or retain a full transcript（逐字紀錄）.
3. Redact secrets, credentials, personal data, and other non-Git content first. Normalize the visible redacted blockquote exactly as the repository contract specifies, then hash those exact UTF-8 bytes. The stored excerpt must reproduce the hash. Never retain or hash hidden plaintext absent from the card.
4. Fill every repository-required section without inventing rationale, alternatives, consequences, or approval. If a required locator or reproducible redacted hash is unavailable, stop and request it; do not draft.

### 3. Constrain relationships and supersession

- Treat semantic similarity（語意相似度） only as an unpersisted hypothesis.
- Persist only `supersedes`, `depends_on`, `conflicts_with`, or `related_to`, and only when a human explicitly confirms that exact relationship. Otherwise leave it empty.
- A reversal creates a new proposed card pointing to the old formal record. Never revise the old decision body. After acceptance, change only the old card's lifecycle status to `superseded`.

### 4. Preview and confirm

Show the complete proposed card: frontmatter（檔頭）, every body section, visible redacted excerpts, locators, hashes, and proposed relationships. A summary is not a preview.

Before any formal move, status change, or index edit, obtain explicit human acceptance of that exact draft. For sensitive source material, obtain a separate confirmation that the displayed redaction and retained provenance are safe. Silence, pressure to skip questions, or a general request to formalize satisfies neither gate. Without every applicable confirmation, leave only the proposed draft.

### 5. Land, validate, and commit only when authorized

After acceptance, change the new card to `active`, move it out of `_draft/`, add exactly one `./<id>.md` index row, and—when superseding—change only the old card's status. Preserve the old accepted body byte-for-byte.

Run the validator named by the current repository contract. On a nonzero result, stop, report the exact failure, and keep all changes uncommitted. Review the complete diff（差異） and prove unrelated work is excluded.

Formal landing authorization is separate from commit authorization. Never commit or push（推送） automatically. If the user separately authorizes a commit, scope it exactly to the new card, the necessary old-card status change, and `docs/decisions/INDEX.md`. Never include unrelated files or push as part of this workflow.
