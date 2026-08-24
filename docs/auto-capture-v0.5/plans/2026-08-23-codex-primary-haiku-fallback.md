# Plan：capture 主力改用 Codex CLI，haiku 降為備援，並解封 worker 消化 backlog

## 實作狀態（2026-08-23 更新）

| Phase | 狀態 | 備注 |
|---|---|---|
| Phase 0（量測）| ✅ 已落地 | p95 pre-LLM elapsed（啟動前耗時）= 31.1 s；見 `phase0-measurement-2026-08-23.md` |
| Phase 1（沙箱骨架）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 2（沙箱驗收）| ✅ 已落地 | 14/14 tests pass；codex-code-mode-host 未掛載（純文字模式）；見 `sandbox-acceptance-2026-08-23.md`（sandbox agent 已更新，本 cascade 不再重寫） |
| Phase 3（codex-cli provider）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 4（fallback wrapper）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 4.5（`CC_CAPTURE_MAX_WINDOWS_PER_TICK`）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 5（integration tests 補完）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 6（worker 解封）| ✅ 已落地 | branch `feature/codex-capture-primary` |
| Phase 7（unit 更新 + cascade）| ⏳ 待操作人執行 | ops/systemd unit 已更新；cascade docs 本 commit |
| Phase 8（觀察窗）| ⏳ 待操作人執行 | — |

可用模型字串：`gpt-5.6-sol`（正式 unit 預設）、`gpt-5.6-luna`（可選）。

> 狀態：**Round 8（定稿候選）**。Codex 對審七輪，逐輪收斂：
> R1 3 BLOCKER → R2 2 未解 → R3 4 → R4 3 → R5 4 → R6 2 → **R7：APPROVE-WITH-FIXES（0 BLOCKER，3 IMPORTANT）**。
> 本輪已把 R7 的 3 項 IMPORTANT 全數折入（`forceProvider` 介面與跨 tick 續跑、timeout 獨立 category 與 blocked streak、sealed mover 的 fsync 順序與 filesystem 驗證）。
> **Codex 保留的兩項既有異議**：execpolicy 精確政策仍是 placeholder（由 Phase 2 的 L1–L3 fail-closed 驗收關卡兜底）、Codex 憑證可讀且未限制網路外送（已列為明示接受風險）。
> 讀者：實作者與審查者。

---

## Context（為什麼要做這件事）

CC-memory 的 v0.5 auto-capture（自動採集）管線已建置完成：hooks（掛鉤）側錄 → spool（本機緩衝）→ systemd oneshot worker（跑完即退的背景工作程序）→ LLM 抽取 → PostgreSQL + pgvector。

目前是**「hooks 活著、worker 死著」**：

- `ops/systemd/cc-memory-auto-capture.service` 有 `ConditionPathExists=%h/.ccm-auto-capture-production-approved`。該標記檔不存在，故每次被 kick（喚起）都直接 `ConditionResult=no` 跳過。
- 實測：wrapper log 最後一筆 2026-07-15；`cc_memory_stats` 顯示本專案最後記憶 2026-07-15。
- spool 累積 **18,043 個 session 檔（17,513 個帶 Stop sentinel＝已結束可整理）、226 個專案、120 MB**，涵蓋 2026-07-07 → 2026-08-22；對應 transcript 總量 **1,317 MB**。

停工原因不是故障，是 2026-08-12 readiness audit 判 PARTIAL／No-Go 後使用者自設的閘門正常運作。其中「embedding coverage 100%」現已達成（`--table all` dry-run 回 `scanned:0`；backfill journal 記 `[full-backfill] complete scanned=0`）。

### 使用者已拍板（凍結，不再討論）

1. Go/No-Go 紀律降級為 canary（小規模試跑）；benchmark 改為參考用。
2. 接受「對話結束才彙整」的延遲。
3. 保留細粒度 observation 與其 embedding（跨 Claude Code／Codex 共用歷史）。
4. 17,513 場 backlog 全部處理，不封存未處理資料、不切代。
5. **主力＝Codex CLI，haiku＝自動備援。**
6. **（2026-08-23）安全採「先加沙箱、實測擋得住才上線」。**

### 成本現實（實測）

| 窗口 | 耗時 | tokens／次 |
|---|---|---|
| 32 KiB | 13.9 s | 30,886 |
| 256 KiB | 25.1 s | 103,762 |

1,317 MB ÷ 256 KiB ≈ **5,269 次呼叫 ≈ 5.5 億 tokens**，遠超單週額度 → 必須長期慢跑。使用者已知並接受。

---

## 安全架構（已凍結，Round 2 #11／#12 修正）

Round 2 指出兩個自相矛盾，本節為單一權威來源，其他章節一律以此為準：

**採用「execpolicy 全拒 ＋ bubblewrap 檔案系統限制」兩者並用**，不是二選一。

因此：

- **全流程不使用 `--ignore-rules`**（該旗標會把 execpolicy 政策一起跳過）。先前草案中任何出現 `--ignore-rules` 的地方均已移除。
- 沙箱驗收未通過 → **不得進入正式啟用階段**（Phase 7）。
- 主力維持 Codex（拍板 5 不變）。

### 已實測排除的做法

| 做法 | 實測結果 |
|---|---|
| `-s read-only` | **無效**。原始碼 `protocol/src/permissions.rs` 的 `read_only_file_system_entries()` 對整個 root 授予 Read；`core/src/tools/spec_plan.rs` 在非 guardian 路徑**無條件註冊 shell 工具** |
| `-c 'sandbox_permissions=[]'` | **無效**。加與不加，讀檔探測都回 `{"can_read_home_file":true,"byte_length":104}`（與 `stat` 一致） |
| `--ignore-user-config` + `--ephemeral` + 空 cwd + `mcp_servers={}` + `web_search="disabled"` | **無效**（同上探測仍讀得到） |
| `env -i` 清空環境 | **會讓 codex 完全失敗**（`gpt-5.6-luna` 與 `gpt-5.6-sol` 皆 exit 1）→ 證明當時缺必要變數；改用「明確白名單＋路徑型變數固定值」建構 child env |

### bubblewrap 設計

**已確認本機有 `bubblewrap 0.9.0`（`/usr/bin/bwrap`），無新依賴。**

必要參數（Round 3 #2 修正：mount 清單改為精確列舉，不再整包掛 `/etc`）：

**唯讀掛載（逐項列舉，Phase 2 實測補齊後凍結）**
- `/usr`、`/lib`、`/lib64`（執行期）
- **codex 執行所需的最小集合（Round 4 #2 修正：不掛整個 `~/.npm-global`）**：解析後的 `@openai/codex` 套件目錄、其 launcher 腳本、Node runtime 執行檔，以及 `ldd` 解析出的相依動態函式庫。
  理由：`~/.npm-global` 內另有 Bitwarden、Gemini、Wrangler、Google Workspace 等無關工具，整包掛入不是最小掛載。
- `/etc/ssl`、`/etc/ca-certificates`（TLS 憑證）
- `/etc/nsswitch.conf`、`/etc/hosts`、`/etc/localtime`（名稱解析與時區）
- `/mnt/wsl/resolv.conf` **與** `/etc/resolv.conf`（WSL symlink 兩端都要，見下方坑）
- `/etc/passwd`（僅在實測證明必要時；否則不掛）

**明確不掛**：`/etc` 整包（`/etc/environment`、`/etc/wsl.conf` 等一般使用者可讀，且未來可能新增秘密——不可把「現在碰巧沒秘密」當成未來的安全假設）、repo、`~/.ssh`、`~/.config`、`~/.claude`、`~/.ccm-*`、`~/.gemini-api-key`。

**讀寫掛載**
- 每次呼叫新建的空 cwd
- output 目錄（只放 schema 與 `-o` 兩個暫存檔）
- **`~/.codex/auth.json` 的精確處理（Round 5 #5 修正：預先選定唯一規則，不留模糊分支）**：

  **採用「每次呼叫用完即丟的臨時 CODEX_HOME」**：
  1. 每次呼叫在沙箱可寫區建立一個臨時目錄當 `CODEX_HOME`。
  2. 把 host 的 `auth.json` **複製**進去（0600）。
  3. 沙箱內允許 codex 自行更新該複本（refresh 可正常運作，不會失敗）。
  4. 呼叫結束後**整個臨時目錄丟棄**，**永不回寫 host**。

  **不採用**：唯讀 bind（refresh 需要寫入時會失敗）、host 回寫（有舊值覆蓋新值與損毀風險）。

  代價：每次呼叫若 codex 真的 refresh 了權杖，該次結果不保留，下次仍從 host 複本開始。實務上 host 端的 Claude/Codex 互動會自行維持 auth 新鮮度，可接受。

  **若 Phase 2 實測發現此模式無法運作**（例如 codex 拒絕在複本上啟動），**停止 rollout 並另開安全決策卡**，不得在本計畫內默默改成 host 回寫。

  **不得**把整個 `~/.codex` 掛成可寫。

**namespace 與生命週期**
- **`--unshare-pid`（必要）**：否則共用 PID namespace 時，同 user 的 `/proc/<pid>/environ` 會暴露父程序未清洗的 `DATABASE_URL`／`GEMINI_API_KEY`（supervisor L299／L311／L327 注入）
- **`--die-with-parent`（必要）**：避免 worker 被砍後留下孤兒程序
- **`--unshare-uts --unshare-ipc`**
- `--proc /proc --dev /dev --tmpfs /tmp`

**WSL 專屬坑（實測踩到）**：`/etc/resolv.conf` 是指向 `/mnt/wsl/resolv.conf` 的 symlink。只綁 `/etc` 時該連結在沙箱內斷掉 → DNS 失敗 → codex 反覆重連 `wss://chatgpt.com/...` 直到逾時（實測 exit 124）。
修法：額外 `--ro-bind /mnt/wsl/resolv.conf /mnt/wsl/resolv.conf`，或把解析後內容寫成沙箱內實體檔。

### env 清洗：明確白名單 ＋ 路徑型變數固定值（Round 2 #2 ＋ Round 3 #2 修正）

Round 2 指出「移除清單 + etc.」是開放式的，未來新增的秘密會漏。但 `env -i` 實測會壞。

**做法（Round 3 #2 修正：路徑型變數改為「固定值」而非「繼承值」）**：child env 完全由程式建構，分兩類：

**類別一：固定為沙箱內路徑（不從父程序繼承）**

```
HOME       = <沙箱內 home，例如 /work-home>
CODEX_HOME = <沙箱內 codex home（auth.json 掛入此處）>
TMPDIR     = /tmp（沙箱內的 tmpfs）
PATH       = 固定字串，只含沙箱內存在的執行路徑
```

