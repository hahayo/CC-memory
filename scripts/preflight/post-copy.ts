// scripts/preflight/post-copy.ts — C1-C5（copy 後、delete 前驗證）

import { sanitizeUrl } from '../../src/db/resolve-url.js';
import { PERSONAL_PROJECT_ID } from '../../src/constants.js';
import { adminClient } from '../lib/clients.js';
import {
  COPY_ORDER,
  EXPECTED_INVENTORY,
  countPersonalRows,
  type InventoryEntry,
} from '../lib/inventory.js';
import { reminderLogChecksum, tableChecksum } from '../lib/checksum.js';
import { PreflightAbort, checkIdentity, record, type CaseResult } from './shared.js';

function requireUrl(name: string): string {
  const v = sanitizeUrl(process.env[name]);
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

export async function postCopy(): Promise<CaseResult[]> {
  const projectUrl = requireUrl('DATABASE_URL');
  const personalUrl = requireUrl('DATABASE_URL_PERSONAL');
  const results: CaseResult[] = [];

  const project = adminClient(projectUrl);
  const personal = adminClient(personalUrl);

  try {
    // C1：identity 重跑（P1+P2 同邏輯）；FAIL → exit 2 abort（後續 case 不可信）
    const id = await checkIdentity(projectUrl, personalUrl, project, personal);
    const c1ok = id.urlDistinct && id.liveOk;
    record(
      results,
      'C1',
      'identity 重跑（URL 層 + DB 活體 probe）；FAIL 即 abort',
      c1ok,
      `${id.urlDetail}；live: ${id.liveDetail}`
    );
    if (!c1ok) throw new PreflightAbort('C1 identity FAIL——post-copy 驗證中止', results);

    const copyEntries = COPY_ORDER.map(
      (t) => EXPECTED_INVENTORY.find((e) => e.table === t) as InventoryEntry
    );

    // C2：row counts（含 reminder_log FK-scoped）
    for (const entry of copyEntries) {
      try {
        const p = await countPersonalRows(personal, entry);
        const s = await countPersonalRows(project, entry);
        record(results, 'C2', `row count match: ${entry.table}`, p === s, `personal=${p}; project=${s}`);
      } catch (e) {
        record(results, 'C2', `row count ${entry.table}`, false, (e as Error).message);
      }
    }

    // C3：checksums（to_jsonb + 自含 SET LOCAL UTC；含 reminder_log）
    for (const table of COPY_ORDER) {
      try {
        const [p, s] =
          table === 'reminder_log'
            ? [await reminderLogChecksum(personal), await reminderLogChecksum(project)]
            : [await tableChecksum(personal, table), await tableChecksum(project, table)];
        record(
          results,
          'C3',
          `checksum match: ${table}`,
          p === s,
          `personal=${p.slice(0, 12)}…; project=${s.slice(0, 12)}…`
        );
      } catch (e) {
        record(results, 'C3', `checksum ${table}`, false, (e as Error).message);
      }
    }

    // C4：personal DB 任何 project_id != __personal__ → 0 列
    for (const table of ['project_memories', 'tasks'] as const) {
      try {
        const r = await personal<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM ${personal(table)} WHERE project_id <> ${PERSONAL_PROJECT_ID}
        `;
        const n = parseInt(r[0].count, 10);
        record(results, 'C4', `personal DB ${table} 無其他 project_id`, n === 0, `non-personal rows=${n}`);
      } catch (e) {
        record(results, 'C4', `personal DB ${table} non-personal check`, false, (e as Error).message);
      }
    }

    // C5：0007 CHECK 拒非 __personal__ INSERT（personal DB）
    for (const table of ['project_memories', 'tasks'] as const) {
      try {
        let rejected = false;
        try {
          await personal.begin(async (tx) => {
            if (table === 'project_memories') {
              await tx`INSERT INTO project_memories (project_id, type, summary) VALUES ('preflight-probe', 'session', 'C5 probe')`;
            } else {
              await tx`INSERT INTO tasks (project_id, title) VALUES ('preflight-probe', 'C5 probe')`;
            }
            throw new Error('INSERT 應被 CHECK 拒但未拒');
          });
        } catch (err) {
          rejected = /check constraint|23514|personal_only/i.test((err as Error).message);
        }
        record(
          results,
          'C5',
          `0007 CHECK 拒非 __personal__ INSERT: ${table}`,
          rejected,
          rejected ? 'rejected by CHECK constraint' : 'NOT rejected (regression)'
        );
      } catch (e) {
        record(results, 'C5', `CHECK ${table}`, false, (e as Error).message);
      }
    }

    return results;
  } finally {
    await project.end({ timeout: 5 });
    await personal.end({ timeout: 5 });
  }
}
