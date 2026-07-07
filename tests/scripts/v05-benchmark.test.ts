// tests/scripts/v05-benchmark.test.ts
//
// v0.5 M6 6a — benchmark fixture parser RED tests. Pure file parsing, no DB.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBenchmarkFixtures } from '../../scripts/lib/benchmark-fixtures.js';

const REPO_ROOT = process.cwd();
const FIXTURE_PATH = join(
  REPO_ROOT,
  'docs',
  'auto-capture-v0.5',
  'benchmark-fixtures.md'
);
const QUERIES = [
  'drizzle array 綁定 record 錯誤',
  'refine_delete 存在性洩漏',
  'estimator discovery tokens 校準',
  'ccm-project-url DSN 事故',
  'capture prompt injection 防護',
];
const VALIDATION_ERROR = /^Invalid benchmark fixtures:/;

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

describe('parseBenchmarkFixtures', () => {
  it('parses the real fixture file into five complete rows', () => {
    const fixtures = parseBenchmarkFixtures(readFixture());

    expect(fixtures).toHaveLength(5);
    for (const fixture of fixtures) {
      expect(typeof fixture.query).toBe('string');
      expect(fixture.query.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.expectedIntent).toBe('string');
      expect(fixture.expectedIntent.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.projectId).toBe('string');
      expect(fixture.projectId.trim().length).toBeGreaterThan(0);
      expect(typeof fixture.notes).toBe('string');
      expect(fixture.notes.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the project id and query order from the fixture table', () => {
    const fixtures = parseBenchmarkFixtures(readFixture());

    expect(fixtures.map((fixture) => fixture.projectId)).toEqual([
      'CC-memory',
      'CC-memory',
      'CC-memory',
      'CC-memory',
      'CC-memory',
    ]);
    expect(fixtures.map((fixture) => fixture.query)).toEqual(QUERIES);
  });

  it('rejects a table missing the notes column', () => {
    const markdown = [
      '| query | expected_intent | project_id |',
      '|---|---|---|',
      '| q | intent | CC-memory |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects an empty notes cell', () => {
    const markdown = [
      '| query | expected_intent | project_id | notes |',
      '|---|---|---|---|',
      '| q | intent | CC-memory |   |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects a table with unexpected header names', () => {
    const markdown = [
      '| query | intent | project_id | notes |',
      '|---|---|---|---|',
      '| q | intent | CC-memory | note |',
    ].join('\n');

    expect(() => parseBenchmarkFixtures(markdown)).toThrow(VALIDATION_ERROR);
  });

  it('rejects markdown without a table', () => {
    expect(() => parseBenchmarkFixtures('No benchmark fixture table here.')).toThrow(
      VALIDATION_ERROR
    );
  });
});
