// src/constants.ts
//
// Leaf module：零依賴常數，供 config / db / services / scripts 共用。
// '__personal__' 字面值單一出處（Phase 3 code review Batch 1）；
// scope-policy.ts re-export 保持既有 import 路徑不破。

/** 個人近況/決策/待辦的保留 projectId（Personal-Hub；見 ADR-001）。 */
export const PERSONAL_PROJECT_ID = '__personal__';
