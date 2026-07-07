這是 M6 benchmark 的固定 5 組 query（另 5 組真實 query 由 runner 從 search_feedback 近 7 日抽樣）；四欄皆必填；對比單位是 rollup。

| query | expected_intent | project_id | notes |
|---|---|---|---|
| drizzle array 綁定 record 錯誤 | 找到 M2b 期間 drizzle raw sql 對 JS array 綁成 record 的修法（pgTextArrayLiteral） | CC-memory | bugfix 意圖；來源 PR #11 |
| refine_delete 存在性洩漏 | 找到 M5 refine_delete 的 constant-message NotFoundError 防跨 project 存在性洩漏設計 | CC-memory | 設計決策意圖；來源 PR #14 |
| estimator discovery tokens 校準 | 找到 M4 estimator gate 校準（camelCase/snake 分段、非 ASCII 1.0、17/20 ±20%） | CC-memory | 校準工作意圖；來源 PR #16 |
| ccm-project-url DSN 事故 | 找到 Zeabur 退役庫誤寫事故與「用 ~/.ccm-project-url 勿用 ~/.ccm-prod-url」教訓 | CC-memory | 事故回溯意圖；來源 Phase 2 併用期啟動 |
| capture prompt injection 防護 | 找到 haiku 被 transcript 內容帶偏的 instruction sandwich + delimiter 修法 | CC-memory | 安全修補意圖；來源 PR #15 |
