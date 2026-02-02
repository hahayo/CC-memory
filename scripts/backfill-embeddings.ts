#!/usr/bin/env npx tsx
/**
 * Backfill embeddings for existing memories
 * 為現有記憶批次生成 embedding
 *
 * Usage: npm run backfill:embeddings
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNull, and } from 'drizzle-orm';
import { projectMemories } from '../src/db/schema.js';
import {
  generateEmbedding,
  composeEmbeddingText,
  isEmbeddingEnabled,
} from '../src/utils/embedding.js';

const BATCH_SIZE = 10;
const RATE_LIMIT_DELAY_MS = 1000; // 每批次之間等待 1 秒

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== CC-memory Embedding Backfill ===\n');

  // 檢查 embedding 是否啟用
  if (!isEmbeddingEnabled()) {
    console.error('錯誤: GEMINI_API_KEY 未設定');
    console.error('請在 .env 檔案中設定 GEMINI_API_KEY');
    process.exit(1);
  }

  // 連接資料庫
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('錯誤: DATABASE_URL 未設定');
    process.exit(1);
  }

  const client = postgres(databaseUrl);
  const db = drizzle(client);

  try {
    // 查詢沒有 embedding 的記憶
    const memoriesWithoutEmbedding = await db
      .select()
      .from(projectMemories)
      .where(
        and(
          eq(projectMemories.status, 'active'),
          isNull(projectMemories.embedding)
        )
      );

    const total = memoriesWithoutEmbedding.length;
    console.log(`找到 ${total} 筆記憶需要生成 embedding\n`);

    if (total === 0) {
      console.log('所有記憶已有 embedding，無需處理');
      return;
    }

    let processed = 0;
    let success = 0;
    let failed = 0;

    // 批次處理
    for (let i = 0; i < memoriesWithoutEmbedding.length; i += BATCH_SIZE) {
      const batch = memoriesWithoutEmbedding.slice(i, i + BATCH_SIZE);

      for (const memory of batch) {
        processed++;
        const progress = `[${processed}/${total}]`;

        try {
          // 組合文本
          const text = composeEmbeddingText(
            memory.summary,
            memory.keywords || undefined,
            memory.decisions || undefined
          );

          // 生成 embedding
          const embedding = await generateEmbedding(text);

          if (embedding) {
            // 更新資料庫
            await db
              .update(projectMemories)
              .set({ embedding })
              .where(eq(projectMemories.id, memory.id));

            success++;
            console.log(`${progress} ✓ ${memory.id.slice(0, 8)}... - ${memory.summary.slice(0, 40)}...`);
          } else {
            failed++;
            console.log(`${progress} ✗ ${memory.id.slice(0, 8)}... - 無法生成 embedding`);
          }
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          console.log(`${progress} ✗ ${memory.id.slice(0, 8)}... - ${message}`);
        }
      }

      // 批次之間等待，避免 API 限制
      if (i + BATCH_SIZE < memoriesWithoutEmbedding.length) {
        console.log(`\n等待 ${RATE_LIMIT_DELAY_MS}ms...\n`);
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }

    console.log('\n=== 完成 ===');
    console.log(`處理: ${processed}`);
    console.log(`成功: ${success}`);
    console.log(`失敗: ${failed}`);

  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('執行失敗:', error);
  process.exit(1);
});
