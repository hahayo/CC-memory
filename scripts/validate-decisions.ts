import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ValidationIssue {
  code: string;
  file: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  cards: number;
  issues: ValidationIssue[];
}

const RELATION_FIELDS = [
  'supersedes',
  'depends_on',
  'conflicts_with',
  'related_to',
] as const;

type RelationField = typeof RELATION_FIELDS[number];

const REQUIRED_SCALAR_FIELDS = ['id', 'title', 'status', 'decided_at', 'scope'] as const;
const SOURCE_FIELDS = [
  'id',
  'type',
  'client',
  'ref',
  'captured_at',
  'excerpt_sha256',
  'verified',
] as const;
const SOURCE_TYPES = new Set(['session_excerpt', 'repo_file', 'git_commit', 'manual']);
const FORMAL_STATUSES = new Set(['active', 'superseded', 'archived']);
const FORBIDDEN_SIMILARITY_FIELDS = new Set([
  'similarity',
  'semantic_similarity',
  'similar_to',
]);
const REQUIRED_SECTIONS = [
  '決策背景與決策前狀態',
  '替代方案及採否理由',
  '最終決策與理由',
  '預期後果及決策後狀態',
  '原文溯源',
  '後續結果與沿革',
];
const DECISION_ID_PATTERN = /^DEC-\d{8}T\d{6}Z-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface ParsedCard {
  file: string;
  absoluteFile: string;
  draft: boolean;
  fields: Record<string, string>;
  relations: Record<RelationField, string[]>;
  sources: Array<Record<string, string>>;
  body: string;
  issues: ValidationIssue[];
}

function makeIssue(code: string, file: string, message: string): ValidationIssue {
  return { code, file, message };
}

function repoRelative(repoRoot: string, file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
}

function isRelationField(key: string): key is RelationField {
  return (RELATION_FIELDS as readonly string[]).includes(key);
}

function unquoteScalar(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (value === '') return undefined;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }

  if (
    value.startsWith('[')
    || value.startsWith('{')
    || value.endsWith(']')
    || value.endsWith('}')
    || value === '|'
    || value === '>'
  ) {
    return undefined;
  }
  return value;
}

function parseInlineArray(
  rawValue: string,
  file: string,
  field: string,
  issues: ValidationIssue[],
): string[] {
  const value = rawValue.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) {
    issues.push(makeIssue(
      'FRONTMATTER_FORMAT',
      file,
      `${field} must be an inline array`,
    ));
    return [];
  }

  const content = value.slice(1, -1).trim();
  if (content === '') return [];

  const values: string[] = [];
  for (const item of content.split(',')) {
    const scalar = unquoteScalar(item);
    if (scalar === undefined) {
      issues.push(makeIssue(
        'FRONTMATTER_FORMAT',
        file,
        `${field} contains an invalid array item`,
      ));
      continue;
    }
    values.push(scalar);
  }
  return values;
}

function assignSourceField(
  source: Record<string, string>,
  key: string,
  rawValue: string,
  file: string,
  issues: ValidationIssue[],
): void {
  if (!(SOURCE_FIELDS as readonly string[]).includes(key)) {
    issues.push(makeIssue(
      'UNKNOWN_SOURCE_FIELD',
      file,
      `sources contains unsupported field ${key}`,
    ));
    return;
  }
  if (Object.hasOwn(source, key)) {
    issues.push(makeIssue('DUPLICATE_FIELD', file, `sources repeats field ${key}`));
    return;
  }

  const value = unquoteScalar(rawValue);
  if (value === undefined) {
    issues.push(makeIssue('FRONTMATTER_FORMAT', file, `sources.${key} must be a scalar`));
    return;
  }
  source[key] = value;
}

