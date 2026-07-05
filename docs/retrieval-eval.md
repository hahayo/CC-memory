# Retrieval Eval（Phase 5-A）

## 目標

被動記錄每次 `cc_memory_search` 的 query / mode / ranked results 共 9 欄
到 `search_feedback` 表，累積 signal 供 retrieval eval 使用。

**Phase A 不要求使用者主動回饋**（thumbs / selected_id / feedback UI 全部延到
Phase 5-B），因為 Phase A 的目標是「先確保信號源乾淨、長度對齊、不漂移」，
有了穩定 signal 之後 Phase B 才有基準可以比對接受率。

## 設計防線（避免 recordSearchQuery 欄位漂移）

1. **API 形狀**：`recordSearchQuery(db, envelope)` 吃整個
   `SearchResultEnvelope`，caller 不得拆欄位自行拼（codex Finding 2：MCP
   handler 寫 `mode: requestedMode` 的 bug 就是拆欄位造成）。
2. **service 層 early-fail**：
   `rankPositions.length`、`scores.length`（非 null 時）、`resultProjectIds.length`
   必須等於 `results.length`，任一不符立即 `throw InvalidArgumentError`，
   不落 DB。
3. **DB CHECK 第二道防線**：`search_feedback_arrays_same_length` 在 PG 端
   擋最後一層，即使 service 被繞過也不會寫入 misaligned row。
4. **effectiveMode vs requestedMode**：DB 寫的是 `effectiveMode`
   （真正執行的 mode；例如 embedding disabled 時 hybrid 會降成 keyword），
   不是使用者請求的 `requestedMode`。這樣 eval 看到的是系統實際行為，
   不是意圖。

## 資料模型（search_feedback 12 欄）

| 欄位 | 型別 | Phase A 行為 |
|---|---|---|
| id | uuid | 自動 |
| query | text NOT NULL | 使用者原始查詢字串 |
| query_surface | text NOT NULL | 'telegram' / 'mcp' / 'http' |
| query_project_id | text NULL | 當下 active project（null = 跨專案搜尋） |
| mode | text NOT NULL | 實際執行的 mode（effectiveMode） |
| limit | integer NOT NULL | 請求 limit |
| result_ids | uuid[] NOT NULL | 回傳 memory id 按排名順序 |
| result_project_ids | text[] NOT NULL | 對應每 id 的 project_id（可跨專案） |
| rank_positions | integer[] NOT NULL | 1-based 排名 |
| scores | real[] NULL | 相似度分數；keyword mode 為 null |
| selected_id | uuid NULL | **Phase A 恆 null**；Phase B 由使用者點選 |
| selected_rank | integer NULL | **Phase A 恆 null**；Phase B 由使用者點選 |
| thumbs | text NULL | **Phase A 恆 null**；Phase B 'up' / 'down' |
| created_at | timestamptz NOT NULL | 自動 |

## Schema constraints（DB 保證）

- `search_feedback_surface_check`：query_surface ∈ `('telegram','mcp','http')`
- `search_feedback_mode_check`：mode ∈ `('keyword','semantic','hybrid')`
- `search_feedback_thumbs_check`：thumbs IS NULL OR ∈ `('up','down')`
- `search_feedback_arrays_same_length`：
  - `cardinality(result_ids) = cardinality(result_project_ids)`
  - `cardinality(result_ids) = cardinality(rank_positions)`
  - `scores IS NULL OR cardinality(scores) = cardinality(result_ids)`

## Phase A 指標（現已可跑）

### 1. 每日查詢數

最近 14 天按日 group by，輸出 `queries`（每日筆數）與
`distinct_projects`（當日有幾個 project 發查詢）。

### 2. Mode 分佈

14 天內各 mode（keyword / semantic / hybrid）的筆數與百分比。
用來回答「實際 semantic 降級率有多高」、「是否 keyword-only 就夠用」。

### 3. 結果穩定度（Jaccard of adjacent runs）

演算：對 `(query_project_id, query, mode)` group；同組內按 `created_at ASC`
排序；相鄰兩次 `result_ids` 計 Jaccard similarity = `|A∩B| / |A∪B|`；
取 per-project 平均。

- Jaccard ≈ 1：結果穩定（同樣的 query 回同樣的 top-K）
- Jaccard ≈ 0：結果抖動（HNSW 近似、embedding 變更、資料增刪都可能造成）
- samples 欄顯示有多少對相鄰對被納入統計

## Phase B 指標（待實作）

以下指標依賴 `selected_id` / `selected_rank` / `thumbs`，Phase A 暫不蒐集：

- **接受率**（accept rate）= `COUNT(selected_id IS NOT NULL) / COUNT(*)`
- **Top-1 命中率**= `COUNT(selected_rank = 1) / COUNT(selected_id IS NOT NULL)`
- **撤銷率**（undo rate）= `COUNT(thumbs = 'down') / COUNT(thumbs IS NOT NULL)`

Phase B 實作重點：

1. MCP 回應帶上 `feedback_id`（search_feedback.id），讓 handler 可以後續更新
2. 新增 `recordFeedback(db, feedbackId, patch)` 寫 selected_id / thumbs
3. eval 腳本補上這三個指標區塊，原 N/A 改成實際數字

## 如何跑

```bash
# 本機
DATABASE_URL=postgres://localhost/cc_memory \
  npx tsx scripts/eval-retrieval.ts > reports/retrieval-eval-$(date +%F).md

# 測試 DB
DATABASE_URL=postgres://test:test@localhost:5433/cc_memory_test \
  npx tsx scripts/eval-retrieval.ts

# CI / prod Postgres（現 Coolify，經 SSH tunnel；原 Zeabur）
DATABASE_URL=$PROD_DB_URL \
  npx tsx scripts/eval-retrieval.ts
```

連線字串優先序：`DATABASE_URL` → `TEST_DATABASE_URL` → 預設本機 test PG
（`postgres://test:test@localhost:5433/cc_memory_test`）。

腳本輸出到 stdout，不寫檔案；呼叫端自行 `>` redirect。

## 排除故障

- **腳本跑完是空表**：檢查 `search_feedback` 有無 row
  （`SELECT COUNT(*) FROM search_feedback`）；Phase A 需要 MCP handler 呼叫
  `recordSearchQuery` 才會有資料（Stage 2 wire-up 才會接進 handler）。
- **`samples = 0`**：沒有相鄰兩次同 `(project, query, mode)` 的查詢；
  資料點不夠多或查詢字串每次都略有不同。
- **連線失敗**：確認 `DATABASE_URL` 指向對的 PG 且有 `search_feedback` 表
  （Stage 0 的 migration 0002 已建）。
