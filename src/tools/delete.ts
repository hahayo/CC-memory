// src/tools/delete.ts
import { projectMemories } from '../db/schema.js';
import { eq, SQL } from 'drizzle-orm';

type DbClient = {
  update: (table: typeof projectMemories) => {
    set: (data: { status: string }) => {
      where: (condition: SQL) => Promise<unknown>;
    };
  };
};

export async function deleteMemory(
  database: DbClient,
  id: string
): Promise<boolean> {
  await database
    .update(projectMemories)
    .set({ status: 'archived' })
    .where(eq(projectMemories.id, id));

  return true;
}
