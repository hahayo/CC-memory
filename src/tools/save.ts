// src/tools/save.ts
import { projectMemories, NewMemory } from '../db/schema.js';
import {
  generateEmbedding,
  composeEmbeddingText,
  isEmbeddingEnabled,
} from '../utils/embedding.js';

export interface SaveMemoryInput {
  projectId: string;
  projectPath?: string;
  type: 'session' | 'decision';
  summary: string;
  keywords?: string[];
  decisions?: string[];
  nextSteps?: string[];
  metadata?: Record<string, unknown>;
}

export interface SaveMemoryResult {
  id: string;
  hasEmbedding: boolean;
}

type DbClient = {
  insert: (table: typeof projectMemories) => {
    values: (data: NewMemory) => {
      returning: (columns: { id: typeof projectMemories.id }) => Promise<{ id: string }[]>;
    };
  };
};

export async function saveMemory(
  database: DbClient,
  input: SaveMemoryInput
): Promise<SaveMemoryResult> {
  // 嘗試生成 embedding（如果啟用）
  let embedding: number[] | null = null;

  if (isEmbeddingEnabled()) {
    const text = composeEmbeddingText(
      input.summary,
      input.keywords,
      input.decisions
    );

    embedding = await generateEmbedding(text);
    // 如果失敗，不阻擋儲存，只是不儲存 embedding
  }

  const newMemory: NewMemory = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    type: input.type,
    summary: input.summary,
    keywords: input.keywords || [],
    decisions: input.decisions || [],
    nextSteps: input.nextSteps || [],
    embedding: embedding,
    metadata: input.metadata || {},
  };

  const [result] = await database
    .insert(projectMemories)
    .values(newMemory)
    .returning({ id: projectMemories.id });

  return {
    id: result.id,
    hasEmbedding: embedding !== null,
  };
}