function parseCard(content: string, absoluteFile: string, file: string, draft: boolean): ParsedCard {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const issues: ValidationIssue[] = [];
  const relations: Record<RelationField, string[]> = {
    supersedes: [],
    depends_on: [],
    conflicts_with: [],
    related_to: [],
  };
  const fields: Record<string, string> = {};
  const sources: Array<Record<string, string>> = [];

  if (lines[0] !== '---') {
    issues.push(makeIssue('FRONTMATTER_FORMAT', file, 'card must start with ---'));
    return { file, absoluteFile, draft, fields, relations, sources, body: normalized, issues };
  }

  const closingLine = lines.indexOf('---', 1);
  if (closingLine === -1) {
    issues.push(makeIssue('FRONTMATTER_FORMAT', file, 'card is missing closing ---'));
    return { file, absoluteFile, draft, fields, relations, sources, body: '', issues };
  }

  const seenRelations = new Set<RelationField>();
  let sawSources = false;
  let insideSources = false;
  let currentSource: Record<string, string> | undefined;

  for (const line of lines.slice(1, closingLine)) {
    if (line.trim() === '') continue;

    if (!line.startsWith(' ')) {
      insideSources = false;
      currentSource = undefined;
      const match = /^([a-z0-9_]+):\s*(.*)$/.exec(line);
      if (match === null) {
        issues.push(makeIssue('FRONTMATTER_FORMAT', file, `invalid top-level line: ${line}`));
        continue;
      }

      const [, key, rawValue] = match;
      if (FORBIDDEN_SIMILARITY_FIELDS.has(key)) {
        issues.push(makeIssue(
          'FORBIDDEN_SIMILARITY_FIELD',
          file,
          `${key} must not be persisted in decision frontmatter`,
        ));
        continue;
      }

      if (key === 'sources') {
        sawSources = true;
        insideSources = true;
        if (rawValue.trim() !== '') {
          issues.push(makeIssue(
            'FRONTMATTER_FORMAT',
            file,
            'sources must contain indented scalar maps',
          ));
        }
        continue;
      }

      if (isRelationField(key)) {
        if (seenRelations.has(key)) {
          issues.push(makeIssue('DUPLICATE_FIELD', file, `frontmatter repeats ${key}`));
          continue;
        }
        seenRelations.add(key);
        relations[key] = parseInlineArray(rawValue, file, key, issues);
        continue;
      }

      if (!(REQUIRED_SCALAR_FIELDS as readonly string[]).includes(key)) {
        issues.push(makeIssue(
          'UNKNOWN_FRONTMATTER_FIELD',
          file,
          `unsupported top-level field ${key}`,
        ));
        continue;
      }
      if (Object.hasOwn(fields, key)) {
        issues.push(makeIssue('DUPLICATE_FIELD', file, `frontmatter repeats ${key}`));
        continue;
      }

      const value = unquoteScalar(rawValue);
      if (value === undefined) {
        issues.push(makeIssue('FRONTMATTER_FORMAT', file, `${key} must be a scalar`));
        continue;
      }
      fields[key] = value;
      continue;
    }

    if (!insideSources) {
      issues.push(makeIssue('FRONTMATTER_FORMAT', file, `unexpected indentation: ${line}`));
      continue;
    }

    const sourceStart = /^ {2}- ([a-z0-9_]+):\s*(.*)$/.exec(line);
    if (sourceStart !== null) {
      currentSource = {};
      sources.push(currentSource);
      assignSourceField(currentSource, sourceStart[1], sourceStart[2], file, issues);
      continue;
    }

    const sourceField = /^ {4}([a-z0-9_]+):\s*(.*)$/.exec(line);
    if (sourceField !== null && currentSource !== undefined) {
      assignSourceField(currentSource, sourceField[1], sourceField[2], file, issues);
      continue;
    }

    issues.push(makeIssue('FRONTMATTER_FORMAT', file, `invalid sources line: ${line}`));
  }

  for (const field of REQUIRED_SCALAR_FIELDS) {
    if (!Object.hasOwn(fields, field)) {
      issues.push(makeIssue('REQUIRED_FIELD_MISSING', file, `missing required field ${field}`));
    }
  }
  for (const field of RELATION_FIELDS) {
    if (!seenRelations.has(field)) {
      issues.push(makeIssue('REQUIRED_FIELD_MISSING', file, `missing required field ${field}`));
    }
  }
  if (!sawSources) {
    issues.push(makeIssue('REQUIRED_FIELD_MISSING', file, 'missing required field sources'));
  }

  return {
    file,
    absoluteFile,
    draft,
    fields,
    relations,
    sources,
    body: lines.slice(closingLine + 1).join('\n'),
    issues,
  };
}