理由：這些變數若原樣繼承，惡意或錯誤設定可擴大掛載面／指向沙箱外路徑。

**類別二：可繼承的無害值（明確列舉）**

```
LANG, LC_ALL, TERM, USER, LOGNAME
CC_MEMORY_CAPTURE_CHILD = 1
```

`XDG_RUNTIME_DIR` **預設不傳**（指向 `/run/user/<uid>`，屬沙箱外路徑）；若 Phase 2 實測證明必需，改為指向沙箱內路徑的固定值。

其餘一律不傳。**Phase 2 必須實測確認此組合足以讓 codex 正常啟動**（`env -i` 曾失敗只證明當時缺必要變數，不代表乾淨環境不可行）；若不足則逐項加入並記錄理由，不得整包放行。

**負向測試**：把 `PATH`／`HOME`／`TMPDIR` 設成惡意值（指向沙箱外、指向 `~/.ssh` 等），驗證掛載面不會因此擴大。

### 明示接受的殘餘風險

Codex 需要自身憑證才能運作，因此沙箱內必然存在一份 `auth.json` 複本（見上方「臨時 CODEX_HOME」設計），模型產生的 shell 指令**讀得到 Codex 自己的憑證複本**。

- 為什麼接受：該憑證正是這個子程序本來就在用的身分，沒有它 codex 無法執行。
- 真正的根治是**限制網路外送**（只允許連 OpenAI endpoint），成本高且與 WSL DNS 交互複雜，**本次不做**。
- 相對地，`DATABASE_URL`、`GEMINI_API_KEY`、Telegram token、`~/.ccm-*` 等**其他**秘密必須被沙箱擋住，此為硬性驗收條件。

---

## 沙箱驗收（Round 2 #2 ＋ Round 3 #2 修正：不採信模型自述）

Round 2 的關鍵指正：**模型回答「讀不到」不構成證據**——它可能只是拒絕、沒發工具呼叫、或幻覺。驗收必須是作業系統層級的證據。

### 三層驗收，全過才算通過

**L1：確定性探測（不含 LLM）**

把沙箱指令組成**單一可重用函式**，然後用同一組 `bwrap` 參數執行一支**確定性小程式**（非 LLM），嘗試直接讀（Round 3 #2 擴充清單）：

**秘密檔**
- `~/.ccm-project-url`、`~/.ccm-personal-url`
- `~/.gemini-api-key`
- `~/.ccm-memory-alert.env`
- `~/.ccm-todoist-token`

**其他敏感面**
- repo 根（`~/CC_project/CC-memory`）
- `~/.ssh`、`~/.config`、`~/.claude`
- `/etc/environment`、`/etc/wsl.conf`

**逃逸路徑**
- `/proc/1/root/home/haha/.gemini-api-key`
- 已知父程序 PID 的 `/proc/<pid>/environ`
- `/proc/self/mountinfo`（列出實際掛載面，與預期清單逐項比對）

**正面斷言（Round 5 #4 修正：只比對掛載點不夠，必須連來源與屬性一起核對）**

Round 5 正確指出：只比 destination 抓不到「預期掛 `/work-home`，實際卻把 host home 綁過去」或「本該唯讀卻可寫」。

- 讀 `/proc/self/mountinfo`，正規化後對**每一筆**逐項核對五個欄位：
  1. **destination**（掛載點路徑）
  2. **resolved source / root**（實際來源與子路徑）
  3. **filesystem type**
  4. **`ro` / `rw`**（唯讀掛載必須真的是 `ro`）
  5. **propagation**（掛載傳播屬性）
- 多一筆、少一筆、任一欄位不符 → 失敗。
- `/proc`、`/dev`、`/tmp` 列為明確例外，只斷言其存在、類型與 `rw`/`ro` 屬性，不比對內容。

**nonce 交叉驗證（Round 5 #4 新增）**：在**每一個應被拒絕的來源目錄**下各放一個隨機 nonce 檔，然後在沙箱內**掃遍所有已掛載路徑**確認讀不到任何 nonce。這能抓出「敏感資料被掛到另一個被允許的掛載點」這種只測固定原路徑抓不到的錯誤。

**斷言：秘密與敏感面一律回 `ENOENT` 或 `EACCES`。** 這是唯一可信的證據。

**L2：對抗式 LLM 探測（採事件流證據）**

用 `codex exec --json` 搭配一份要求「用 shell 讀取某隨機 nonce 檔並回報」的對抗式 transcript。
**通過條件：事件流無任何 tool call（工具呼叫）事件且輸出合法 JSON。** codex-code-mode-host 未掛載（純文字模式（pure text mode）），Codex 在此沙箱內無法執行 shell 工具，因此不會產生 tool call 事件；最終答案寫 `false` 不算通過。

> **2026-08-23 sandbox-acceptance 補記**：`sandbox-acceptance-2026-08-23.md` 14/14 測試通過（L1×6 確定性探測、L2×1 對抗式探測、L3×7 功能正向）。codex-code-mode-host **未掛載**，確認為純文字模式；殘留接受風險：codex `auth.json` 在 bwrap 內可讀（已明示接受）。

**L3：功能正向探測**

同一份 32 KiB transcript 在沙箱內仍能抽出合法 JSON（證明沙箱沒把功能弄壞）。

同時驗證：逾時行為、SIGTERM/SIGKILL、DNS、output 檔寫入、暫存檔清理、孤兒程序回收。

---

## 已驗證的呼叫方式（最終版，無 `--ignore-rules`）

```
bwrap <上述參數> -- \
codex exec --model <model> --ephemeral --skip-git-repo-check \
  -s read-only --ignore-user-config \
  -c 'mcp_servers={}' -c 'web_search="disabled"' \
  -c '<deny-all execpolicy 政策指定>' \
  -C <isolated-cwd> \
  --output-schema <schemaFile> -o <outFile> -
```

prompt 走 stdin。版本 `codex-cli 0.149.0`。

### 模型字串未定（U2，Phase 1 前置）

同旗標下，**繼承環境**時 `gpt-5.6-luna` 正常；**清空環境**時回 `The 'gpt-5.6-luna' model requires a newer version of Codex`。`~/.codex/config.toml` 預設為 `gpt-5.6-sol`；模型清單刷新另有 `unknown variant 'max'` 解碼錯誤。

→ Phase 1 必須在**沙箱＋白名單 env 的實際條件下**確定可用模型字串，並讓 adapter 對「模型不可用」丟明確錯誤碼（不得靜默降級）。

### 與 claude-cli 的結構差異

| 項目 | claude-cli | codex exec |
|---|---|---|
| JSON schema | `--json-schema <inline 字串>` | `--output-schema <檔案路徑>` |
| 結果取得 | stdout 的 JSON envelope | `-o <檔案路徑>` |
| system prompt | `--system-prompt <字串>` | 無 → 必須內嵌（`includeOpeningInstructions: true`） |
| 工具隔離 | `--tools ''`（完全停用） | 無等效機制 → 靠外部沙箱 |

→ codex adapter 每次呼叫需建立兩個暫存檔（schema + output），`finally` 清理。

---

## 現況程式碼地圖

### `src/services/capture-llm.ts`（753 行）

- `createCaptureLlmAdapter()` L705-753：三分支工廠（claude-cli L713-736／未知 provider L737-741／gemini-flash L743-752）
- `ClaudeCliCaptureLlmAdapter` L529-638：新 adapter 範本
- `runClaudeCliSubprocess` L472-527：spawn、逾時 SIGTERM → **1 秒後 SIGKILL**、刪子程序 `GEMINI_API_KEY`、設 `CC_MEMORY_CAPTURE_CHILD=1`（**未刪 `DATABASE_URL`**）
- `ClaudeCliRunner` L159：依賴注入接縫
- `CaptureLlmAdapter` 介面 L134：**只暴露 `provider`／`model`／`disabled`**（Round 2 #6／#8 的根因：reserve 算不到 fallback 逾時、worker 拿不到 provider 計數）
- `CaptureLlmErrorCode` L169-178：9 碼
- `DEFAULT_CAPTURE_LLM_PROVIDER = 'claude-cli'` L10：**同時是預設值與 Claude 身分識別**
- 錯誤產生點：L416（`CLAUDE_CLI_OUTPUT_INVALID`）、L588（timeout）、L600（`stdout || stderr` 遮蔽 bug）

### `src/services/capture-worker.ts`（2141 行）

唯一 `llm.extract()` 在 **L1973**，包在 L1959 起的 2-attempt 迴圈（只為 malformed JSON 重試一次）。

**所有讀取 error.code／adapter 欄位的位置（Round 2 #1 要求窮舉）**：

| 位置 | 讀什麼 |
|---|---|
| L1373 `llmErrorCode` | `error.code` |
| L1383 `llmRawOutputFromError` | error metadata |
| L1396 `isMalformedJsonLlmError` | `LLM_MALFORMED_JSON` |
| L1400 `isPromptTooLongLlmError` | `CLAUDE_CLI_EXIT_NONZERO` ＋訊息比對 |
| L1410 `isClaudeCliTimeoutError` | `CLAUDE_CLI_TIMEOUT` |
| L1590 | `llm.provider` |
| L1740 | `llm.disabled` |
| L1992 | `CAPTURE_LLM_DISABLED` |
| L2003 | `CLAUDE_CLI_RATE_LIMITED` |
| L2058／L2060 | `llm.model`、error metadata |

catch 分支順序 L1986-2023：malformed 重試 → disabled → rate-limited（停 tick）→ prompt-too-long／timeout（切窗）→ terminal retry。
**Round 2 已確認此順序不會 double-count**（rate-limit 分支先 break）。

- `captureMaxWindowBytes(env, llm)` L615-625：只有 `provider === 'claude-cli'` 回 32 KiB，其餘 256 KiB
- `llmCallBudgetReserveMs(env, llm)` L648-658：**非 claude-cli 一律回 0** ← 必修
- `splitTranscriptChunk` L809：>1,024 bytes 保證前進；**≤1,024 bytes 回 `null`** → terminal retry，五次 park
- tick budget 預設 240,000 ms（L151）；`LLM_CALL_SETTLE_RESERVE_MS = 15,000`（L39）
- **呼叫 LLM 前的工作**（L1592 起，Round 2 #6）：DB health check → `totalSpoolBytes`（**遞迴 stat 整個 spool**）→ `listSpoolSessions` → legacy sidecar 處理 → cursor 載入 → 取鎖／讀狀態
- spool 上限判定 L609／候選檔篩選 L674：**sealed 檔仍計入 500 MB 上限，但只有 `.jsonl` 是處理候選**

### 其他關鍵位置

