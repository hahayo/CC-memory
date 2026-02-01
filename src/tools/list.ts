// src/tools/list.ts
import { projectMemories, Memory } from '../db/schema.js';
import { eq, and, desc, SQL } from 'drizzle-orm';

export interface ListInput {
  projectId: string;
  type?: 'session' | 'decision';
  limit?: number;
  offset?: number;
}

type DbClient = {
  select: () => {
    from: (table: typeof projectMemories) => {
      where: (condition: SQL | undefined) => {
        orderBy: (order: SQL) => {
          limit: (n: number) => {
            offset: (n: number) => Promise<Memory[]>;
          };
        };
      };
    };
  };
};

export async function listMemories(
  database: DbClient,
  input: ListInput
): Promise<Memory[]> {
  const { projectId, type, limit = 20, offset = 0 } = input;

  const conditions: SQL[] = [
    eq(projectMemories.projectId, projectId),
    eq(projectMemories.status, 'active'),
  ];

  if (type) {
    conditions.push(eq(projectMemories.type, type));
  }

  const whereClause = and(...conditions);

  return database
    .select()
    .from(projectMemories)
    .where(whereClause)
    .orderBy(desc(projectMemories.createdAt))
    .limit(limit)
    .offset(offset);
}
