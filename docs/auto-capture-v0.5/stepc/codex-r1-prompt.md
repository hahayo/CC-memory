# CC-memory 舊 backlog 重歸屬：合併規則與封存方案 R1 審查（唯讀審查，不要改任何檔、不要連 DB）

你是獨立審查者。請以離線分析方式審下面的「提案」，重點是**正確性與可回復性**。你可以讀 repo（工作目錄 `/home/haha/CC_project/CC-memory`）與 `~/.cache/cc-memory/stepb-2026-09-03/` 下的工具（`stepb-apply.py`、`stepb-build-remap.ts`、`codex-r2c-out.md`）。不得執行任何寫入、不得連正式 DB。

## 0. 當事人原話（使用者）
- 「新的先做」（接受 7 月舊 backlog 可能永遠輪不到）
- 交接檔任務：「Step B 殘餘 1,112 列怎麼裁決、spool 內約 12k 個 7 月舊 session 要不要封存」

## 1. 背景與環境
- DB：PostgreSQL（Coolify），表 `project_memories`（rollup）與 `observations`。關鍵約束：
  - `project_memories_idempotency_idx` UNIQUE (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status='active'
  - `observations_content_uniq` UNIQUE (project_id, session_id, content_hash) WHERE status='active'
  - `observations.rollup_memory_id` FK → project_memories.id
  - `project_memories.merged_into uuid`（既有欄位，目前 capture 路徑未使用）
  - rollup 的 `idempotency_key = capture:v05:<project_id>:<session_id>`；`metadata.capture` 含 `observation_ids / spool_offsets / transcript_sources / summarize_count / discovery_tokens / empty_observation_windows`；另有 `embedding`（rollup summary 的向量）
- 2026-09-03 Step B 已用單一交易搬了 578 列（工具 `stepb-apply.py` v3：flock 內、`LOCK TABLE … SHARE ROW EXCLUSIVE`、集合相等檢查、`system_identifier` 檢查、逐條 UPDATE ROW_COUNT=1、postcheck、任一不符 ROLLBACK）。你的前一輪意見在 `codex-r2c-out.md`。
- worker（`src/services/capture-worker.ts`）持續在跑；它處理一個 window 時會讀同 (project_id, session_id) 的既有 rollup 的 `metadata.capture` 當 `previousCapture`：`observation_ids` 累加、`spool_offsets` 用來判斷 replay（同 start/end 不重複 append、summarize_count 不重複遞增）、`transcript_sources` 累加。
- 讀取端（SessionStart 注入、search）**不用** `metadata.capture.observation_ids`，而是查 `observations` 表 active 列的 `rollup_memory_id` 連結（2026-07-07 決策，Codex 當時建議寫入端回寫被駁回）。

## 2. 殘餘 1,112 列的四類（已用唯讀 SQL 核實）
| 類 | 內容 | 列數 | session 數 | DB 事實 |
|---|---|---|---|---|
| (1) | 同 session 在新 id 已有 active rollup | 38 rollup＋747 obs | 30 | 舊 rollup 與新 rollup 的 `transcript_sources`／`spool_offsets` 是同一檔的**不相交連續區段**（舊段在前、新段在後）。多個舊 rollup 可對同一新 rollup（例：一個 session 有 4 個崩塌 rollup） |
| (2) | 表內自撞：同 session 拆在多個崩塌 id、新 id 下**沒有** rollup | 6 rollup＋96 obs | 3 | 搬過去互撞 idempotency 唯一鍵 |
| (3) | 只有 encoded-dir 證據（transcript 已刪）、候選 AI_Copilot×5／recycling-recognition×2 | 8 rollup＋98 obs | 7 | 新 id 下**沒有**任何 rollup；候選純靠目錄名解碼，需人工核准 |
| (4) | transcript 已刪、目錄名對不到 | 5 rollup＋114 obs | 3 | **新事實**：三個 session 在 `recycling-recognition-tender-pmo` 下都已有 7 月建立的 active rollup（obs 40／77／20）；其中 551de309 在 `specs` 下也有一個（obs 38）→ 兩個候選目標 |
- 搬 observations 到新 id 會撞 `observations_content_uniq` 的列數：**0**（六個目標 id 全查過）。舊列自己同 session 同 content_hash 重複：**0**。
- 目前 `cross_project_fk_now=0`、`pm_dup_active_keys=0`。

## 3. 提案 A：類 (1)(2)(4) 用同一條合併規則
「N 個舊 rollup → 1 個目標 rollup」：
1. 目標 = 新 id 下既有 active rollup（類 1、4）；若沒有（類 2）則選舊 rollup 中 `transcript_sources` 最早者當存活者，改它的 `project_id` 與 `idempotency_key`。
2. 其餘舊 rollup：`status='archived'`、`merged_into=<目標 id>`、`project_id` 與 `idempotency_key` **不改**（保留原值可人工反向；archived 不佔唯一索引）。
3. 該 session 所有崩塌 observations：同一 UPDATE 同時改 `project_id=<新 id>`、`rollup_memory_id=<目標 id>`（保持 `cross_project_fk_now=0`）。
4. 目標 rollup 的 `metadata.capture`：**開放問題**——
   - 選項 a：把被合併 rollup 的 `observation_ids`／`spool_offsets`／`transcript_sources` 併入（去重、依 start 排序），`summarize_count` 相加，`discovery_tokens` 相加；`summary`／`embedding` 不動（目標的 summary 只涵蓋它自己的區段，接受）。
   - 選項 b：目標 metadata 完全不動（讀取端不依賴 observation_ids；worker 的 replay 判斷只看它自己寫過的 offsets；舊區段的 checkpoint 早已推進、不會重跑）。
   - 委派方假設：選 b 比較安全（不改 worker 會讀的欄位、不會和 worker 的 at-least-once 重放守衛打架），但會讓 provenance 不完整。請判斷。
5. 執行方式沿用 Step B：flock 內單一交易、LOCK TABLE、交易內重驗每列現況（status／project_id／rollup_memory_id 與對照表一致）、目標 rollup 存在且 active、逐條 ROW_COUNT=1、postcheck（cross_project_fk=0、dup keys=0、崩塌列剩餘數＝預期）、`system_identifier` 精確比對，任一不符整筆 ROLLBACK。
6. 類 (4) 的 551de309（兩個候選目標）與類 (3) 全部：**留人工核准**，不進本交易，除非使用者明確點名。

回滾：對照表保留每列 old 值；被合併 rollup 只改 status／merged_into，反向 = 還原 status、清 merged_into、observations 反向改回。worker 若在合併後對目標 rollup 又寫了新 window，反向後目標仍一致（它本來就存在），只有類 2 的存活者被改了 key，反向時要確認 worker 沒在新 key 下再寫。

## 4. 提案 B：spool 舊 backlog
盤點（唯讀）：12,626 個 session 有待處理位元組（53.6 MB），其中
- **transcript 已刪** 9,961 個（13.6 MB；9,127 在 `001-employee-collection`，皆 Codex rollout 檔已不存在）。worker 對這種 session：每次嘗試失敗記 retry、同 terminal 最少隔 30 分鐘、5 次後 dead-letter 並推進 checkpoint。以 fresh-first 現況它們永遠輪不到；若 stale 層某天真的跑到，每個要耗 5 次×30 分鐘才會放棄。
- **transcript 仍在** 2,666 個（待處理 transcript 約 4.9 GB、以 256 KiB 估約 19,961 個 LLM 窗口；finetune-eval 一家 7,112 窗）。8 月的會逐步被 Claude Code 30 天清理刪掉。
- 崩塌目錄（`_` 開頭）只有 62 個 session——交接檔說「大多在崩塌目錄」是錯的。
- 8/27 已做過一次 copy-live 快照上傳 R2（20,050 spool 檔），但 `001-employee-collection` 有 5,920 檔 mtime 8/31，**不在**那次快照內。

提案 B1（transcript 已刪的 9,961 個）：在 worker 同一把 flock 內，把這些 session 的 `.jsonl`＋`.capture-state.json`（若有）**mv 到 `~/.cache/cc-memory/spool-quarantine-<date>/<project>/`**（同檔案系統、原子）→ 對該目錄跑 `archive-capture-backlog.ts --copy-live --spool-dir <該目錄> --copy-live-archive <新 root>`（避免頂掉既有兩份）→ upload。可逆：mv 回去即可。不動 live spool 的其他檔。
提案 B2（transcript 仍在的 2,666 個）：不全量回放（2 萬窗口不現實）；給使用者一張「每 project 的窗口數表」，只回放使用者點名的少數 project，用文件化的 `drain-capture-backlog.ts --spool-dir … --max-minutes …` 走；其餘接受遺失。

## 5. 執行前提
- 你是離線審查：可讀 repo 與工具檔，不可寫、不可連 DB。DB 事實以本文第 2 節為準（已由委派方唯讀查證）。
- 使用者已規定：不改 `CC_CAPTURE_RETRY_MIN_INTERVAL_MS`、不對整個 live spool 跑 cutoff、不用 `stepb-apply.py --rollback`。

## 6. 請你回答
1. 提案 A 的合併規則有沒有正確性漏洞（唯一鍵、FK、worker 競態、at-least-once 重放守衛）？選 a 還是 b，為什麼？
2. 類 (2) 「選 transcript_sources 最早者當存活者並改 key」是否比「全部 archived、另建新 rollup」好？
3. 提案 B1 用 mv 到隔離目錄的方式，跟 worker 有沒有競態？archive 工具對非 live 目錄跑 copy-live 有什麼坑？
4. 有沒有我根本問錯的地方——如果你認為提問者連問題都問錯了、或關鍵資料根本沒被蒐集，直接說。
輸出格式：每項 finding 標 severity（Critical/High/Medium/Low）＋檔案或段落引用＋建議；最後一行 `verdict: APPROVE | APPROVE-WITH-FIXES | REQUEST-CHANGES`。用繁體中文。
