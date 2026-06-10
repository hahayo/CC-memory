// src/db/identity.ts
//
// 連線身份（connection identity）判定 — Phase 3 v0.4 遷移工具鏈共用
// （收編 preflight / migrate-personal-data 原本各自一份的重複實作）。
//
// 兩層判定：
//   1. URL 層：connIdentity / samePhysicalDb — 快速、零連線，但會被 host alias
//      （localhost vs 127.0.0.1 vs DNS CNAME）繞過。
//   2. DB 活體層：assertDistinctDatabasesLive — 真連線 probe，URL 層的補強。

import { URL } from 'node:url';
import { randomInt } from 'node:crypto';
import type postgres from 'postgres';

export interface ConnIdentity {
  host: string;
  port: string;
  database: string;
  /** 純 logging / 報表用；不參與物理 DB 判定（Codex P1：user 是權限維度，不是儲存維度）。 */
  user: string;
}

export function connIdentity(rawUrl: string): ConnIdentity {
  const u = new URL(rawUrl);
  return {
    host: u.hostname.toLowerCase(),
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, '').toLowerCase(),
    user: decodeURIComponent(u.username).toLowerCase(),
  };
}

/** 「物理 DB 是否相同」嚴格只看 host+port+database（不含 user）。 */
export function samePhysicalDb(a: ConnIdentity, b: ConnIdentity): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

/** URL 字串版；任一邊解析失敗時 fallback 字串比對（保守拒同字串）。 */
export function samePhysicalDbUrls(a: string, b: string): boolean {
  try {
    return samePhysicalDb(connIdentity(a), connIdentity(b));
  } catch {
    return a === b;
  }
}

export interface DistinctDbDiagnostics {
  /** pg_control_system().system_identifier — 純診斷供 log。
   *  同 cluster 兩個 database 的 identifier 相同是合理狀態，不參與判定；
   *  permission error 時為 null（skip）。 */
  systemIdentifier: { project: string | null; personal: string | null };
  serverVersion: { project: string; personal: string };
  /** server_version major 不一致（to_jsonb key 序跨 major 無保證 → checksum
   *  比對可能 false-mismatch）。弱檢查：警告不中止。 */
  serverVersionMajorMismatch: boolean;
}

async function has0007Marker(sql: postgres.Sql): Promise<boolean> {
  const r = await sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_personal_only_check' LIMIT 1
  `;
  return r.length > 0;
}

async function systemIdentifier(sql: postgres.Sql): Promise<string | null> {
  try {
    const r = await sql<{ id: string }[]>`
      SELECT system_identifier::text AS id FROM pg_control_system()
    `;
    return r[0].id;
  } catch {
    return null;
  }
}

async function serverVersion(sql: postgres.Sql): Promise<string> {
  const r = await sql<{ server_version: string }[]>`SHOW server_version`;
  return r[0].server_version;
}

/**
 * DB 活體層「兩個 URL 確實連到不同 database」斷言（修 host-alias 繞過；免 superuser）。
 *
 * 1. 主：transaction-level advisory lock probe — project 端 tx 內
 *    `pg_advisory_xact_lock(k1,k2)`（隨機 pair），personal 端 `pg_try_advisory_xact_lock`
 *    拿不到 = 同一 database → throw。advisory lock 的 lock tag 含 database OID，
 *    同 cluster 不同 database 不衝突；tx 結束自動釋放、無殘留。
 *    前提：直連（或 session pooling）。pgbouncer transaction pooling 下請勿跑
 *    admin 工具鏈（probe 語意不保證）。
 * 2. 輔：0007 marker 方向檢查 — personal 端必須看到 tasks_personal_only_check、
 *    project 端必須看不到 → 同時抓「兩 URL 對調」（probe 抓不到的錯置）。
 * 3. 診斷限定：system_identifier 印出供 log，不參與判定。
 * 4. 弱檢查：兩邊 server_version major 一致，否則 console.error 警告（不中止）。
 */
export async function assertDistinctDatabasesLive(
  project: postgres.Sql,
  personal: postgres.Sql
): Promise<DistinctDbDiagnostics> {
  // 1) advisory-lock probe
  const k1 = randomInt(1, 0x7fffffff);
  const k2 = randomInt(1, 0x7fffffff);
  let probeAcquired = false;
  await project.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${k1}::int4, ${k2}::int4)`;
    const r = await personal<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${k1}::int4, ${k2}::int4) AS ok
    `;
    probeAcquired = r[0].ok;
  });
  if (!probeAcquired) {
    throw new Error(
      'assertDistinctDatabasesLive: advisory-lock probe 顯示兩個 URL 連到同一個 database。' +
        'URL 字面不同不代表物理不同（host alias / DNS / 大小寫可繞過 URL 層比對）。中止。'
    );
  }

  // 2) 0007 marker 方向檢查
  const [projectHas0007, personalHas0007] = await Promise.all([
    has0007Marker(project),
    has0007Marker(personal),
  ]);
  if (!personalHas0007) {
    throw new Error(
      'assertDistinctDatabasesLive: personal URL 連到的 DB 沒有 0007 CHECK' +
        '（tasks_personal_only_check）——可能兩 URL 對調，或 personal DB 未套 0007。中止。'
    );
  }
  if (projectHas0007) {
    throw new Error(
      'assertDistinctDatabasesLive: project URL 連到的 DB 帶有 0007 CHECK' +
        '（tasks_personal_only_check）——這是 personal DB；可能兩 URL 對調。中止。'
    );
  }

  // 3) + 4) 診斷
  const [projSysId, persSysId, projVer, persVer] = await Promise.all([
    systemIdentifier(project),
    systemIdentifier(personal),
    serverVersion(project),
    serverVersion(personal),
  ]);
  const major = (v: string) => parseInt(v, 10);
  const majorMismatch = major(projVer) !== major(persVer);
  if (majorMismatch) {
    console.error(
      `[identity] WARN: server_version major 不一致（project=${projVer}; personal=${persVer}）` +
        '——to_jsonb key 序跨 major 無保證，checksum 比對可能 false-mismatch。'
    );
  }

  return {
    systemIdentifier: { project: projSysId, personal: persSysId },
    serverVersion: { project: projVer, personal: persVer },
    serverVersionMajorMismatch: majorMismatch,
  };
}
