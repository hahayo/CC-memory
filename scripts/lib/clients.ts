// scripts/lib/clients.ts
//
// 遷移工具鏈專用 postgres.js client factory（migrate / preflight / delete 共用）。
//
// raw-text 直通的理由：
//   - timestamp oids 1082(date)/1114(timestamp)/1184(timestamptz)：postgres.js 預設
//     parse 成 JS Date，精度只有毫秒——微秒在跨 DB copy 時靜默截斷（P1）。保持原文
//     text，INSERT 時以 text param 回寫，由 PG 端 cast 回 timestamp 型別，無失真。
//   - json oid 114 / jsonb oid 3802：預設 JSON.parse 成 JS object，INSERT 走
//     sql() helper 的物件序列化路徑會壞（Codex B1）。保持原文 text，PG 端 cast。
//   - array oids 不覆寫：text[]/uuid[]/int[]/real[] 經 JS array round-trip 無損
//     （元素是 scalar；jsonb[] 本專案 schema 未使用）。
//   - pgvector embedding：extension type，postgres.js 不認識 → 預設就是 text 直通。

import postgres from 'postgres';

export function adminClient(url: string) {
  return postgres(url, {
    max: 1,
    types: {
      rawTimestamp: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
      rawJson: {
        to: 3802,
        from: [114, 3802],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
  });
}

export type AdminSql = ReturnType<typeof adminClient>;

/** Sql 或 TransactionSql 皆可的查詢介面（lib 函式共用參數型別）。 */
export type Queryable = postgres.Sql<any> | postgres.TransactionSql<any>;

/**
 * dynamic identifier helper（`sql('table_name')` → `"table_name"`）。
 * TS 對 union type 的呼叫只解析到 template overload，identifier overload 會丟
 * TS2345——此處集中 cast（runtime 上 Sql / TransactionSql 行為相同）。
 */
export function ident(sql: Queryable, name: string) {
  return (sql as postgres.Sql<any>)(name);
}
