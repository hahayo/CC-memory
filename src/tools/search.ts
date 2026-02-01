// src/tools/search.ts
import { projectMemories, Memory } from '../db/schema.js';
import { eq, and, desc, SQL } from 'drizzle-orm';

export interface SearchInput {
  query: string;
  projectId?: string;
  type?: 'session' | 'decision';
  limit?: number;
}

type DbClient = {
  select: () => {
    from: (table: typeof projectMemories) => {
      where: (condition: SQL | undefined) => {
        orderBy: (order: SQL) => {
          limit: (n: number) => Promise<Memory[]>;
        };
      };
    };
  };
};

export async function searchMemories(
  database: DbClient,
  input: SearchInput
): Promise<Memory[]> {
  const { query, projectId, type, limit = 10 } = input;

  // 將 query 分割成關鍵字
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  // 建立 where 條件
  const conditions: SQL[] = [eq(projectMemories.status, 'active')];

  if (projectId) {
    conditions.push(eq(projectMemories.projectId, projectId));
  }

  if (type) {
    conditions.push(eq(projectMemories.type, type));
  }

  const whereClause = conditions.length > 1
    ? and(...conditions)
    : conditions[0];

  const results = await database
    .select()
    .from(projectMemories)
    .where(whereClause)
    .orderBy(desc(projectMemories.createdAt))
    .limit(limit);

  // 過濾包含關鍵字的結果
  if (keywords.length > 0) {
    return results.filter(memory => {
      const text = `${memory.summary} ${memory.keywords?.join(' ') || ''}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
  }

  return results;
}