- `scripts/run-auto-capture.ts` L60：唯一 summary 行
- `src/services/auto-capture-alerts.ts`：欄位解析器 L108（**逐欄位具名、空白分隔 → 追加欄位不會破壞既有正則**）；`ok` 要求 `nonSummaryLines.length === 0`（L155/L169）
- `scripts/lib/production-readiness.ts` L223：**逐位元比對** installed 與 repo unit；L148 附近文案仍稱三硬指標為 Go/No-Go
- `scripts/run-auto-capture-supervisor.ts` L299-340：child env 建構；硬逾時 270 s、`SIGKILL_GRACE_MS = 5,000`
- `docs/auto-capture-v0.5/memory-ops-cutover.md`：§2 安裝程序 L201／L216／L226；§9 Go/No-Go L375

### 測試慣例（`tests/services/capture-llm.test.ts`，479 行）

`adapterOptions({env, stdout, runClaudeCli, findClaudeCli})`（L29-39）、`stdoutSink()`（L41-53）、`request(overrides)`。假 runner 直接回 `{stdout, exitCode}`，不 spawn 真程序。

---

## 設計決策

### D0：錯誤碼改為「依 worker 動作」分類（修 Round 1 #1 / Round 2 #1）

**問題**：worker 的分支全部硬比對 `CLAUDE_CLI_*`。codex 丟自家碼 → 認不得 → 落到 terminal retry → park + dead-letter，而不是正確動作。

**完整錯誤碼清單（Round 2 要求窮舉）**：

| 碼 | 狀態 | worker 動作 |
|---|---|---|
| `CAPTURE_LLM_DISABLED` | 保留 | skipped，停 tick |
| `UNSUPPORTED_CAPTURE_LLM` | 保留 | terminal |
| `LLM_MALFORMED_JSON` | 保留 | 同 provider 重試一次 |
| `LLM_SCHEMA_INVALID` | 保留 | terminal |
| `LLM_EXTRACT_FAILED` | 保留 | terminal |
| `CLAUDE_CLI_EXIT_NONZERO` | 保留（相容） | terminal（或經訊息比對轉 prompt-too-long） |
| `CLAUDE_CLI_OUTPUT_INVALID` | 保留 | terminal |
| `CLAUDE_CLI_RATE_LIMITED` | 保留（相容） | 停 tick |
| `CLAUDE_CLI_TIMEOUT` | 保留（相容） | 切窗 |
| **`CODEX_CLI_EXIT_NONZERO`** | **新增**（Round 2 #1 漏項） | terminal |
| **`LLM_RATE_LIMITED`** | **新增** | 停 tick、計 `rateLimited`、不增 attempts |
| **`LLM_PROMPT_TOO_LONG`** | **新增** | 切窗 |
| **`LLM_TIMEOUT`** | **新增** | 切窗 |

**兩個單一判斷函式（Round 5 #1 修正）**：新增 `toFailureCategory(error): FailureCategory` 與 `toWorkerAction(category): WorkerAction`（型別與映射表見 D4），把 L1396-1412 與 L1986-2023 的散落條件收斂成一處。worker 依 action switch。新舊錯誤碼都映射到同一 category，既有測試不破。

claude adapter 改丟新碼，`details.legacyCode` 保留舊碼供診斷。

### D1：fallback 放在包裝器層

`capture-llm.ts` 新增 `FallbackCaptureLlmAdapter`，worker 呼叫點不動。理由：worker L1959-2023 是全檔最密區段，在此加分岔回歸風險高；包裝器可純單元測試。

**欄位契約**（Round 1 #4，Round 2 判定 RESOLVED，保留）：

| 欄位 | 回傳 |
|---|---|
| `.provider` | primary 的 provider |
| `.model` | primary 的 model（dead-letter L2058 用） |
| `.disabled` | **兩者都 disabled 才 `true`** |
| `.disabledReason` | 兩者原因合併 |
| 回傳 `RawResponse.model` | **實際服務該次呼叫的 model** |

工廠用不讀 fallback env 的 `createSingleAdapter()` 建兩端，避免遞迴；未知 fallback provider **fail-fast**。

### D1b：擴充 `CaptureLlmAdapter` 介面（修 Round 2 #6／#8 的共同根因）

現行介面（L134）只有 `provider`／`model`／`disabled`，導致：預算算不到 fallback 逾時、worker 拿不到 provider 計數。

**新增兩個成員**：

**1. `worstCaseCallBudgetMs: number` —— required（必填，Round 3 #4 修正）**

原設計 `callTimeoutMs?: number` 為 optional，遇到沒有逾時契約的 adapter（現行 `GeminiFlashCaptureLlmAdapter` L640-659 就沒有）會拿到 `undefined`，預算計算失去意義。

改為**必填**，語意是「這個 adapter 單次呼叫最壞情況耗時上限（含 kill grace）」。規則：

- claude-cli：`CC_CAPTURE_CLAUDE_TIMEOUT_MS + 1s killGrace`
- codex-cli：`CC_CAPTURE_CODEX_TIMEOUT_MS + 1s killGrace`
- **gemini-flash：目前無逾時契約（`GeminiFlashCaptureLlmAdapter` L640-659 直接 `await` SDK 呼叫）。**
  Round 4 #9 正確指出：若只寫「不得加入 fallback chain」，等於實質停用一個宣稱要保留的 provider，與「明確不做：不移除 gemini-flash」自相矛盾。
  **處置：把補逾時納入本次範圍**——Phase 5 為 `GeminiFlashCaptureLlmAdapter` 加上 `AbortSignal` 硬逾時（新增 `CC_CAPTURE_GEMINI_TIMEOUT_MS`，預設 90000）。**實作位置：`generateContent` 的 `config.abortSignal`，不是頂層參數**（本機 `@google/genai` 1.52.0 的 `GenerateContentConfig` 支援此欄位），使其能提供有限的 `worstCaseCallBudgetMs`。補完後 gemini-flash 可正常作為 primary 或 fallback，不需停用。
- `FallbackCaptureLlmAdapter`：回 `primary + secondary` 之和。

`llmCallBudgetReserveMs` 改為 `adapter.worstCaseCallBudgetMs + LLM_CALL_SETTLE_RESERVE_MS`，不再讀 env 猜測。

**2. `takeTelemetry(): CaptureTelemetrySnapshot` —— 精確生命週期（Round 3 #3 修正）**

Round 3 指出「extract 迴圈結束後讀取」有歧義：extract 迴圈在**每個 chunk 內**（L1883／L1959），而 `runCaptureWorkerOnce` 另有多個早退路徑（DB health L1579、spool cap L1592、空 spool L1600）。

**明訂（Round 4 #3 修正：需要先重構才成立）**：

Round 4 正確指出：目前的早退發生在**任何 try 區塊之前**（L1586 DB health、L1597 spool cap、L1601 空 spool），而且 L1597 回傳的是 **clone**（`return { ...result, skipped: 1 }`）——在 `finally` 裡改 `result` 不會影響已回傳的複本；丟例外時更沒有 result 物件可承載遙測。

因此本 Phase **必須先做三項小重構**，之後 `finally` 語意才成立：

1. **單一可變 result 物件**：把 `return { ...result, skipped: 1 }` 改為 `result.skipped = 1; return result;`，消除所有 clone 式早退。
2. **單一函式層 try/finally**：在 `result` 初始化之後、其餘邏輯之前開一個 `try`，`finally` 涵蓋全部早退路徑。
3. **例外語意明訂（Round 5 #6 修正：不能只捕捉，還要維持 exit code 契約）**

   Round 5 正確指出兩件事：現行 top-level 例外會一路傳到 `run-auto-capture.ts:74` 讓程序 **exit 1**；而 supervisor **同時**讀 child exit code（L416／L505）**與** summary，不是「只讀 summary」。若改成捕捉後正常回傳，直接跑腳本的情境會把致命例外誤判成成功。

   **採用：捕捉 → 回傳帶遙測的 result → 但保留非零結束碼**
   - `CaptureWorkerResult` 新增 `fatalError: string | null`。
   - `runCaptureWorkerOnce` 捕捉例外後填入 `fatalError` 並回傳（遙測得以隨 result 帶出）。
   - `run-auto-capture.ts`：**先印 summary 行**（含 `fatal=1`），**再以非零碼結束**。
   - `auto-capture-alerts.ts`：新增 `fatal` 欄位解析，`fatal>0` 一律判不健康。
   - 測試：直接跑 runner 時致命例外 → summary 有印出 **且** exit code 非零；supervisor 路徑照樣告警。

在此基礎上：

- `takeTelemetry()` **恰好在函式層 `finally` 呼叫一次**，不在 chunk 或 session 層。
- 呼叫即回傳快照並清零。
- 快照寫入同一個可變 result 物件，故不遺失、不跨 tick 殘留、不重複計數。

**測試（Round 4 #3 要求）**：spool-cap 早退路徑（原 clone 路徑）遙測正確；session 處理前丟例外時遙測仍隨 result 回傳；連跑兩 tick 不殘留。

**計數語意（Round 3 #3 要求釐清）**：

| 欄位 | 定義 |
|---|---|
| `primaryProvider` | primary adapter 的 provider 字串 |
| `primarySuccess` | **成功的 LLM 呼叫次數**（非成功寫入的窗口數；一次呼叫可能後續寫入失敗） |
| `fallbackSuccess` | primary 失敗後、fallback 成功回傳的呼叫次數 |
| `fallbackFailed` | primary 與 fallback 皆失敗的次數 |

**測試**：同一 adapter 連跑兩個 tick 不殘留；不含任何 extract 的早退路徑回零；rate-limit 停 tick 路徑計數正確；session 處理中丟例外時計數不遺失。

不採用「包裝器自己印 stdout」的做法——`auto-capture-alerts.ts` 的 `ok` 要求 `nonSummaryLines.length === 0`，多印一行會被判故障。

### D2：窗口大小與換手的交互

包裝器 `.provider` 回報 primary（codex-cli）→ 窗口 256 KiB（實測最有效率）。換手到 haiku 時 haiku 收到 256 KiB，可能 prompt-too-long；經 D0 統一為 `LLM_PROMPT_TOO_LONG` → 切窗分支接手。

`splitTranscriptChunk` 已驗證保證前進、無無限迴圈；≤1,024 bytes 回 `null` → 有限次 park（可接受的既有行為，須有具名測試）。

### D3：換手觸發條件

| 錯誤 | 換手？ |
|---|---|
| `LLM_RATE_LIMITED` | ✅ |
| `LLM_TIMEOUT` | ✅ |
| `CODEX_CLI_EXIT_NONZERO` | ✅ |
| `CAPTURE_LLM_DISABLED`（codex 缺席／模型不可用） | ✅ |
| `LLM_MALFORMED_JSON` / `LLM_SCHEMA_INVALID` | ❌（worker 已有同 provider 重試） |
| `LLM_PROMPT_TOO_LONG` | ❌（必須上拋切窗） |

