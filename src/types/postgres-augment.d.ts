// src/types/postgres-augment.d.ts
//
// postgres.js 3.4.x 上游型別 bug 修補：TransactionSql 用
// `extends Omit<Sql, ...>` 繼承，TypeScript 的 Omit（mapped type）會剝掉
// call signatures，導致 `sql.begin(async (tx) => tx`...`)` 在型別層
// 「not callable」（runtime 正常）。此 augmentation 把 Sql 的兩個 call
// signature 原樣補回 TransactionSql（interface merging）。
// 上游修復後（TransactionSql 不再用 Omit）可整檔刪除。

import type {} from 'postgres';

declare module 'postgres' {
  interface TransactionSql<TTypes extends Record<string, unknown>> {
    /** Query helper（與 Sql 的 helper call signature 相同） */
    <T, K extends Rest<T>>(first: T & First<T, K, TTypes[keyof TTypes]>, ...rest: K): Return<T, K>;

    /** Tagged template query（與 Sql 的 template call signature 相同） */
    <T extends readonly (object | undefined)[] = Row[]>(
      template: TemplateStringsArray,
      ...parameters: readonly ParameterOrFragment<TTypes[keyof TTypes]>[]
    ): PendingQuery<T>;
  }
}
