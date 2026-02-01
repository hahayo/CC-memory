// src/tools/stats.ts
import { projectMemories } from '../db/schema.js';
import { eq, and, count, min, max, SQL } from 'drizzle-orm';

export interface ProjectStats {
  totalMemories: number;
  sessionCount: number;
  decisionCount: number;
  firstMemory: Date | null;
  lastMemory: Date | null;
}

type CountResult = { count: number };
type MinMaxResult = {
  total: number;
  first: Date | null;
  last: Date | null;
};

type DbClient = {
  select: <T>(columns: T) => {
    from: (table: typeof projectMemories) => {
      where: (condition: SQL | undefined) => Promise<T extends { count: unknown } ? CountResult[] : MinMaxResult[]>;
    };
  };
};

export async function getProjectStats(
  database: DbClient,
  projectId: string
): Promise<ProjectStats> {
  const baseCondition = and(
    eq(projectMemories.projectId, projectId),
    eq(projectMemories.status, 'active')
  );

  const [stats] = await database
    .select({
      total: count(),
      first: min(projectMemories.createdAt),
      last: max(projectMemories.createdAt),
    })
    .from(projectMemories)
    .where(baseCondition) as unknown as MinMaxResult[];

  const [sessionStats] = await database
    .select({ count: count() })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.type, 'session'),
      eq(projectMemories.status, 'active')
    )) as unknown as CountResult[];

  const [decisionStats] = await database
    .select({ count: count() })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.type, 'decision'),
      eq(projectMemories.status, 'active')
    )) as unknown as CountResult[];

  return {
    totalMemories: stats?.total || 0,
    sessionCount: sessionStats?.count || 0,
    decisionCount: decisionStats?.count || 0,
    firstMemory: stats?.first || null,
    lastMemory: stats?.last || null,
  };
}