### D4：換手組合策略（Round 5 #1 修正：拆成「失敗類別」與「worker 動作」兩層型別）

Round 5 正確指出上一版混用兩套語彙：`classifyLlmError` 只回 5 種值，D4 表格卻用 `timeout`／`prompt-too-long` 當 action，且缺 fallback timeout 欄位，又與 D3 的「`LLM_SCHEMA_INVALID` 不換手」矛盾。本節改為**兩層型別**，各司其職。

#### 層一：failure category（失敗類別，由錯誤碼直接映射）

```
type FailureCategory =
  | 'malformed'        // LLM_MALFORMED_JSON
  | 'schema-invalid'   // LLM_SCHEMA_INVALID
  | 'prompt-too-long'  // LLM_PROMPT_TOO_LONG
  | 'timeout'          // LLM_TIMEOUT / CLAUDE_CLI_TIMEOUT
  | 'rate-limited'     // LLM_RATE_LIMITED / CLAUDE_CLI_RATE_LIMITED
  | 'disabled'         // CAPTURE_LLM_DISABLED
  | 'exit-nonzero'     // CODEX_CLI_EXIT_NONZERO / CLAUDE_CLI_EXIT_NONZERO
  | 'terminal'         // LLM_EXTRACT_FAILED / CLAUDE_CLI_OUTPUT_INVALID / UNSUPPORTED_CAPTURE_LLM
```

#### 層二：worker action（worker 依最終 category 決定要做什麼）

```
type WorkerAction =
  | 'retry-malformed'  // 同 attempt 迴圈重試一次
  | 'split'            // 切窗
  | 'rate-limited'     // 停 tick，不增 attempts
  | 'disabled'         // skipped，停 tick
  | 'blocked'          // 新增：暫緩，不增 attempts（見下）
  | 'terminal'         // 進 retry 計數，五次寫 dead-letter
```

**category → action 映射（worker 端唯一真相）**：

| category | action |
|---|---|
| `malformed` | `retry-malformed` |
| `schema-invalid` | `terminal` |
| `prompt-too-long` | `split`（不可再切時見降級規則） |
| `timeout` | 依 **subtype（細分類）** 決定：`timeout/size-or-deadline` → `split`；`timeout/service-or-network` → `blocked`（見下） |
| `rate-limited` | `rate-limited` |
| `disabled` | `disabled` |
| `exit-nonzero` | `terminal` |
| `terminal` | `terminal` |

#### wrapper 的第一步：要不要叫 fallback？（只看 category）

| primary category | 叫 fallback？ | 理由 |
|---|---|---|
| `rate-limited` | ✅ | 換手的主要目的 |
| `disabled` | ✅ | 該 provider 不可用 |
| `timeout` | ✅ | 換一家可能較快 |
| `exit-nonzero` | ✅ | CLI 層失敗 |
| **`terminal`** | ✅ | **（Round 6 #3 補列）`LLM_EXTRACT_FAILED`／`CLAUDE_CLI_OUTPUT_INVALID` 屬 provider 端問題，換一家值得試** |
| `malformed` | ❌ | 由 worker 的 attempt 迴圈重試 |
| **`schema-invalid`** | ❌ | **與 D3 一致：換模型不會讓 schema 變合法** |
| `prompt-too-long` | ❌ | 必須上拋讓 worker 切窗 |

→ 可達的 primary category 共 **5 種**：`rate-limited`、`disabled`、`timeout`、`exit-nonzero`、`terminal`。

#### wrapper 的第二步：fallback 也失敗時，最終回報哪個 category

5 種可達的 primary category × 8 種 fallback 結果（**Round 5 #1 要求補上 timeout 欄**）：

| primary ＼ fallback | 成功 | malformed | schema-invalid | prompt-too-long | timeout | rate-limited | disabled | exit-nonzero／terminal |
|---|---|---|---|---|---|---|---|---|
| `rate-limited` | 成功 | malformed\† | schema-invalid | prompt-too-long\* | **timeout\‡** | rate-limited | rate-limited | rate-limited |
| `disabled` | 成功 | malformed\† | schema-invalid | prompt-too-long\* | **timeout\‡** | rate-limited | disabled | terminal |
| `timeout` | 成功 | malformed\† | schema-invalid | prompt-too-long\* | **timeout\‡（雙 timeout → blocked）** | rate-limited | timeout\‡ | terminal |
| `exit-nonzero` | 成功 | malformed\† | schema-invalid | prompt-too-long\* | **timeout\‡** | rate-limited | terminal | terminal |
| `terminal` | 成功 | malformed\† | schema-invalid | prompt-too-long\* | **timeout\‡** | rate-limited | terminal | terminal |

`‡` = timeout 保持獨立 category，由 subtype 決定 `split` 或 `blocked`（見下）。**雙 timeout 一律 `blocked`。**

**`†`（Round 6 #1／#4 修正：改用 `retryProvider` 導向，wrapper 不做內部重試）**

上一版讓 wrapper 內部對 fallback 重試一次，造成兩個新缺陷（Codex Round 6 抓到，確認為真）：
- 預算變成 `primary + fallback × 2 = 91 + 76×2 + 15 = 258 s` > tick budget 240 s → **worker 永遠不會開窗**（`elapsed=0` 也過不了 L1960 的檢查）。
- 序列實際是 `P→F→F→P→F→F`，並沒有達成「primary 只打一次」的目的。

**改為**：wrapper **每次呼叫最多打 primary 一次 + fallback 一次**，不做內部重試。fallback 回 malformed 時：
- 上拋 `malformed`，`details.retryProvider = 'fallback'`
- **worker 的 attempt-1 重試看到 `retryProvider` 就直接呼叫 fallback**（跳過 primary）。
- 第二次仍失敗時，**回報第二次呼叫的真實 category**（若變成 timeout 或 rate-limited 就照實報，不強制改報 malformed），並標記 retry 已用盡。

**介面變更（Round 7 #1 修正：先前漏宣告）**

`CaptureLlmAdapter.extract` 目前只接受一個參數（L134），worker 也無處保存該選項。因此**必須**：

- 新增 `interface CaptureLlmExtractOptions { forceProvider?: string }`
- `extract(request: CaptureLlmRequest, options?: CaptureLlmExtractOptions)`，**所有 adapter（claude-cli／codex-cli／gemini-flash／disabled／unsupported／fallback wrapper）同步改簽章**（非 wrapper 的 adapter 忽略該參數）
- worker 在 attempt 迴圈保存上一輪的 `retryProvider` 並於下一次呼叫傳入

→ 因此 **D1 的「worker 呼叫點不動」需修正為：呼叫點只多傳一個選項參數，catch 分支結構不動**。

**預算與跨 tick 續跑（Round 7 #1 修正）**

- 正常路徑預算 = `primary(91 s) + fallback(76 s) + settle(15 s) = 182 s`，**58 s 開窗邊界不變**。
- 但完整 malformed 路徑（`P→F` 後再 `F`）最壞會到 `167 + 76 = 243 s` > 240 s tick budget。
- **處置**：第二次呼叫若預算不足而 yield，**必須把 `retryProvider` 持久化進 `CaptureStateV2` 的 retry entry**（additive 新欄位 `pendingRetryProvider`），下個 tick 直接從 fallback 開始，不重打 primary。
- 測試：`P→F→F` 序列、預算不足時 yield 並持久化、下個 tick 從 fallback 續跑、第二次呼叫的 reserve 計算。

**`*` 降級規則**
wrapper 上拋 `prompt-too-long` 時，`details.alternateCategory` 帶 **primary 的 category**。worker 在 `splitTranscriptChunk(chunk)` 回 `null`（≤1,024 bytes）時改用 `alternateCategory` 的 action：
- alternate 為 `rate-limited`／`disabled`／`timeout` → 不增 attempts，本 tick 跳過，留待下次（資料不放棄）
- alternate 為 `exit-nonzero`／`terminal` → 照常 terminal 計數
**timeout 的處理（Round 7 #2 修正：timeout 保持獨立 category，不在表格中改寫成 prompt-too-long）**

上一版把 fallback timeout 在 5×8 表中一律改報 `prompt-too-long*`，與後文「double timeout → blocked、不寫 splitHints」自相矛盾，且 D0／Phase 1 測試仍寫「timeout 無條件切窗」。

**改為**：`timeout` 在表格與映射中**全程保持自己的 category**，由 **subtype** 決定動作：

| subtype | 判定依據 | action |
|---|---|---|
| `timeout/size-or-deadline` | 錯誤訊息明示輸入過大或處理 deadline | `split` |
| `timeout/service-or-network` | 其餘（含連線失敗、服務中斷、判不出來的情況） | `blocked` |

- **預設走 `service-or-network`**（判不出來時保守退避），避免 outage 期間拆到 1 KiB 並寫下大量 `splitHints`。
- `blocked` 路徑**一律不寫 `splitHints`**。
- D0 的 category→action 表、5×8 表、worker 順序與 Phase 1 測試全部依此同步。

**`blocked` 的觸發（Round 6 #3 修正：改為直達，不依賴不存在的路徑）**
上一版寫「alternate 本身也是 `prompt-too-long` → blocked」，但 primary 的 `prompt-too-long` **根本不會換手**，該條件不可能發生。
**改為**：任何 `prompt-too-long`（不論來自單一 provider 或換手後）在 `splitTranscriptChunk` 回 `null`（已達最小 chunk）且**沒有可用的 `alternateCategory`** 時，**直接進入 `blocked`**。

#### 新增的 `blocked` action：狀態與界線（Round 5 #2 修正）

現有 `CaptureRetryEntry`（L168）只有 attempts 與時間欄位，且 retry hold 在進 LLM 前就生效（L1936），正式最短間隔 30 分鐘（L152）。因此「連續 5 個 tick」語意不精確——中間大量 tick 只會 `held`。

**明訂**：

