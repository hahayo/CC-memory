// src/tools/get.ts
import { projectMemories, Memory } from '../db/schema.js';
import { eq, SQL } from 'drizzle-orm';

type DbClient = {
  select: () => {
    from: (table: typeof projectMemories) => {
      where: (condition: SQL) => {
        limit: (n: number) => Promise<Memory[]>;
      };
    };
  };
};

export async function getMemory(
  database: DbClient,
  id: string
): Promise<Memory | null> {
  const [result] = await database
    .select()
    .from(projectMemories)
    .where(eq(projectMemories.id, id))
    .limit(1);

  return result || null;
}
