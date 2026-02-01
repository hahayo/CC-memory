// src/tools/save.ts
import { projectMemories, NewMemory } from '../db/schema.js';

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
  const newMemory: NewMemory = {
    projectId: input.projectId,
    projectPath: input.projectPath,
    type: input.type,
    summary: input.summary,
    keywords: input.keywords || [],
    decisions: input.decisions || [],
    nextSteps: input.nextSteps || [],
    metadata: input.metadata || {},
  };

  const [result] = await database
    .insert(projectMemories)
    .values(newMemory)
    .returning({ id: projectMemories.id });

  return { id: result.id };
}