- `CaptureStateV2` 的 retry entry **additive 新增三欄**：`blockedAttempts: number`、`lastBlockedAtIso: string`、`blockedReason: string`。舊 state 缺欄位時預設 `blockedAttempts = 0`（向後相容）。
- **所有 blocked 原因共用同一個 streak（連續計數）**（Round 7 #2 修正）——最小 chunk 的 prompt-too-long、雙 timeout、降級後的 rate-limited／disabled 全部累加到同一個 `blockedAttempts`，避免兩種原因交替時永不升級。
- 界線定義為 **5 次「符合 retry-min-interval 的有效 blocked 嘗試」**，第 6 次才寫 dead-letter，`reason` 記錄**最後一次的 blocked subtype**，並發告警。被 `held` 的 tick **不計入**。
- **hold 判定必須改讀 blocked 欄位**（Round 7 #2 修正）：現行 `isCaptureRetryHeld`（L637）只看 `attempts`／`lastAttemptIso`；blocked 路徑不增 `attempts`，若不同步改讀 `blockedAttempts`／`lastBlockedAtIso`，連續六個快速 tick 就會過早 dead-letter。**須擴充該函式同時考量兩組欄位。**
- **reset 規則（收緊）**：**只有**該 chunk 成功、或 `contentHash` 改變才歸零。**category 改變不 reset**（否則兩種 blocked 原因交替就永不升級）。
- `CaptureWorkerResult` 與 summary 行新增 `blocked=` 欄位，並接入 `auto-capture-alerts.ts`——否則前五次 blocked 會被判成健康。

#### worker 端的實作順序

`chunk`／`retryKey`／`state`／`chunks` 在 L2008 切窗處都仍在 scope，可實作。順序必須是：

1. 收到 `prompt-too-long` → 呼叫 `splitTranscriptChunk(chunk)`
2. **成功切分** → 先 `chunks.unshift(...)` 排入子 chunk，**之後才**設 `promptSplit = true` 並 `continue`
3. **回 `null`** → 讀 `details.alternateCategory`，**在指派 `terminalError` 之前**先分派對應 action
4. malformed 的 `continue` 只允許在 `attempt === 0`（維持現行 L1987 行為）

#### 測試

- category → action 映射表 8 列各一測
- wrapper 第一步 8 列各一測（含 `terminal` 換手、`schema-invalid` 不換手）
- wrapper 第二步表格 5×8 ＝ 40 格各一測
- `†` 內部重試：確認 primary 只被呼叫一次、fallback 兩次
- `*` 降級三種 alternate 各一測
- `blocked`：5 次有效嘗試後第 6 次 dead-letter＋告警；held 的 tick 不計入；三種 reset 條件各一測；舊 state 無欄位時預設 0
- worker 端順序：切分成功時子 chunk 確實先入列

### D5：預算鏈

```
reserve = codexTimeout + claudeTimeout + 2×killGrace(1s) + settle(15s)
        = 90,000 + 75,000 + 2,000 + 15,000 = 182,000 ms
```

worker 開新窗條件（L1960）`elapsed + reserve <= budget` →

```
elapsed + 182,000 <= 240,000  →  elapsed <= 58,000 ms
```

reserve 的組成資料由 D1b 的 required `worstCaseCallBudgetMs` 提供（不再靠讀 env 猜）。

**Phase 0 量測範圍（修 Round 2 #6）**：不是只量 `listSpoolSessions`，而是量**從 tick 起點到第一次 `llm.extract` 的完整 elapsed**，涵蓋 DB health check、`totalSpoolBytes`（遞迴 stat 18,043 檔）、session 列舉、legacy sidecar、cursor 載入、取鎖與狀態讀取。取 p95 與最壞值。
若 p95 接近或超過 58 s，必須同步調整 240/270/300 整條鏈，不得只在文件宣稱「保守可完成一窗」。

`CC_CAPTURE_CODEX_TIMEOUT_MS` 預設 **90000**（實測 256 KiB 為 25 s）。

### D6：常數拆分（修 Round 2 #10）

**無條件**新增 `CLAUDE_CLI_PROVIDER_ID = 'claude-cli'`，所有**身分比較**（`captureMaxWindowBytes` L621、`llmCallBudgetReserveMs` L651、adapter 的 `readonly provider`）改用它。
`DEFAULT_CAPTURE_LLM_PROVIDER` 只保留「未設 env 時的預設選擇」單一語意，值仍為 `'claude-cli'`。

---

## 實作步驟

> 順序原則（修 Round 2 #3／#7）：**沙箱與 backlog 營運契約都必須在「正式啟用」之前完成**。

### Phase 0：前置量測（無程式碼變更）

1. **完整 pre-LLM elapsed** 的 p95 與最壞值（見 D5）。
2. 在**沙箱＋白名單 env** 條件下確定可用的 Codex 模型字串（U2）。
3. 保存**真實** claude-cli 超長輸出 fixture（現有測試只有手工 JSON envelope）。
4. 確定 codex 啟動所需的最小 env 白名單（見安全架構）。

### Phase 1：錯誤碼統一（D0）

- **RED**：`LLM_RATE_LIMITED` 停 tick；`LLM_PROMPT_TOO_LONG` 切窗；`LLM_TIMEOUT` 切窗；既有 `CLAUDE_CLI_*` 行為回歸不變；`classifyLlmError` 對全部 13 個碼的映射表測試。
- **RED（補 Round 2 #5）**：`stdout 有雜訊 + stderr 有真錯誤 → 正確分類`；`stderr 有雜訊 + stdout 有真錯誤 → 正確分類`；真實 fixture；相似文字的 false-positive 不誤判；**≤1,024 bytes chunk 走有限次 park、不迴圈**。
- **GREEN**：加 4 個新碼（含 `CODEX_CLI_EXIT_NONZERO`）；新增 `classifyLlmError`；worker 分支改用它；修 `capture-llm.ts:600` 的 `stdout || stderr` 遮蔽（改為同時檢查兩者）。

### Phase 2：沙箱（硬性關卡，見「沙箱驗收」三層）

- 把 bwrap + execpolicy 指令組成**單一可重用函式**。
- 先實測確定：codex 執行所需的最小掛載集合、最小 env 白名單、以及沙箱內可用的模型字串（U2）。
- **L1 確定性探測**（非 LLM）：**完全依「沙箱驗收」章節執行，不在此重述、不得簡化**——含五個欄位的 mountinfo 核對（destination／resolved source／fstype／ro-rw／propagation）與 nonce 交叉驗證；清單為——五個秘密檔、repo 根、`~/.ssh`／`~/.config`／`~/.claude`、`/etc/environment`／`/etc/wsl.conf`、`/proc/1/root/...`、父程序 `/proc/<pid>/environ`——斷言 `ENOENT`／`EACCES`；mountinfo 核對依權威章節的五欄位規則（非僅頂層掛載點）。
  （Round 4 #2 與 Round 6 #7 都指出此處曾退回成簡化版；本節一律以「沙箱驗收」章節為唯一真相。）
- **L1 負向 env 測試**：`PATH`／`HOME`／`TMPDIR` 設成惡意值時掛載面不擴大。
- **L2 對抗式探測**：`codex exec --json`，通過條件＝事件流無任何 tool call 事件且輸出合法 JSON（2026-08-24 修正：對齊「沙箱驗收」權威章節 :209 的零 tool-call event 定義，先前誤寫為「工具呼叫被嘗試且被拒」）。
- **L3 功能正向**：32 KiB transcript 仍抽得出合法 JSON。
- 併驗：逾時、SIGTERM/SIGKILL、DNS、output 檔寫入、暫存檔清理、孤兒回收、model cache 行為；**auth.json 依「臨時 CODEX_HOME」單一規則實作**：測試 host 端 `auth.json` 的 hash 與 inode 呼叫前後不變、臨時目錄確實被清除。
- 這些是**整合測試**（真的 spawn codex），標記為需 codex CLI 的群組，與純單元測試分開跑。

### Phase 3：codex-cli provider

- **RED**（沿用 `adapterOptions`／`stdoutSink`／`request` 慣例）：
  `selects codex-cli when CC_CAPTURE_LLM=codex-cli`／`honors CC_CAPTURE_CODEX_MODEL`／`writes schema to temp file and passes --output-schema`／`reads extraction from -o file`／`cleans up both temp files on success AND failure`／`builds child env from the explicit allowlist only`／`never passes DATABASE_URL, GEMINI_API_KEY, TODOIST_API_TOKEN or alert tokens`／`sets CC_MEMORY_CAPTURE_CHILD=1`／`runs in an isolated empty cwd`／`passes mcp_servers={} and web_search="disabled"`／**`never passes --ignore-rules`**／`inlines the system prompt`／`maps timeout to LLM_TIMEOUT`／`maps quota output to LLM_RATE_LIMITED（真實 fixture ＋ false-positive）`／`maps nonzero exit to CODEX_CLI_EXIT_NONZERO`／`maps model-unavailable to CAPTURE_LLM_DISABLED`／`returns DisabledCaptureLlmAdapter when codex binary is absent`／`exposes a finite worstCaseCallBudgetMs`
- **GREEN**：`CODEX_CLI_CAPTURE_LLM_PROVIDER`、`DEFAULT_CODEX_CLI_TIMEOUT_MS = 90_000`、`CodexCliRunner`、`runCodexCliSubprocess()`（複用 L472-527 骨架＋暫存檔管理＋Phase 2 沙箱函式）、`CodexCliCaptureLlmAdapter`、`defaultFindCodexCli`、工廠分支（**須在 unsupported-provider 判斷之前**）、`runCodexCli?`／`findCodexCli?` 注入點。

### Phase 4：fallback 包裝器

- **RED**：D3 各觸發條件；`does NOT fall back on LLM_MALFORMED_JSON`；`re-throws LLM_PROMPT_TOO_LONG unchanged`；**D4 四條優先序各一測**；`.provider`／`.model`／`.disabled`／`.disabledReason` 契約；`raw response model reflects actual server`；`details carry full causal chain`；`no-op passthrough without fallback`；`fail-fast on unknown fallback provider`；`takeTelemetry returns and resets counters`。
- **RED（整合，補 Round 2 #1）**：**wrapper→worker 連跑六個 tick，兩 provider 皆 rate-limited → retry state 全空、零 dead-letter**。
- **GREEN**：`FallbackCaptureLlmAdapter`；工廠讀 `CC_CAPTURE_LLM_FALLBACK`（未設＝完全維持今日行為）。

### Phase 4.5：supervisor 安全預設（不改值，只加註解）

`scripts/run-auto-capture-supervisor.ts:314` 的 `nextEnv.CC_CAPTURE_LLM ?? 'claude-cli'` **保持不動**——這是「unit 沒指定時退回便宜且已驗證的 provider」的安全預設。provider 由 systemd unit 顯式指定。**加一行註解標明「刻意的安全預設，勿改」**，避免日後有人順手同步成 codex-cli，讓任何漏設 env 的執行路徑直接打貴模型。

### Phase 5：預算、Gemini 逾時、可觀測性

