// src/utils/embedding-provider.ts — embedding provider 解析（純函式，不 import config.ts）
//
// config.ts 在模組載入時 resolve DATABASE_URL，supervisor 等只需要 provider 決策的
// 路徑不能依賴它，所以這裡只吃 env record。

export type EmbeddingProvider = 'gemini' | 'local';

// bge-m3 dense embedding 固定 1024 維（與 sql/migrations/0014 的 vector(1024) 一致）
export const LOCAL_EMBEDDING_DIMENSIONS = 1024;

export function resolveEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const raw = env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'gemini') return 'gemini';
  if (raw === 'local') return 'local';
  throw new Error('Invalid EMBEDDING_PROVIDER (expected gemini|local)');
}

/**
 * 這個 env 下 embedding 是否「設定上就可用」：local → 服務在本機，不需要 API key；
 * gemini → 需要 GEMINI_API_KEY。
 */
export function isEmbeddingConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (resolveEmbeddingProvider(env) === 'local') return true;
  return Boolean(env.GEMINI_API_KEY?.trim());
}

/** EMBEDDING_LOCAL_TIMEOUT_MS：只收純十進位 1..600000，其餘一律退回 30000。 */
export function parseEmbeddingLocalTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return 30_000;
  const value = Number.parseInt(raw, 10);
  return value >= 1 && value <= 600_000 ? value : 30_000;
}

export function embeddingColumnName(
  provider: EmbeddingProvider,
): 'embedding' | 'embedding_bge_m3' {
  return provider === 'local' ? 'embedding_bge_m3' : 'embedding';
}
