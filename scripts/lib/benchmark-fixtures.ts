// scripts/lib/benchmark-fixtures.ts
//
// v0.5 M6 benchmark fixture parsing.

export interface BenchmarkFixture {
  query: string;
  expectedIntent: string;
  projectId: string;
  notes: string;
}

const EXPECTED_HEADER = ['query', 'expected_intent', 'project_id', 'notes'] as const;

function invalid(message: string): never {
  throw new Error(`Invalid benchmark fixtures: ${message}`);
}

function splitRowCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    invalid(`table row must start and end with "|": ${line}`);
  }
  const body = trimmed.slice(1, -1);
  const cells: string[] = [];
  let current = '';
  let escaping = false;

  for (const char of body) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRowCells(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
  );
}

export function parseBenchmarkFixtures(markdown: string): BenchmarkFixture[] {
  const lines = markdown.split(/\r?\n/);
  const tableStart = lines.findIndex((line) => line.trim().startsWith('|'));
  if (tableStart === -1) invalid('no markdown table found');
  if (tableStart + 1 >= lines.length) invalid('table separator row missing');

  const header = splitRowCells(lines[tableStart]);
  if (header.length !== EXPECTED_HEADER.length) {
    invalid(`expected 4 header columns, got ${header.length}`);
  }
  const expected = [...EXPECTED_HEADER];
  if (header.some((cell, index) => cell !== expected[index])) {
    invalid(`header must be exactly: ${expected.join(' | ')}`);
  }
  if (!isSeparatorRow(lines[tableStart + 1])) {
    invalid('table separator row must contain markdown dashes for each column');
  }

  const fixtures: BenchmarkFixture[] = [];
  for (let index = tableStart + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRowCells(line);
    if (cells.length !== EXPECTED_HEADER.length) {
      invalid(`row ${fixtures.length + 1} expected 4 columns, got ${cells.length}`);
    }
    const emptyIndex = cells.findIndex((cell) => cell.trim().length === 0);
    if (emptyIndex !== -1) {
      invalid(`row ${fixtures.length + 1} has empty ${expected[emptyIndex]} cell`);
    }
    fixtures.push({
      query: cells[0],
      expectedIntent: cells[1],
      projectId: cells[2],
      notes: cells[3],
    });
  }

  if (fixtures.length === 0) invalid('table has no fixture rows');
  return fixtures;
}