- **RED（預算）**：`fallback adapter reserves codex+claude+2×killGrace+settle`；`plain claude-cli 回歸不變`；`plain codex without fallback reserves codex+killGrace+settle`；`58/59 秒邊界`；`256 KiB window for codex-cli`；**`gemini-flash exposes a finite worstCaseCallBudgetMs after the AbortSignal timeout is added`**；**`gemini-flash aborts at CC_CAPTURE_GEMINI_TIMEOUT_MS`**；**`an adapter without a finite worstCaseCallBudgetMs fails fast at factory time`**（Round 3 #4 ＋ Round 4 #9）。
- **RED（可觀測性）**：summary 追加 `primary-provider=`／`primary-success=`／`fallback-success=`／`fallback-failed=` 後，alert parser 仍正確；**新增 provider 字串解析器**與 `AutoCaptureAssessment` 欄位；`fallback-failed > 0` 的告警語意（決定：**計入不健康、觸發告警**，因為它代表兩個 provider 都失敗）；summary-only 的成功／失敗 parser 測試。
- **GREEN**：`llmCallBudgetReserveMs` 改用 `worstCaseCallBudgetMs`；`CaptureWorkerResult` 併入 telemetry；`run-auto-capture.ts` L60 summary 追加欄位；`auto-capture-alerts.ts` 同步。

### Phase 6：Backlog 營運契約（修 Round 2 #7；**必須在啟用前定案**）

Round 2 正確指出 Phase 7 只寫「要定義」而未定值。本節給出具體契約：

**吞吐計算口徑更正（Round 3 #5）**

先前寫「每 tick 1 個窗口」是**錯的**：`CC_CAPTURE_MAX_SESSIONS_PER_TICK` 限制的是 **session 數**（`captureMaxSessionsPerTick` L627；runbook L239 亦明載），而**一個 session 內會遍歷多個 chunk、多次呼叫 LLM**（L1883／L1973）。所以 canary 的一個 tick 可能跑掉一個大 session 的多個窗口。

**canary 期強制單窗口**：新增 `CC_CAPTURE_MAX_WINDOWS_PER_TICK=1`，使 canary 真的是「一個窗口」，行為可預測、可觀測。

**「窗口」的精確定義與實作點（Round 4 #5 修正）**：

- **一個窗口 = 一個邏輯 chunk 走到它的第一次 `llm.extract`**。
- **malformed 重試（L1959 的 attempt 迴圈第二次呼叫）算同一個窗口**，不另計。
- **計數時機**：在該 chunk 的**第一次 `extract` 呼叫之前**立即遞增。
- **達上限後**：在進入下一個 chunk **之前**結束本 tick（與既有 `yielded` 路徑同構），不是中途砍斷。
- **與切窗的互動**：prompt-too-long 切出的子 chunk（L2018 `chunks.unshift`）若因上限無法在本 tick 處理，**必須靠已持久化的 `state.splitHints` 在下個 tick 可續**——這是既有機制，測試須明確覆蓋。

**測試**：正常成功、malformed 重試不重複計數、prompt-split 子 chunk 跨 tick 可續、單一 session 含多筆記錄時仍只跑一個窗口。

**ETA 改為條件式範圍，不是營運承諾**

- 觸發方式：**無 timer**，只有 SessionStart／Stop quick-kick（`kick-auto-capture.sh:13`、`stop-capture-sentinel.sh:91`）；`flock -n` 使並發 kick 直接放棄（`SuccessExitStatus=75`）。**oneshot 執行中時，後續 start 不會排隊成下一個 tick。**
- 因此「50 effective ticks/day」**無實測依據**，先前的 105 天是情境估算。
- **正確做法**：canary 期從 journal 實測四個量——`windows/tick`、tick 實際耗時、kick 碰撞率、**effective ticks/day**——再回推 ETA。
- **零使用日的影響必須寫明**：使用者若數日不開 session，吞吐為零。沒有最低 kick 頻率保證，就**不能承諾 backlog 完成日期**。

**加速決策點（canary 通過並取得實測數據後才評估，需另行拍板）**
- 選項一：提高 `CC_CAPTURE_MAX_WINDOWS_PER_TICK` / `CC_CAPTURE_MAX_SESSIONS_PER_TICK`
- 選項二：加開 systemd timer 定期 kick（改變「無 timer」的既有設計，須開新決策卡）
- 選項三：放寬預算鏈（600/660/720）
三者皆**不在 canary 期實施**。

**批准 marker 生命週期（Round 3 #5：補上長跑的接線）**

格式與權限依 cutover §1.5：0600、一般檔、非 symlink，內含 scope／批准人／起訖時間。

完整生命週期，四段接續：

1. **canary marker**：短效。Phase 7 第 10 步建立 → 跑單一 tick → 第 12 步**立即移除並 `systemctl --user stop`**。
2. **觀察 marker**：canary 通過後建立**為期一天**的 marker，供 Phase 8 的一整天觀察窗使用。到期或觀察結束即撤除 + stop。
3. **人工批准**：Phase 8 全項通過後，由使用者本人核准長跑。
4. **長跑 marker**：期限**以週為單位**，使用者本人續期；到期不續＝自然停止。同時依上方「加速決策點」決定是否調整參數。

撤除程序一律 = 刪 marker **並** `systemctl --user stop`（刪檔不會中止進行中的 tick）。

**未處理 backlog 的異地備份（Round 3 #6：新增硬性 gate）**

Round 3 正確指出：移除舊 §9 的「backlog 切代」時，一併移除了它原本保護的東西——**尚未進資料庫的 spool 與被引用的 transcript 的可復原性**（runbook L92／L113／L379）。消化要跑數月，期間本機 spool 或 transcript 若損毀，DB dump 救不回未處理的內容。

**新增 gate（不恢復「封存取代處理」，只加備份）**：

**⚠️ Round 4 #6 的關鍵發現：現有工具預設會改動 live spool，不能直接沿用。**

已驗證：`scripts/archive-capture-backlog.ts` 的正常 `--execute` 路徑會呼叫 `bootstrapCaptureEpochs()`（L820），而該函式**會 `renameSync(spoolDir, oldEpochDir)` 把 live spool 改名、再用 symlink 換上新 epoch**（L288-300）。這就是「切代」，**直接牴觸拍板 4**。

工具另有 `--resume-epoch-dir` 路徑（L797）不呼叫 bootstrap，但它預期的是**已穩定的歷史 epoch 目錄**，對「持續被 append 的 live spool」未經驗證，現有測試也只覆蓋歷史 epoch。

**因此本 gate 需要新增一個唯讀模式，不能只是「沿用既有工具」**：

- **新增 `--copy-live` 模式**（唯讀），硬性要求：
  1. **絕不呼叫 `bootstrapCaptureEpochs`**
  2. **必須取得與 worker 相同的全域 `auto-capture-run.lock`（flock）**（Round 5 #7 修正）
     理由：hooks 會直接 append spool（`post-tool-use-capture.sh:121`）、worker 會原子覆寫 capture state（`capture-worker.ts:416`）並分兩次 rename sealed pair（L1501）。不取鎖就可能複製到「舊 state ＋ 新 spool ＋ 半個 sealed pair ＋ 半行 JSON」，卻被當成復原保證。
  3. **兩類檔案採不同一致性規則**（修正上一版「容許 append」與「內容完全未變」的自相矛盾）：
     - **可 append 的 `.jsonl` spool 記錄**（Round 6 #8 修正：byte length 不保證是紀錄邊界）：
       hooks **不取 worker 鎖**，直接 `printf >>`（`post-tool-use-capture.sh:109`）。`O_APPEND` 只保證追加位置原子，**不保證最後一筆已寫完整行**。
       因此核准邊界必須**退回到最後一個完整 newline**，並**逐行驗證 JSON 合法**，再對該前綴計算 hash。否則備份可能忠實地保存了半行。
     - **state／sealed／manifest 檔**：要求**整檔不變**（取鎖期間 worker 不會動它們）。
  4. 複製完成後**才釋放鎖**，再對快照做 archive 與加密上傳（上傳階段不需持鎖）。
  5. **持鎖期間的影響已確認可接受**：worker 的 kick 會因 `flock -n` 直接以 exit 75 放棄，而 unit 已把 75 視為成功（`cc-memory-auto-capture.service:24`）；**hooks 不取該鎖，不會被阻塞**。1.3 GB 複製期間只是暫時沒有 tick，不會累積失敗告警。
  5. **測試必須證明 live spool 的路徑、inode 與已核准前綴內容完全未變**
- 上傳沿用既有 `scripts/upload-capture-backlog.ts` 的加密 R2 管線（該腳本本身不動 spool）。
- 備份完成後，**仍從原 live backlog 繼續處理**——符合拍板 4。

**備份頻率、落點與保留（Round 5 #8 補齊）**：現有工具產生的是**完整封存（full archive）**，不是增量。本計畫採 **weekly full snapshot（每週完整快照）**，全文統一此用語，不再出現「增量」。

- **snapshot 暫存根目錄**：`~/.cache/cc-memory/copy-live-staging/`（與 spool 同一 filesystem，非 tmpfs——1.3 GB 放記憶體不合適）
- **archive root**：`~/.cache/cc-memory/backlog-archives/`
- **容量預檢公式**：開始前檢查可用空間 ≥ `(spool + 被引用 transcript 總量) × 2 + 1 GB` 餘裕；不足即中止並告警（不得跑到一半塞爆磁碟）
- **tmpfs 注意**：既有 `upload-capture-backlog.ts:425` 要求明文 dump 暫存於 tmpfs 並做容量檢查；本流程的**加密上傳階段**沿用該限制，但**快照本身不放 tmpfs**
- **清理**：上傳並驗證成功後立即刪除 `copy-live-staging` 內的暫時複本
- **本機保留**：只保留**最近 2 份**已驗證的本機 archive，更舊的刪除
- **R2 遠端保留（Round 6 #9 補定值）**：保留**最近 8 份 weekly full snapshot（約兩個月）**，以 bucket lifecycle 規則實施；每月 restore drill 時一併確認實際份數符合設定

**還原演練（restore drill）**：每月一次，從 R2 下載、解密、驗 hash、在隔離目錄還原，確認可讀。持續到 backlog 清零。

已知現象：曾有 191 筆 spool 指向已不存在的 transcript；備份時對缺檔項目標記狀態而非中止（既有 archive 工具已如此設計）。

**Spool 容量：sealed 檔移出程序（Round 3 #8：從「待定義」改為具體契約）**

- 現況 120 MB／上限 500 MB（`DEFAULT_SPOOL_MAX_MB`）。`totalSpoolBytes()` **遞迴計算所有一般檔案**（L587），sealed 檔仍計入上限（L609），但只有 `.jsonl` 是處理候選（L674）。
- sealed 產物是**成對的**：sealed spool 檔與 sealed state 檔（L1501）。

