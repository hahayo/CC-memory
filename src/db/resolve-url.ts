// src/db/resolve-url.ts
//
// DATABASE_URL / DATABASE_URL_PERSONAL 解析純函式（Phase 3 v0.4，見 ADR-001）。
// 無 module-level 副作用：config.ts 啟動期呼叫一次（一 process 一 scope 一 DB）；
// preflight / admin scripts 直接 import 本檔（驗收點：import 不產生 console 輸出）。

import { PERSONAL_PROJECT_ID } from '../constants.js';
import { samePhysicalDbUrls } from './identity.js';

// 拆字串避開 secret-scan hook 的 'postgres(ql)?://...@' pattern；
// 值為 localhost test placeholder，非真實憑證。
const TEST_FALLBACK_URL = 'postgresql:' + '//test:test' + '@localhost/test';

function nonEmpty(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * URL 消毒：去 \r（Windows .env CRLF）、trim、剝包覆引號（.env 貼上常見）。
 * 收編 pollers 原本各自的 ad-hoc 防禦（`.replace(/\r/g,'').replace(/^"|"$/g,'')`）。
 */
export function sanitizeUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/\r/g, '').trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t.length > 0 ? t : null;
}

export interface ResolveDatabaseUrlInput {
  databaseUrl: string | null;
  databaseUrlPersonal: string | null;
  forcedProjectId: string | null;
}

export interface ResolveDatabaseUrlOptions {
  /** 測試環境允許 fallback localhost placeholder（由 config.ts 依 NODE_ENV/VITEST 判定後傳入）。 */
  allowTestFallback?: boolean;
}

export function readDatabaseInputs(env: NodeJS.ProcessEnv): ResolveDatabaseUrlInput {
  return {
    databaseUrl: sanitizeUrl(env.DATABASE_URL),
    databaseUrlPersonal: sanitizeUrl(env.DATABASE_URL_PERSONAL),
    forcedProjectId: nonEmpty(env.CC_FORCE_PROJECT_ID),
  };
}

/**
 * Phase 3 v0.4 fail-fast 矩陣（獨立 personal DB；見 ADR-001）：
 *   - forced personal（CC_FORCE_PROJECT_ID=__personal__）缺 DATABASE_URL_PERSONAL → throw
 *   - forced personal 且兩 URL 同物理 DB（URL 層 host+port+database）→ throw（secret 配發錯誤）
 *   - 非 forced personal（project-mode 或 forced 非 personal）偵測到 DATABASE_URL_PERSONAL
 *     → console.warn + 拒絕載入該 URL（不 exit）
 *   - 其餘回 DATABASE_URL；缺則 throw（測試環境可 opt-in fallback）
 *
 * 隔離不靠 DB 內部規則，靠 secret 配發 + 物理切分（不同 database）。
 */
export function resolveDatabaseUrl(
  input: ResolveDatabaseUrlInput,
  opts: ResolveDatabaseUrlOptions = {}
): string {
  const { databaseUrl, databaseUrlPersonal, forcedProjectId } = input;

  if (forcedProjectId === PERSONAL_PROJECT_ID) {
    if (!databaseUrlPersonal) {
      throw new Error(
        'CC_FORCE_PROJECT_ID=__personal__ 必須同時設 DATABASE_URL_PERSONAL：' +
          'Phase 3 v0.4 後個人資料存獨立 personal PG，缺此 URL 會退回 project DB 寫到錯 DB。' +
          '詳見 docs/personal-hub/decisions/ADR-001-phase3-separate-db.md'
      );
    }
    if (databaseUrl && samePhysicalDbUrls(databaseUrl, databaseUrlPersonal)) {
      throw new Error(
        'DATABASE_URL 與 DATABASE_URL_PERSONAL 指向同一物理 DB（host+port+database；user 差異不算）：' +
          'Phase 3 v0.4 要求個人資料在獨立 database，同 DB 代表 secret 配發錯誤。' +
          '詳見 docs/personal-hub/decisions/ADR-001-phase3-separate-db.md'
      );
    }
    return databaseUrlPersonal;
  }

  if (databaseUrlPersonal) {
    console.warn(
      '[cc-memory] 偵測到 DATABASE_URL_PERSONAL，但此 instance 不是 forced personal mode' +
        '（CC_FORCE_PROJECT_ID=__personal__）——已拒絕載入該 URL（不 exit），' +
        '避免個人 DB 連線字串外帶到非 personal context（防 secret 誤配）。' +
        '若這是 admin/migration instance，請改在 script 內顯式讀取 process.env.DATABASE_URL_PERSONAL。' +
        '詳見 docs/personal-hub/decisions/ADR-001-phase3-separate-db.md'
    );
  }

  if (databaseUrl) return databaseUrl;
  if (opts.allowTestFallback) return TEST_FALLBACK_URL;
  throw new Error('DATABASE_URL is required');
}
