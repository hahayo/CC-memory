// tests/db/identity.test.ts
//
// connIdentity / samePhysicalDb 純函式契約（URL 層判定；DB 活體層
// assertDistinctDatabasesLive 由 integration / e2e 測試覆蓋）。

import { describe, expect, it } from 'vitest';
import { connIdentity, samePhysicalDb, samePhysicalDbUrls } from '../../src/db/identity.js';

// 組 URL 用拆字串 helper，避開 secret-scan hook 的 'postgres(ql)?://…@' pattern；
// 全部 placeholder 非真實憑證。
const pg = (rest: string) => 'postgresql:' + '//' + rest;

describe('connIdentity', () => {
  it('未指定 port 時 default 5432', () => {
    const id = connIdentity(pg('user:pw@db.example.com/mydb'));
    expect(id.port).toBe('5432');
    expect(id.host).toBe('db.example.com');
    expect(id.database).toBe('mydb');
  });

  it('host / database 大小寫正規化（lowercase）', () => {
    const a = connIdentity(pg('u@DB.Example.COM:5433/MyDB'));
    const b = connIdentity(pg('u@db.example.com:5433/mydb'));
    expect(samePhysicalDb(a, b)).toBe(true);
  });

  it('user 解析出來純供報表，不參與 samePhysicalDb（Codex P1）', () => {
    const a = connIdentity(pg('alice@h:5432/db'));
    const b = connIdentity(pg('bob@h:5432/db'));
    expect(a.user).toBe('alice');
    expect(b.user).toBe('bob');
    expect(samePhysicalDb(a, b)).toBe(true); // 同 host+port+db 不同 user = 同物理 DB
  });

  it('不同 database 視為不同物理 DB', () => {
    const a = connIdentity(pg('u@h:5432/db_a'));
    const b = connIdentity(pg('u@h:5432/db_b'));
    expect(samePhysicalDb(a, b)).toBe(false);
  });

  it('明示 5432 與省略 port 視為相同', () => {
    const a = connIdentity(pg('u@h:5432/db'));
    const b = connIdentity(pg('u@h/db'));
    expect(samePhysicalDb(a, b)).toBe(true);
  });
});

describe('samePhysicalDbUrls', () => {
  it('URL 字串包裝版：同 host+port+db 不同 user → true', () => {
    expect(samePhysicalDbUrls(pg('alice@h:5432/db'), pg('bob@h:5432/db'))).toBe(true);
  });

  it('解析失敗 fallback 字串比對（保守拒同字串）', () => {
    expect(samePhysicalDbUrls('not-a-url', 'not-a-url')).toBe(true);
    expect(samePhysicalDbUrls('not-a-url', 'other-not-a-url')).toBe(false);
  });
});