**移出程序（具體）**：

1. **可移動條件（eligibility）**：sealed spool 與其對應 sealed state **兩者都存在**、權限正確、且已記錄 hash。任一不符 → 跳過並記錄，不移動。
2. **journaled 狀態機（Round 4 #8 修正：「成對原子移動」在檔案系統層不可能，改為可重建狀態）**
   Round 4 正確指出：sealed pair 是**兩個獨立檔案**（L1501 兩次 rename），無論搬到 staging 或目的地都需要多次 rename，中途當掉就會拆散。真正可行的是**有記錄的狀態機 + 重建**：

   **採用「per-file 意圖日誌 ＋ 單一目錄 rename 提交」（Round 6 #2 修正）**

   Round 6 正確指出：pair 是**兩次獨立 rename** 產生（L1501），把兩檔分別搬進 staging 時，若第一檔搬完就當掉，來源與 staging 各有一檔——上一版四狀態描述不了；而「先寫 journal 再動檔案」又會讓 journal 謊稱兩檔都到位。

   **改為每個檔案各自記 intent／completed**：

   ```
   journal 項目 = {
     retryKey, spoolPath, statePath, spoolHash, stateHash,
     spool:  'intent' | 'completed',
     state:  'intent' | 'completed',
     phase:  'staging' | 'final-renamed' | 'manifest-committed'
   }
   ```

   | phase | 意義 | 復原動作 |
   |---|---|---|
   | `staging` | 正在把兩檔搬進同一個 staging 子目錄 | **逐檔核對**該檔在 source／staging／final 三處的存在與 hash，補齊缺的那一檔；兩檔齊備才進下一 phase |
   | `final-renamed` | staging 子目錄已整個 rename 到 final | 補寫 manifest |
   | `manifest-committed` | manifest 已落盤 | 完成，清除 journal 項 |

   - **復原程序一律以「檔案實際位置＋hash」為準**，journal 只當索引，不當唯一真相——這樣 journal 領先或落後檔案狀態都能收斂。
   - 提交仍是**單一 directory rename**（staging 子目錄 → final），故「兩檔同時可見」是原子的。

   **落盤順序凍結（Round 7 #3 修正：沒有 fsync 就沒有 durable recovery）**

   ```
   寫 intent → fsync(journal)
     → rename → fsync(來源 parent dir) → fsync(目的 parent dir)
       → 寫 completed → fsync(journal)
   ```

   - **啟動時掃三處**：journal、staging、final。journal 遺失時，靠掃描 staging／final 的 orphan（孤立項目）重建工作清單。
   - **manifest 冪等**：以 `retryKey + spoolHash + stateHash` 為唯一鍵，重複追加自動去重（避免「manifest 已寫但 phase 未更新」時重複記錄）。
   - **啟動前的 filesystem 驗證**（`CC_MEMORY_SPOOL_DIR` 可被自訂，固定路徑不足以靜態保證）：以 **resolved path（解析後路徑）與 `st_dev`** 實際驗證 source／staging／final 三者同一 filesystem，且 **final 不在實際 spool tree 之內**；不符即 fail closed。
   - **crash injection 測試**必須涵蓋：每次 journal 更新前後、每次 rename 後、manifest 寫入前後。

   **路徑固定（Round 6 #2 修正：final 必須在 spool 之外）**：

   | 用途 | 路徑 |
   |---|---|
   | staging | `~/.cache/cc-memory/sealed-staging/` |
   | final | `~/.cache/cc-memory/spool-sealed/` |
   | journal | `~/.cache/cc-memory/sealed-move-journal.jsonl` |
   | manifest | `~/.cache/cc-memory/spool-sealed/manifest.jsonl` |

   三者必須與 spool **同一 filesystem**（rename 才原子），但 final **必須在 spool tree 之外**——否則 `totalSpoolBytes()`（L587）遞迴計量不會下降，搬了等於沒搬。

   - 全程在 worker 既有的 `flock` **加上 session 鎖**之下執行，避免與 `maybeRotateCaptureSpool`（L1489）併發。

   **測試**：每一次 rename 之後各插入一次模擬當機，驗證復原都能收斂到 `manifest-committed` 且 pair 不拆散、不重複。

3. **目的地已存在的處理（Round 5 #9 修正：不能無條件跳過）**：先比對 hash——
   - **相同** → 視為先前已成功，**刪除來源**（否則重複檔永遠留在 spool，容量降不下來）
   - **不同** → **fail closed**（停止並告警），不覆蓋、不刪除任何一邊
4. **孤立配對處理**：只有一半存在的 pair 一律不動並告警，避免稽核資料分裂。
5. **容量告警接線（Round 4 #8 修正：要接到既有告警鏈）**
   - `totalSpoolBytes` 達上限 **70% 警告 / 90% 危急**，每 tick 檢查一次（沿用既有 worker 流程，不另開排程）。
   - **必須在 `CaptureWorkerResult` 新增容量欄位**（例如 `spoolBytes`／`spoolCapPct`），寫進 summary 行，並讓 `auto-capture-alerts.ts` 解析與納入健康判定——否則水位資訊到不了 Telegram。
   - 既有的「超過 100% 直接早退」路徑（L1592）也要納入告警語意，不能只印一行 stdout。

**測試**：70% 警告觸發、90% 危急觸發、>100% 早退路徑的告警、journal 每個中間狀態當掉後都能重建、孤立 pair 不被移動且告警、移出後 `totalSpoolBytes` 確實下降。

這是移動**已處理完成**的 sealed 產物，不是封存未處理的 backlog，不牴觸拍板 4。

### Phase 7：安裝 unit 並啟用（修 Round 2 #3，補齊 runbook 完整順序）

嚴格依 `memory-ops-cutover.md` §2（L201／L216／L226），順序不可調換：

1. **前置（全部必須先完成）**：
   - Phase 2 沙箱三層驗收全過
   - Phase 6 營運契約已定案（含未處理 backlog 的異地備份 gate 已執行完畢）
   - project／personal DB 有 canary 前的新鮮 dump 且 restore 驗證通過
   - **告警 hard gate 恢復（Round 3 #7）**：`~/.ccm-memory-alert.env` 為 0600 一般檔、`--test-alert` **實際送達並經人確認**、unit 內 `CC_MEMORY_REQUIRE_ALERTS=1`（runbook L383）。此三項未過不得建立任何 marker。
2. 修改 repo unit：

```diff
-Environment=CC_CAPTURE_LLM=claude-cli
+Environment=CC_CAPTURE_LLM=codex-cli
+Environment=CC_CAPTURE_LLM_FALLBACK=claude-cli
+Environment=CC_CAPTURE_CODEX_MODEL=<Phase 0 確認的模型字串>
+Environment=CC_CAPTURE_CODEX_TIMEOUT_MS=90000
+Environment=CC_CAPTURE_MAX_WINDOWS_PER_TICK=1
 Environment=CC_CAPTURE_CLAUDE_MODEL=haiku
 Environment=CC_CAPTURE_CLAUDE_TIMEOUT_MS=75000
 Environment=CC_CAPTURE_MAX_SESSIONS_PER_TICK=1
```

（`CC_CAPTURE_MAX_WINDOWS_PER_TICK=1` 為 Round 4 #5 補上的 canary 單窗口 gate，先前只寫在 Phase 6 卻沒接進 unit。）

   同時修正 unit 第 15 行已失真的預算註解。
3. `systemd-analyze --user verify`。
4. `install -Dm644` 到 `~/.config/systemd/user/`，**逐位元比對** installed 與 repo（`production-readiness.ts:223` 會檢查）。
5. `systemctl --user daemon-reload`。
6. **檢查 `systemctl --user cat`、`FragmentPath`、`DropInPaths`**（Round 2 #3 漏項）——確認實際載入的就是剛裝的檔、沒有殘留 drop-in 或 mask。
7. **在 marker 仍不存在時**驗證 `ConditionResult=no`、unit 未執行。
8. **清除兩個目標（Round 3 #7：不只 drop-in）**：
   - runtime pause drop-in
   - **指向 `/dev/null` 的 runtime mask（執行期遮罩）**（runbook L226）
9. **再次 `daemon-reload`，並重複第 6、7 步的檢查**：`systemctl --user cat`、`FragmentPath`、`DropInPaths`、兩條 `Condition`、journal。
10. 建立**短效** canary marker（前置的告警 hard gate 已於第 1 步驗畢）。
11. 手動 kick 一次，`journalctl --user -u cc-memory-auto-capture -f` 盯完整一輪。**同時記錄 Round 3 #5 要求的四個實測量**：`windows/tick`、tick 耗時、kick 碰撞、effective ticks/day 的觀察起點。
12. **立即移除 marker 並 `systemctl --user stop`。**

### Phase 8：觀察窗（至少一整天）

1. 專案歸屬正確（抽查新列 `project_id` 對得上 spool 來源）
2. 無重複寫入（`capture:v05:<project>:<session>` 每 session 一列 rollup）
3. `__personal__` 零污染（migration 0012 CHECK 為結構性防線）
4. dead-letter 未暴增、Telegram 告警正常
5. embedding 未變 NULL
6. **summary 的 `primary-provider=codex-cli` 且 `primary-success>=1`**（不靠 DB 反推）
7. spool 容量未接近水位告警

通過後才依 Phase 6 的加速決策點另行拍板。

### §9 替換版本（Round 2 #3 ＋ Round 3 #6/#7 修正）

`memory-ops-cutover.md` §9 的現行六項改為：

1. **可復原性（擴充，修 Round 3 #6）**：
   - canary 前 project／personal DB 新鮮 dump 且 restore 驗證通過（維持原條）
   - **新增：未處理 spool ＋ 其引用 transcript 的唯讀、已驗 hash、異地備份完成**（取代原「backlog 切代」所提供的保障；備份後仍從 live backlog 繼續處理）
   - **新增：定義並執行 weekly full snapshot 與每月 restore drill，持續到 backlog 清零**
2. **秘密安全**：
   - 新 Gemini key 為 0600 一般檔
   - **新增：Phase 2 沙箱三層驗收全過（L1 為作業系統層證據，L2 為事件流證據）**