function sourceExcerpts(body: string): Map<string, string> {
  const lines = body.split('\n');
  const excerpts = new Map<string, string>();
  const sourceSection = lines.findIndex((line) => line.trim() === '## 原文溯源');
  if (sourceSection === -1) return excerpts;

  let index = sourceSection + 1;
  while (index < lines.length && !/^##\s+/.test(lines[index])) {
    const heading = /^###\s+(.+?)\s*$/.exec(lines[index]);
    if (heading === null) {
      index += 1;
      continue;
    }

    const sourceId = heading[1];
    index += 1;
    while (index < lines.length && lines[index].trim() === '') index += 1;

    const excerptLines: string[] = [];
    while (index < lines.length && lines[index].startsWith('> ')) {
      excerptLines.push(lines[index].slice(2));
      index += 1;
    }
    if (excerptLines.length > 0) excerpts.set(sourceId, excerptLines.join('\n'));
  }
  return excerpts;
}

function validateCard(card: ParsedCard): ValidationIssue[] {
  const issues = [...card.issues];
  const id = card.fields.id;
  const status = card.fields.status;

  if (id !== undefined) {
    if (!DECISION_ID_PATTERN.test(id)) {
      issues.push(makeIssue('INVALID_ID', card.file, `invalid decision ID ${id}`));
    }
    if (basename(card.absoluteFile, '.md') !== id) {
      issues.push(makeIssue(
        'ID_FILENAME_MISMATCH',
        card.file,
        `frontmatter ID ${id} does not match filename`,
      ));
    }
  }

  if (status !== undefined) {
    const statusMatchesPath = card.draft
      ? status === 'proposed'
      : FORMAL_STATUSES.has(status);
    if (!statusMatchesPath) {
      issues.push(makeIssue(
        'STATUS_PATH_MISMATCH',
        card.file,
        `${status} is not allowed at this card path`,
      ));
    }
  }

  const bodyLines = new Set(card.body.split('\n').map((line) => line.trim()));
  for (const section of REQUIRED_SECTIONS) {
    if (!bodyLines.has(`## ${section}`)) {
      issues.push(makeIssue('REQUIRED_SECTION_MISSING', card.file, `missing section ${section}`));
    }
  }

  if (!card.draft && !card.sources.some((source) => source.verified === 'true')) {
    issues.push(makeIssue(
      'VERIFIED_SOURCE_REQUIRED',
      card.file,
      'formal decision card requires at least one verified source',
    ));
  }

  const excerpts = sourceExcerpts(card.body);
  const sourceIds = new Set<string>();
  for (const source of card.sources) {
    for (const field of SOURCE_FIELDS) {
      if (!Object.hasOwn(source, field)) {
        issues.push(makeIssue(
          'SOURCE_FIELD_MISSING',
          card.file,
          `source is missing required field ${field}`,
        ));
      }
    }

    const sourceId = source.id;
    if (sourceId !== undefined) {
      if (sourceIds.has(sourceId)) {
        issues.push(makeIssue('DUPLICATE_SOURCE_ID', card.file, `duplicate source ID ${sourceId}`));
      }
      sourceIds.add(sourceId);
    }

    if (source.type !== undefined && !SOURCE_TYPES.has(source.type)) {
      issues.push(makeIssue('INVALID_SOURCE_TYPE', card.file, `invalid source type ${source.type}`));
    }
    if (source.verified !== undefined && source.verified !== 'true' && source.verified !== 'false') {
      issues.push(makeIssue(
        'INVALID_SOURCE_VERIFICATION',
        card.file,
        `source ${sourceId ?? '(unknown)'} has invalid verified value`,
      ));
    }
    if (
      source.ref !== undefined
      && (isAbsolute(source.ref) || /^[A-Za-z]:[\\/]/.test(source.ref) || source.ref.startsWith('file://'))
    ) {
      issues.push(makeIssue(
        'ABSOLUTE_SOURCE_LOCATOR',
        card.file,
        `source ${sourceId ?? '(unknown)'} uses a local absolute path as its locator`,
      ));
    }

    const expectedHash = source.excerpt_sha256;
    if (expectedHash !== undefined && !SHA256_PATTERN.test(expectedHash)) {
      issues.push(makeIssue(
        'INVALID_SOURCE_HASH',
        card.file,
        `source ${sourceId ?? '(unknown)'} has an invalid SHA-256 value`,
      ));
      continue;
    }
    if (expectedHash === undefined || sourceId === undefined) continue;

    const excerpt = excerpts.get(sourceId);
    if (excerpt === undefined) {
      issues.push(makeIssue(
        'SOURCE_EXCERPT_MISSING',
        card.file,
        `source ${sourceId} has no continuous blockquote excerpt`,
      ));
      continue;
    }
    const actualHash = createHash('sha256').update(excerpt, 'utf8').digest('hex');
    if (actualHash !== expectedHash) {
      issues.push(makeIssue(
        'SOURCE_HASH_MISMATCH',
        card.file,
        `source ${sourceId} excerpt SHA-256 does not match frontmatter`,
      ));
    }
  }

  return issues;
}

