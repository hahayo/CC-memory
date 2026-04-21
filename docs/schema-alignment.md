# Schema Alignment（v0.2 Phase 0）

> 日期：2026-04-21 · 執行人：Claude Code + Haha Huang

## 背景

v0.2 開工前，repo 同時存在兩套 schema：

| 檔案 | 狀態 | 內容摘要 |
|---|---|---|
| `src/db/schema.ts`（Drizzle） | **實際部署** | `project_id` / `next_steps` / 1536 維 embedding / HNSW 索引 |
| `sql/schema.sql`（死檔） | **未執行** | `project_name` / `session_id` / `tech_stack` / 384 維 / ivfflat / RPC functions |

後者為早期 Supabase 版殘留，無任何 runtime 引用，但會誤導未來 agent 或工程師
以為是 source of truth。

## 行動

1. **刪除** `sql/schema.sql`
2. **新增** `sql/migrations/` 目錄，取代 `src/db/migrations`
3. **更新** `drizzle.config.ts` 的 `out` 指向 `./sql/migrations`
4. **生成** `sql/migrations/0000_baseline.sql`：
   `npx drizzle-kit generate --name=baseline`
   （生產 DB 已是這狀態，此檔僅作紀錄 / 新環境 bootstrap 用，**不重複 apply**）
5. **更新 README** 明示 Drizzle 為唯一真實來源，禁手寫 SQL 維護

## 驗收

```bash
# 應無結果（.md 除外）
grep -rE "project_name|tech_stack|session_id" sql/ src/
# drizzle 與 schema 一致
npx drizzle-kit check   # → Everything's fine
```

## 後續規則

- Schema 變更一律：改 `src/db/schema.ts` → `drizzle-kit generate` → review 產出
  SQL → 以 `drizzle-kit push` 或手動 `psql -f` apply
- 不得在 `sql/` 手寫 `CREATE TABLE project_memories`（CI 可加 grep gate）
- `sql/migrations/` 內檔案一經 commit 不得編輯，只能新增 migration
