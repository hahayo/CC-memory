// src/utils/local-embedding.ts — 本機 bge-m3 embed-service HTTP client（不 import config.ts）
//
// config.ts 在模組載入時 resolve DATABASE_URL；backfill script 等從檔案讀 DSN 的
// 路徑不能依賴它，所以 local provider 的 HTTP 層集中在這裡，url/timeout 由呼叫端給。

import { LOCAL_EMBEDDING_DIMENSIONS } from './embedding-provider.js';
import { normalizeVector } from './embedding-text.js';

export const LOCAL_EMBEDDING_MAX_BATCH = 64;

// 刻意不記錄 error.message（provider 可能回吐請求內容，見 tests/utils/embedding.test.ts
// 「egress redaction」）。只記錯誤類別與 HTTP status，讓 supervisor journal 能分辨
// 配額（429）／驗證（401/403）／網路（無 status）——2026-09-01 事故因此不可考。
// error.name 是 provider 可改寫的字串，只放行識別字形式，避免被塞入回吐內容。
export function logEmbeddingError(prefix: string, error: unknown): void {
  const rawName = error instanceof Error ? error.name : 'UnknownError';
  const name = /^[A-Za-z0-9_]{1,40}$/.test(rawName) ? rawName : 'Error';
  const status = (error as { status?: unknown } | null)?.status;
  const statusText = typeof status === 'number' ? ` status=${status}` : '';
  console.error(`${prefix} (${name}${statusText})`);
}

export class LocalEmbeddingHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`local embedding HTTP ${status}`);
    this.name = 'LocalEmbeddingHttpError';
    this.status = status;
  }
}

export class LocalEmbeddingInvalidResponse extends Error {
  constructor() {
    super('local embedding invalid response');
    this.name = 'LocalEmbeddingInvalidResponse';
  }
}

/**
 * 批次呼叫本機 bge-m3 embed-service（embed-service/server.py）。
 * texts 應已經過 prepareEmbeddingText redaction；此函式不再處理文字。
 * 不記 text／response body／error message，只記白名單化的錯誤名與 status。
 */
export async function requestLocalEmbeddings(
  texts: string[],
  options: { url: string; timeoutMs: number },
  label = 'local embeddings',
): Promise<number[][] | null> {
  if (texts.length === 0 || texts.length > LOCAL_EMBEDDING_MAX_BATCH) {
    console.error(`Failed to generate ${label} (LocalEmbeddingInvalidResponse)`);
    return null;
  }
  try {
    const url = `${options.url.replace(/\/+$/, '')}/embed`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new LocalEmbeddingHttpError(response.status);
    }
    const payload: unknown = await response.json();
    const parsed = payload as { embeddings?: unknown; model?: unknown } | null;
    const embeddings = parsed?.embeddings;
    if (
      parsed?.model !== 'BAAI/bge-m3' ||
      !Array.isArray(embeddings) ||
      embeddings.length !== texts.length ||
      !embeddings.every(
        (embedding: unknown) =>
          Array.isArray(embedding) &&
          embedding.length === LOCAL_EMBEDDING_DIMENSIONS &&
          embedding.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
      )
    ) {
      throw new LocalEmbeddingInvalidResponse();
    }
    for (const embedding of embeddings as number[][]) {
      const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      if (norm === 0 || !Number.isFinite(norm)) {
        throw new LocalEmbeddingInvalidResponse();
      }
    }
    return (embeddings as number[][]).map(normalizeVector);
  } catch (error) {
    logEmbeddingError(`Failed to generate ${label}`, error);
    return null;
  }
}