async function listDecisionCardFiles(
  repoRoot: string,
  issues: ValidationIssue[],
): Promise<Array<{ absoluteFile: string; draft: boolean }>> {
  const decisionsDirectory = join(repoRoot, 'docs', 'decisions');
  let entries;
  try {
    entries = await readdir(decisionsDirectory, { withFileTypes: true });
  } catch (error) {
    issues.push(makeIssue(
      'DECISIONS_DIRECTORY_MISSING',
      'docs/decisions',
      `cannot read decisions directory: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return [];
  }

  const files = entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.endsWith('.md')
      && entry.name !== 'README.md'
      && entry.name !== 'INDEX.md'
    ))
    .map((entry) => ({ absoluteFile: join(decisionsDirectory, entry.name), draft: false }));

  const draftDirectory = join(decisionsDirectory, '_draft');
  try {
    const draftEntries = await readdir(draftDirectory, { withFileTypes: true });
    files.push(...draftEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
      .map((entry) => ({ absoluteFile: join(draftDirectory, entry.name), draft: true })));
  } catch {
    // An empty wiki may not have a draft directory yet.
  }

  files.sort((left, right) => left.absoluteFile.localeCompare(right.absoluteFile));
  return files;
}

async function collectLegacyIds(docsDirectory: string): Promise<Set<string>> {
  const ids = new Set<string>();

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || basename(dirname(absolutePath)) !== 'decisions') continue;

      const match = /^(ADR-\d+)(?:-|\.md$)/.exec(entry.name);
      if (match !== null && entry.name.endsWith('.md')) ids.add(match[1]);
    }
  }

  await walk(docsDirectory);
  return ids;
}

function relationIssues(cards: ParsedCard[], legacyIds: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const decisionIds = new Set(cards
    .map((card) => card.fields.id)
    .filter((id): id is string => id !== undefined));
  const targets = new Set([...decisionIds, ...legacyIds]);

  for (const card of cards) {
    const id = card.fields.id;
    for (const relation of RELATION_FIELDS) {
      for (const target of card.relations[relation]) {
        if (target === id) {
          issues.push(makeIssue(
            'SELF_RELATION',
            card.file,
            `${relation} must not point to the same decision`,
          ));
        } else if (!targets.has(target)) {
          issues.push(makeIssue(
            'DANGLING_RELATION',
            card.file,
            `${relation} points to missing decision ${target}`,
          ));
        }
      }
    }
  }

  return issues;
}

function supersedesCycleIssues(cards: ParsedCard[]): ValidationIssue[] {
  const cardsById = new Map<string, ParsedCard>();
  for (const card of cards) {
    const id = card.fields.id;
    if (id !== undefined && !cardsById.has(id)) cardsById.set(id, card);
  }

  const states = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();
  const issues: ValidationIssue[] = [];

  function visit(id: string): void {
    states.set(id, 'visiting');
    stack.push(id);
    const card = cardsById.get(id);
    if (card !== undefined) {
      for (const target of card.relations.supersedes) {
        if (target === id || !cardsById.has(target)) continue;
        if (states.get(target) === 'visiting') {
          const cycleStart = stack.indexOf(target);
          const cycle = [...stack.slice(cycleStart), target];
          const signature = [...new Set(cycle)].sort().join('|');
          if (!reportedCycles.has(signature)) {
            reportedCycles.add(signature);
            issues.push(makeIssue(
              'SUPERSEDES_CYCLE',
              card.file,
              `supersedes cycle detected: ${cycle.join(' -> ')}`,
            ));
          }
        } else if (states.get(target) === undefined) {
          visit(target);
        }
      }
    }
    stack.pop();
    states.set(id, 'visited');
  }

  for (const id of cardsById.keys()) {
    if (states.get(id) === undefined) visit(id);
  }
  return issues;
}

function duplicateIdIssues(cards: ParsedCard[]): ValidationIssue[] {
  const seen = new Map<string, ParsedCard>();
  const issues: ValidationIssue[] = [];
  for (const card of cards) {
    const id = card.fields.id;
    if (id === undefined) continue;
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, card);
      continue;
    }
    issues.push(makeIssue(
      'DUPLICATE_ID',
      card.file,
      `decision ID ${id} is also declared by ${first.file}`,
    ));
  }
  return issues;
}

function indexContainsId(index: string, id: string): boolean {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escapedId}($|[^A-Za-z0-9-])`, 'm').test(index);
}

async function indexIssues(repoRoot: string, cards: ParsedCard[]): Promise<ValidationIssue[]> {
  const indexFile = join(repoRoot, 'docs', 'decisions', 'INDEX.md');
  let index = '';
  try {
    index = await readFile(indexFile, 'utf8');
  } catch (error) {
    return [makeIssue(
      'INDEX_FILE_MISSING',
      'docs/decisions/INDEX.md',
      `cannot read decision index: ${error instanceof Error ? error.message : String(error)}`,
    )];
  }

  return cards
    .filter((card) => !card.draft && card.fields.id !== undefined)
    .filter((card) => !indexContainsId(index, card.fields.id))
    .map((card) => makeIssue(
      'INDEX_ENTRY_MISSING',
      card.file,
      `formal decision ${card.fields.id} is missing from INDEX.md`,
    ));
}

export async function validateDecisionWiki(repoRoot: string): Promise<ValidationReport> {
  const absoluteRepoRoot = resolve(repoRoot);
  const issues: ValidationIssue[] = [];
  const files = await listDecisionCardFiles(absoluteRepoRoot, issues);
  const cards: ParsedCard[] = [];

  for (const { absoluteFile, draft } of files) {
    const file = repoRelative(absoluteRepoRoot, absoluteFile);
    try {
      const content = await readFile(absoluteFile, 'utf8');
      cards.push(parseCard(content, absoluteFile, file, draft));
    } catch (error) {
      issues.push(makeIssue(
        'CARD_READ_ERROR',
        file,
        `cannot read decision card: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  for (const card of cards) issues.push(...validateCard(card));
  issues.push(...duplicateIdIssues(cards));

  const legacyIds = await collectLegacyIds(join(absoluteRepoRoot, 'docs'));
  issues.push(...relationIssues(cards, legacyIds));
  issues.push(...supersedesCycleIssues(cards));
  issues.push(...await indexIssues(absoluteRepoRoot, cards));

  issues.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  ));

  return {
    ok: issues.length === 0,
    cards: cards.length,
    issues,
  };
}

async function runCli(): Promise<void> {
  try {
    const report = await validateDecisionWiki(process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const report: ValidationReport = {
      ok: false,
      cards: 0,
      issues: [makeIssue(
        'VALIDATOR_ERROR',
        '.',
        error instanceof Error ? error.message : String(error),
      )],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const commandPath = process.argv[1];
const commandName = commandPath === undefined ? '' : basename(commandPath);
if (commandName === 'validate-decisions.ts' || commandName === 'validate-decisions.js') {
  void runCli();
}
