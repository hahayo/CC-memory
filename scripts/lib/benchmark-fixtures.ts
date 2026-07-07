// scripts/lib/benchmark-fixtures.ts
//
// v0.5 M6 6a RED-phase shell only. M6 6b will fill benchmark fixture parsing.

export interface BenchmarkFixture { query: string; expectedIntent: string; projectId: string; notes: string }

export function parseBenchmarkFixtures(markdown: string): BenchmarkFixture[] {
  throw new Error('parseBenchmarkFixtures not implemented (M6 6b)');
}
