// scripts/preflight/shared.ts — preflight 三 mode 共用：CaseResult / record /
// identity 檢查 / abort 例外。

import {
  assertDistinctDatabasesLive,
  connIdentity,
  samePhysicalDb,
} from '../../src/db/identity.js';
import type { AdminSql } from '../lib/clients.js';

export interface CaseResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

export function record(
  results: CaseResult[],
  id: string,
  name: string,
  pass: boolean,
  detail: string
): void {
  results.push({ id, name, status: pass ? 'PASS' : 'FAIL', detail });
}

export function recordSkip(results: CaseResult[], id: string, name: string, reason: string): void {
  results.push({ id, name, status: 'SKIP', detail: `SKIPPED：${reason}` });
}

/** C1/D1 identity FAIL → 後續 case 不可信，整段 abort（entry 印部分報表後 exit 2）。 */
export class PreflightAbort extends Error {
  constructor(
    message: string,
    public readonly results: CaseResult[]
  ) {
    super(message);
  }
}

export interface IdentityCheckOutcome {
  urlDistinct: boolean;
  liveOk: boolean;
  urlDetail: string;
  liveDetail: string;
}

/**
 * URL 層 + DB 活體層 identity 檢查（P1/P2、C1、D1 共用同邏輯）。
 * user 只進報表不參與判定（Codex P1）。
 */
export async function checkIdentity(
  projectUrl: string,
  personalUrl: string,
  project: AdminSql,
  personal: AdminSql
): Promise<IdentityCheckOutcome> {
  const projId = connIdentity(projectUrl);
  const persId = connIdentity(personalUrl);
  const urlDistinct = !samePhysicalDb(projId, persId);
  const urlDetail =
    `project=${projId.host}:${projId.port}/${projId.database}@${projId.user}; ` +
    `personal=${persId.host}:${persId.port}/${persId.database}@${persId.user}` +
    (urlDistinct ? '' : ' — SAME PHYSICAL DB（user 差異不算），中止');

  let liveOk = false;
  let liveDetail = '';
  try {
    const diag = await assertDistinctDatabasesLive(project, personal);
    liveOk = true;
    liveDetail =
      `advisory probe distinct；0007 方向正確；` +
      `system_id project=${diag.systemIdentifier.project ?? 'n/a'} ` +
      `personal=${diag.systemIdentifier.personal ?? 'n/a'}（診斷限定，不參與判定）；` +
      `pg ${diag.serverVersion.project} / ${diag.serverVersion.personal}` +
      (diag.serverVersionMajorMismatch ? '（MAJOR MISMATCH——checksum 可能 false-mismatch）' : '');
  } catch (e) {
    liveDetail = (e as Error).message;
  }
  return { urlDistinct, liveOk, urlDetail, liveDetail };
}
