// M4 Gate 一次性驗證腳本：estimateDiscoveryTokens 對 20 筆中英混合樣本的估算誤差。
// 參考 tokenizer = Gemini countTokens（gemini-2.5-flash）。方法學註記：
// - 注入目標是 Claude session，理想參考是 Anthropic tokenizer；離線不可得，
//   以 Gemini tokenizer 作 proxy（兩者對中英混合文本的計數量級相近，±20% gate 足以偵測公式失準）。
// - estimateDiscoveryTokens 含固定 +12 metadata buffer（規格 L253）；文字項比較時扣除。
// 執行：GEMINI_API_KEY=... npx tsx scripts/m4-gate-estimator-accuracy.ts <輸出路徑.json>
import { writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { estimateDiscoveryTokens } from '../src/services/capture-llm.js';

const MODEL = 'gemini-2.5-flash';
const BUFFER = 12;

// 20 筆中英混合樣本：仿真實 observation index 內容（標題/摘要/檔案路徑/識別字），長短混配
const SAMPLES: string[] = [
  '修正 capture worker 的空窗口 skip 邏輯：stop sentinel offset 等於事件 offset 時不呼叫 LLM，直接 HWM commit。',
  'Implemented cc_memory_refine_delete MCP tool with soft-delete semantics: status=archived plus audit metadata under metadata.refine.deleted.',
  '決策：token budget 預設 1200，超過先截 observation ids，再截 summary text，最後從最舊的 row 開始丟。',
  'The searchMemoryIndexes service now returns a SearchResultEnvelope with mixed corpus weights: manual 1.00, rollup 0.85, decision 0.80, auto 0.65.',
  '在 src/services/observations.ts 新增 timeline 與 getObservations，anchorId 需通過 UUID 驗證，否則回 INVALID_ARGUMENT。',
  'Bug: drizzle sql template 對 JS array 綁成 record，PG 報 cannot cast type record to text[]，改用 pgTextArrayLiteral helper 轉 PG array literal。',
  '全機啟用後踩出 1.7MB 巨窗口爆 CLI 的問題，加 CC_CAPTURE_MAX_WINDOW_BYTES=262144 依 UTF-8 字元邊界分塊。',
  'SessionStart hook outputs protocol JSON: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}} when the flag is on.',
  '測試基準更新：684 tests / 50 檔（592 → M1 +7 → M2a +9 → M2b +9 → claude-cli +8 → M3 +28 → edge 修復 +11 → M5 +20）。',
  'prompt injection 防禦：--append-system-prompt 指令/資料分離 + <transcript> delimiter + instruction sandwich + MALFORMED 重試一次。',
  '使用者拍板不為 Gemini 另付 API 費，CC_CAPTURE_LLM 預設改 claude-cli，spawn claude -p --model haiku 吃訂閱額度零邊際成本。',
  'Cross-project deletion attempts must not leak existence: both foreign and missing ids raise NotFoundError with an identical constant message.',
  '注意 GEMINI_API_KEY 雙用途（capture LLM + embedding），別 unset，unset 會讓 embedding 變 NULL。',
  'hermes cron cc-memory-auto-capture registered with job id 3fb444d5e112, schedule */5, no-agent mode, deliver via telegram.',
  '併行紀律：兩個 session 共用 test DB（port 5433），測試 seed 必須用自己的 prefix 並自清，錯開全套跑的時間。',
  'refineDelete performs a single atomic UPDATE guarded by status=active, merging audit metadata via COALESCE(metadata, empty jsonb) || patch.',
  '檔名註：harness Write denylist 的 *token* pattern 誤擋 spec 檔名，先以他名寫入再 git mv 歸位。',
  'M3 手測 drill-down 腳本模式：seed manual+rollup+observations 後走 handleToolCall，policy 要帶 searchFeedback: true。',
  'Recent Activity builder 只查 rollups 不查全文 observations，discovery_tokens 一律讀 metadata.capture.discovery_tokens 不現算。',
  'DSN 事故教訓：~/.ccm-prod-url 是舊 Zeabur 退役庫，正確 project DB 是 ~/.ccm-project-url（Coolify，tunnel 127.0.0.1:15432）。',
];

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('usage: tsx m4-gate-estimator-accuracy.ts <out.json>');
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const ai = new GoogleGenAI({ apiKey });

  const rows: Array<{
    sample: string;
    reference: number;
    estimateText: number;
    errorPct: number;
    within20: boolean;
  }> = [];

  for (const sample of SAMPLES) {
    const res = await ai.models.countTokens({ model: MODEL, contents: sample });
    const reference = res.totalTokens ?? 0;
    const estimateText = estimateDiscoveryTokens(sample) - BUFFER;
    const errorPct = reference > 0 ? ((estimateText - reference) / reference) * 100 : NaN;
    rows.push({
      sample: sample.slice(0, 60),
      reference,
      estimateText,
      errorPct: Math.round(errorPct * 10) / 10,
      within20: Math.abs(errorPct) <= 20,
    });
  }

  const passCount = rows.filter((r) => r.within20).length;
  const meanAbsErr =
    Math.round(
      (rows.reduce((acc, r) => acc + Math.abs(r.errorPct), 0) / rows.length) * 10
    ) / 10;

  const report = {
    gate: 'M4: 20 筆中英混合樣本 token 估算誤差 ±20%',
    method: `reference=Gemini countTokens(${MODEL}) proxy；estimate=estimateDiscoveryTokens(text)-${BUFFER}（扣 metadata buffer 比文字項）`,
    generatedBy: 'm4-gate-estimator-accuracy.ts (one-shot supervisor run)',
    samples: rows.length,
    within20Count: passCount,
    meanAbsErrorPct: meanAbsErr,
    verdict: passCount >= 20 ? 'PASS' : passCount >= 16 ? 'PASS_WITH_OUTLIERS' : 'FAIL',
    rows,
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `within20=${passCount}/${rows.length} meanAbsErr=${meanAbsErr}% verdict=${report.verdict}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