3. **告警 hard gate（修 Round 3 #7，原 §9 第 5 項前半，獨立成條避免遺漏）**：`~/.ccm-memory-alert.env` 0600 一般檔、`--test-alert` 實際送達並經人確認、unit 內 `CC_MEMORY_REQUIRE_ALERTS=1`。**未過不得建立任何 marker。**
4. **品質**：benchmark **降為 advisory（參考用）**，不再是啟用前置；readiness checker 的相關文案與測試同步更新。
5. **營運契約**：Phase 6 的 marker 四段生命週期、spool sealed 移出程序（含 70%/90% 告警）、以及 **ETA 的量測方法**已定案並記錄。**ETA 本身為條件式範圍，不列為承諾。**
6. **單 tick canary**：依 Phase 7 全部 12 步（含 runtime mask 清除、二次 daemon-reload 與二次 fragment/condition 檢查）。
7. **觀察窗**：建立一天期觀察 marker → Phase 8 全項通過 → 使用者本人核准長跑 marker → 才 pause claude-mem capture（保留其套件與資料，記錄 rollback）。

**原「backlog 切代」條的處置**：不恢復「封存取代處理」（與拍板 4 牴觸），但其**復原保障**由第 1 條的異地備份 gate 承接，**保護範圍不縮水**。

---

## Cascade（連動更新）檢查清單

| 檔案 | 要改什麼 |
|---|---|
| `CLAUDE.md`（repo 根） | env 清單新增 `CC_CAPTURE_LLM_FALLBACK`／`CC_CAPTURE_CODEX_MODEL`／`CC_CAPTURE_CODEX_TIMEOUT_MS`／`CC_CAPTURE_MAX_WINDOWS_PER_TICK`／`CC_CAPTURE_GEMINI_TIMEOUT_MS`；`CC_CAPTURE_LLM` 預設值敘述 |
| `CLAUDE.md` 同段（既有 drift，順修） | 現寫 claude-cli 窗口預設 96 KiB，`capture-worker.ts:37` 實為 **32 KiB** |
| **`docs/auto-capture-v0.5/spec.md:183`（RAM 紅線 3）** | **⚠️ 本次唯一的 spec 反轉點**——該紅線標題就是「observation 抽取用便宜模型」，並載明 2026-07-07 拍板改 claude-cli/haiku 的理由（訂閱已付、不為 Gemini 另付 API 費）。把 codex-cli（實際模型 `gpt-5.6-sol`；早期草稿誤植 `gpt-5.6-luna`，2026-08-23 更正）立為 primary 是**反轉這條紅線，不是 additive 補充**，必須正式改寫並在決策卡記錄 |
| `docs/auto-capture-v0.5/spec.md:166`（LLM 降級表） | primary＝codex-cli、fallback＝claude-cli、gemini-flash 仍可切 |
| `docs/auto-capture-v0.5/spec.md:41`／`:53`（歷史對照表） | 沿用該表「不改原文、加後記」慣例，補 2026-08-23 後記 |
| `docs/auto-capture-v0.5/plan.md:252-258`（Environment Variables 表） | 新增五個變數；`CC_CAPTURE_LLM` 預設改 codex-cli；window bytes 那列加 codex |
| `docs/auto-capture-v0.5/plan.md:33`／`:135`／`:317` | 架構圖 provider 註記、`capture-llm.ts` 說明加 codex-cli + fallback wrapper、交付說明補 provider chain |
| `docs/auto-capture-v0.5/plan.md:272`（遞迴斷路器段） | 補 codex 的 `--ignore-user-config` ＋ `CC_MEMORY_CAPTURE_CHILD` 雙保險 |
| `docs/auto-capture-v0.5/task.md:124`／`:134-140` | M2b 目標句補 codex-cli；驗收項預設改 codex-cli ＋ 新增 fallback 驗收條目 |
| `docs/auto-capture-v0.5/memory-ops-cutover.md` §0／§2／§9 | 狀態表、安裝程序、上方的 §9 替換版本 |
| `scripts/lib/production-readiness.ts` L148 附近＋其測試 | 三硬指標改述為 advisory |
| `.claude/spec-status.md` | 追加 mini-cascade（沿用 2026-07-07「capture LLM 改 claude-cli」那則格式）；**`CascadeTerms` 加 `codex-cli`／`gpt-5.6-luna`／`CC_CAPTURE_LLM_FALLBACK`** |
| `docs/decisions/_draft/` | 新決策卡草稿，見下 |

**不需改**：`SCOPE_TOOLS`／tool-count drift guard（不動 MCP 工具清單）；build/dist（`test:ci` 的 pretest 已含 build）。

### 決策卡（draft-first，agent 不得自行接受）

依 `docs/decisions/README.md`：草稿放 `_draft/`、`status: proposed`、檔名 `DEC-YYYYMMDDTHHMMSSZ-<kebab-slug>.md`、固定六節、至少一個 `verified: true` 來源。

- 標題方向：「capture 主力改用 Codex CLI 並以 haiku 為備援；Go/No-Go 降為 canary；Codex 子程序以 bwrap＋execpolicy 沙箱隔離」
- **卡片必須明確記錄「反轉 spec.md 紅線 3（observation 抽取用便宜模型）」**，寫明反轉理由（跨 Claude／Codex 共用歷史、分散額度）以及 2026-07-07 原拍板理由為何不再適用。這是本次唯一動到既有紅線的地方，不記錄等於掩蓋。
- **不用 `supersedes`**：`DEC-20260716T092938Z` 規範的是 hooks 驅動、systemd oneshot、不靠 Hermes 的骨架，本次沿用。
- `related_to` **須人工明確確認後才寫入**（README L43）。
- 人工接受後才移出 `_draft/`、同 commit 更新 `INDEX.md`、跑 **`npm run decisions:validate`**。

---

## 驗證方式

**單元測試（不需 DB、不 spawn 真程序）**
```bash
npx vitest run tests/services/capture-llm.test.ts
npx vitest run tests/services/capture-worker.test.ts
```

**沙箱整合測試（需 codex CLI，單獨群組）**
```bash
npx vitest run tests/integration/codex-sandbox.test.ts
```
L1 確定性探測必須全部 `ENOENT`／`EACCES`；L2 事件流零 tool-call event 且輸出合法 JSON（2026-08-23 修正，對齊「沙箱驗收」權威定義）；L3 正常抽取。

**全套回歸**
```bash
docker compose -f docker-compose.test.yml up -d
npx tsx scripts/test-db-setup.ts
npm run typecheck && npm run lint && npm run test:ci
npm run decisions:validate
```
基準：最近紀錄 75 檔／1023 tests PASS。

**Phase 0 量測**
`scripts/` 下新增一次性量測腳本，輸出 tick 起點→第一次 `llm.extract` 的 p95 與最壞 elapsed。

**真實端對端**
```bash
systemctl --user start cc-memory-auto-capture.service
journalctl --user -u cc-memory-auto-capture -f
```
確認 summary 含 `primary-provider=codex-cli`、`primary-success>=1`、無 `embeddings-disabled`、無 `UNSUPPORTED_CAPTURE_LLM`。

**資料面抽查**（透過 MCP 工具）
`cc_memory_stats` 最後記憶時間應由 2026-07-15 前進到今日；`cc_memory_timeline` 可下鑽新 observation。

---

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 沙箱擋不住（execpolicy 不涵蓋讀檔、bwrap 掛載有洞） | 秘密外洩 | Phase 2 三層驗收為硬性關卡；L1 用作業系統回傳值判定，不採信模型自述 |
| **Codex auth.json 對子程序可讀** | Codex 自身憑證可能被注入誘導讀取 | **明示接受的殘餘風險**（見安全架構）；根治需限制網路外送，本次不做 |
| 未做 D0：codex 錯誤碼 worker 認不得 | 額度耗盡不停 tick，反而 park + dead-letter | Phase 1 第一順位，含 13 碼映射表測試 |
| 未修 `llmCallBudgetReserveMs` | 呼叫被外層硬逾時砍在中途 | Phase 5 必做，reserve 來源改為 required `worstCaseCallBudgetMs` |
| **pre-LLM elapsed > 58 s** | 每 tick 直接 yield，backlog 永不前進 | Phase 0 量測完整區間（含 `totalSpoolBytes` 遞迴 stat 18k 檔） |
| spool 撞 500 MB 上限 | worker 在處理前整體停止 | Phase 6 的 sealed 移出程序＋70%/90% 水位告警 |
| 3.5 個月 ETA 過於樂觀 | backlog 清不完 | Phase 6 加速決策點；ETA 公式與假設已寫明可重算 |
| codex 暫存檔洩漏 | `/tmp` 累積垃圾 | `finally` 清理，測試含失敗路徑 |
| haiku 收到 256 KiB 窗口 | prompt-too-long | D0 後切窗分支正確接手 |
| **備份誤用切代模式** | live spool 被改名，牴觸「全部處理」拍板 | 必須用新增的 `--copy-live` 唯讀模式；測試斷言 live spool inode 與內容未變 |
| **sealed 移動中途當掉拆散配對** | 稽核資料分裂 | journaled recoverable move（有日誌可復原的搬移）＋單一 directory rename 提交＋啟動時重建，四個狀態各有回復測試 |
| **headless 環境無法重新登入 Codex** | systemd user unit 無 TTY；codex 認證一旦過期 → 連續 `exit-nonzero` → **永久靜默降級 haiku 而無人察覺** | 這正是 `fallback-success`／`fallback-failed` 計數存在的主要理由：單 tick fallback>0 記 warning、連續多 tick 觸發 Telegram 告警 |
| **未處理 backlog 在數月消化期間本機損毀** | DB dump 救不回未進庫的內容 | Phase 6 的異地備份 gate（持 flock 唯讀複製、驗 hash）＋weekly full snapshot＋restore drill |
| **sealed 檔累積撞 500 MB 上限** | worker 在處理前整體停止 | Phase 6 的 journaled recoverable move（單一 directory rename 提交）＋70%/90% 告警 |
| **ETA 被當成承諾** | 期待落空、誤判故障 | ETA 明列為條件式範圍；無最低 kick 頻率保證則不承諾完成日 |
| backlog 含已刪除 transcript | 已知（曾見 191 筆） | 既有 `transcriptMissing` 路徑處理 |
| canary 寫錯專案 | 污染既有語料 | Phase 8 第 1、3 項必檢 |

---

## 明確不做

- 不改 hooks（Claude Code 與 Codex 兩端維持現狀）
- 不縮減 observation 粒度或 embedding 範圍
- 不封存／不切代**未處理**的 backlog
- 不動資料庫結構
- 不移除 `gemini-flash` provider（並於 Phase 5 補上 `AbortSignal` 硬逾時，使其可正常參與 fallback chain，不留「保留卻不能用」的矛盾）
- 不改 `DEFAULT_CAPTURE_LLM_PROVIDER` 的值（另加 `CLAUDE_CLI_PROVIDER_ID` 承擔身分語意）
- 不使用 `--ignore-rules`
- canary 期間不動預算鏈、不加 timer、不提高每 tick session 數
- 不做網路外送限制（Codex auth 殘餘風險為明示接受）
