import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDecisionWiki } from '../../scripts/validate-decisions.js';

const tempRepos: string[] = [];
const DEFAULT_EXCERPT = 'The human approved this decision.\nImplement it now.';

type RelationField = 'supersedes' | 'depends_on' | 'conflicts_with' | 'related_to';

interface CardOptions {
  id: string;
  title?: string;
  status?: 'proposed' | 'active' | 'superseded' | 'archived';
  excerpt?: string;
  excerptSha256?: string;
  verified?: boolean;
  supersedes?: string[];
  depends_on?: string[];
  conflicts_with?: string[];
  related_to?: string[];
  extraFrontmatter?: string;
  sourceRef?: string;
}

interface ProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inlineArray(values: string[] = []): string {
  return `[${values.join(', ')}]`;
}

function makeCard({
  id,
  title = 'Valid card',
  status = 'active',
  excerpt = DEFAULT_EXCERPT,
  excerptSha256 = sha256(excerpt),
  verified = true,
  supersedes = [],
  depends_on = [],
  conflicts_with = [],
  related_to = [],
  extraFrontmatter = '',
  sourceRef = 'user-confirmation-2026-07-11',
}: CardOptions): string {
  const optionalFrontmatter = extraFrontmatter === '' ? '' : `${extraFrontmatter}\n`;
  const quotedExcerpt = excerpt.split('\n').map((line) => `> ${line}`).join('\n');

  return `---
id: ${id}
title: ${title}
status: ${status}
decided_at: 2026-07-11T20:00:00+08:00
scope: test
supersedes: ${inlineArray(supersedes)}
depends_on: ${inlineArray(depends_on)}
conflicts_with: ${inlineArray(conflicts_with)}
related_to: ${inlineArray(related_to)}
${optionalFrontmatter}sources:
  - id: S1
    type: manual
    client: human
    ref: ${sourceRef}
    captured_at: 2026-07-11T20:00:00+08:00
    excerpt_sha256: ${excerptSha256}
    verified: ${verified}
---

# ${title}

## 決策背景與決策前狀態

Context.

## 替代方案及採否理由

Alternatives.

## 最終決策與理由

Decision.

## 預期後果及決策後狀態

Consequences.

## 原文溯源

### S1

${quotedExcerpt}

## 後續結果與沿革

None yet.
`;
}

async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'cc-memory-decisions-'));
  tempRepos.push(repoRoot);
  await mkdir(join(repoRoot, 'docs', 'decisions', '_draft'), { recursive: true });
  return repoRoot;
}

async function writeCard(repoRoot: string, relativePath: string, card: string): Promise<void> {
  const file = join(repoRoot, 'docs', 'decisions', relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, card);
}

async function writeIndex(repoRoot: string, ids: string[]): Promise<void> {
  const rows = ids.map((id) => `| \`${id}\` | [開啟](./${id}.md) |`).join('\n');
  await writeIndexRows(repoRoot, rows);
}

async function writeIndexRows(repoRoot: string, rows: string): Promise<void> {
  await writeFile(
    join(repoRoot, 'docs', 'decisions', 'INDEX.md'),
    `# 決策索引\n\n| ID | 決策卡 |\n|---|---|\n${rows}\n`,
  );
}

async function runTsScript(script: string, cwd: string): Promise<ProcessResult> {
  const tsxRegister = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');
  const child = spawn(process.execPath, ['--require', tsxRegister, script], { cwd });
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });

  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stderr, stdout }));
  });
}

function expectIssue(report: Awaited<ReturnType<typeof validateDecisionWiki>>, code: string): void {
  expect(report.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code }),
  ]));
}

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((repoRoot) => rm(repoRoot, {
    force: true,
    recursive: true,
  })));
});

describe('validateDecisionWiki', () => {
  it('accepts a valid repository with one active decision card', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120000Z-valid-card';

    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndex(repoRoot, [id]);

    await expect(validateDecisionWiki(repoRoot)).resolves.toEqual({
      ok: true,
      cards: 1,
      issues: [],
    });
  });

  it('reports a draft/path status mismatch', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120001Z-wrong-draft-status';
    await writeCard(repoRoot, `_draft/${id}.md`, makeCard({ id, status: 'active' }));
    await writeIndex(repoRoot, []);

    expectIssue(await validateDecisionWiki(repoRoot), 'STATUS_PATH_MISMATCH');
  });

  it('requires a verified source on a formal card', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120002Z-unverified-source';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, verified: false }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'VERIFIED_SOURCE_REQUIRED');
  });

  it('reports an excerpt hash mismatch', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120003Z-wrong-hash';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, excerptSha256: '0'.repeat(64) }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SOURCE_HASH_MISMATCH');
  });

  it.each<RelationField>([
    'supersedes',
    'depends_on',
    'conflicts_with',
    'related_to',
  ])('reports a dangling %s target', async (relation) => {
    const repoRoot = await createRepo();
    const id = `DEC-20260711T120004Z-dangling-${relation.replaceAll('_', '-')}`;
    await writeCard(repoRoot, `${id}.md`, makeCard({
      id,
      [relation]: ['DEC-20260711T000000Z-missing'],
    }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'DANGLING_RELATION');
  });

  it('reports a supersedes cycle', async () => {
    const repoRoot = await createRepo();
    const firstId = 'DEC-20260711T120005Z-cycle-first';
    const secondId = 'DEC-20260711T120006Z-cycle-second';
    await writeCard(repoRoot, `${firstId}.md`, makeCard({
      id: firstId,
      supersedes: [secondId],
    }));
    await writeCard(repoRoot, `${secondId}.md`, makeCard({
      id: secondId,
      supersedes: [firstId],
    }));
    await writeIndex(repoRoot, [firstId, secondId]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SUPERSEDES_CYCLE');
  });

  it('reports duplicate decision IDs', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120007Z-duplicate';
    await writeCard(repoRoot, 'DEC-20260711T120008Z-first-copy.md', makeCard({ id }));
    await writeCard(repoRoot, 'DEC-20260711T120009Z-second-copy.md', makeCard({ id }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'DUPLICATE_ID');
  });

  it('reports a formal card missing from INDEX', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120010Z-unindexed';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndex(repoRoot, []);

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_MISSING');
  });

  it('forbids persisted semantic similarity fields', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120011Z-semantic-similarity';
    await writeCard(repoRoot, `${id}.md`, makeCard({
      id,
      extraFrontmatter: 'semantic_similarity: 0.95',
    }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'FORBIDDEN_SIMILARITY_FIELD');
  });

  it('allows a relation to a legacy ADR ID discovered from its filename', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120012Z-legacy-relation';
    const legacyFile = join(repoRoot, 'docs', 'legacy', 'decisions', 'ADR-042-existing.md');
    await mkdir(dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, '# Existing ADR\n');
    await writeCard(repoRoot, `${id}.md`, makeCard({
      id,
      related_to: ['ADR-042'],
    }));
    await writeIndex(repoRoot, [id, 'ADR-042']);

    await expect(validateDecisionWiki(repoRoot)).resolves.toMatchObject({
      ok: true,
      cards: 1,
      issues: [],
    });
  });

  it('reports non-ENOENT errors while reading the draft directory', async () => {
    const repoRoot = await createRepo();
    const draftPath = join(repoRoot, 'docs', 'decisions', '_draft');
    await rm(draftPath, { recursive: true });
    await writeFile(draftPath, 'not a directory');
    await writeIndex(repoRoot, []);

    expectIssue(await validateDecisionWiki(repoRoot), 'DRAFT_DIRECTORY_READ_ERROR');
  });

  it('rejects repeated sources keys', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120013Z-duplicate-sources';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, extraFrontmatter: 'sources:' }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'DUPLICATE_FIELD');
  });

  it('rejects YAML aliases where a top-level scalar literal is required', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120014Z-yaml-alias';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, title: '*shared-title' }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'FRONTMATTER_FORMAT');
  });

  it('does not accept an INDEX ID mention outside a linked Markdown table row', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120015Z-index-prose';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeFile(
      join(repoRoot, 'docs', 'decisions', 'INDEX.md'),
      `# Notes\n\n<!-- ${id} -->\n\n[unrelated](./${id}.md)\n`,
    );

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_MISSING');
  });

  it.each([
    '\\\\server\\share\\decision.md',
    '\\\\?\\C:\\decision.md',
    'FILE:///tmp/decision.md',
    'file:/tmp/decision.md',
  ])('rejects non-portable source locator %s', async (sourceRef) => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120016Z-absolute-locator';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, sourceRef }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'ABSOLUTE_SOURCE_LOCATOR');
  });

  it('reports self-relations', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120017Z-self-relation';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, related_to: [id] }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SELF_RELATION');
  });

  it('ignores required headings inside fenced Markdown code blocks', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120018Z-fenced-heading';
    const heading = '## 決策背景與決策前狀態';
    const card = makeCard({ id }).replace(heading, `\`\`\`markdown\n${heading}\n\`\`\``);
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'REQUIRED_SECTION_MISSING');
  });

  it('ignores source excerpts inside fenced Markdown code blocks', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120019Z-fenced-source';
    const quotedExcerpt = DEFAULT_EXCERPT.split('\n').map((line) => `> ${line}`).join('\n');
    const sourceBlock = `### S1\n\n${quotedExcerpt}`;
    const card = makeCard({ id }).replace(sourceBlock, `\`\`\`markdown\n${sourceBlock}\n\`\`\``);
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SOURCE_EXCERPT_MISSING');
  });

  it('does not execute the CLI when imported by a same-basename entry module', async () => {
    const repoRoot = await createRepo();
    const runner = join(repoRoot, 'validate-decisions.ts');
    const validator = join(process.cwd(), 'scripts', 'validate-decisions.ts');
    await writeFile(runner, `require(${JSON.stringify(validator)});\nprocess.stdout.write('import-safe\\n');\n`);

    const result = await runTsScript(runner, process.cwd());

    expect(result).toEqual({ code: 0, stderr: '', stdout: 'import-safe\n' });
  });

  it('prints JSON and exits 1 when the CLI finds an issue', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120020Z-cli-invalid';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndex(repoRoot, []);

    const result = await runTsScript(
      join(process.cwd(), 'scripts', 'validate-decisions.ts'),
      repoRoot,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, cards: 1 });
  });

  it.each([
    'invalid: unquoted separator',
    '"valid"trailing"',
  ])('rejects malformed restricted scalar %s', async (title) => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120021Z-malformed-scalar';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id, title }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'FRONTMATTER_FORMAT');
  });

  it('ignores INDEX table rows inside HTML comments', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120022Z-commented-index-row';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeFile(
      join(repoRoot, 'docs', 'decisions', 'INDEX.md'),
      `# 決策索引\n\n<!--\n| \`${id}\` | [開啟](./${id}.md) |\n-->\n`,
    );

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_MISSING');
  });

  it('does not join source blockquotes separated by a fenced block', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120023Z-fence-breaks-source';
    const excerpt = 'first source line\nsecond source line';
    const card = makeCard({ id, excerpt }).replace(
      '> first source line\n> second source line',
      '> first source line\n```text\nignored\n```\n> second source line',
    );
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SOURCE_HASH_MISMATCH');
  });

  it('rejects a Windows single-backslash rooted source locator', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120024Z-win32-rooted-locator';
    await writeCard(repoRoot, `${id}.md`, makeCard({
      id,
      sourceRef: '\\private\\decision.md',
    }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'ABSOLUTE_SOURCE_LOCATOR');
  });

  it('prints clean JSON and exits 0 for a valid repository', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120025Z-cli-valid';
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndex(repoRoot, [id]);

    const result = await runTsScript(
      join(process.cwd(), 'scripts', 'validate-decisions.ts'),
      repoRoot,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cards: 1, issues: [] });
  });

  it('hashes HTML-comment text inside a source blockquote exactly', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120026Z-comment-source-excerpt';
    await writeCard(repoRoot, `${id}.md`, makeCard({
      id,
      excerpt: '<!-- approved -->',
    }));
    await writeIndex(repoRoot, [id]);

    await expect(validateDecisionWiki(repoRoot)).resolves.toEqual({
      ok: true,
      cards: 1,
      issues: [],
    });
  });

  it('does not accept an entirely HTML-commented source section as provenance', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120027Z-commented-source-section';
    const quotedExcerpt = DEFAULT_EXCERPT.split('\n').map((line) => `> ${line}`).join('\n');
    const sourceSection = `## 原文溯源\n\n### S1\n\n${quotedExcerpt}`;
    const card = makeCard({ id }).replace(sourceSection, `<!--\n${sourceSection}\n-->`);
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'SOURCE_EXCERPT_MISSING');
  });

  it('ignores a hidden duplicate source heading without changing visible excerpt bytes', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120028Z-hidden-duplicate-source';
    const excerpt = '<!-- approved -->';
    const sourceBlock = `### S1\n\n> ${excerpt}`;
    const card = makeCard({ id, excerpt }).replace(
      sourceBlock,
      `${sourceBlock}\n\n<!--\n### S1\n\n> hidden duplicate\n-->`,
    );
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    await expect(validateDecisionWiki(repoRoot)).resolves.toEqual({
      ok: true,
      cards: 1,
      issues: [],
    });
  });

  it.each<RelationField>([
    'supersedes',
    'depends_on',
    'conflicts_with',
    'related_to',
  ])('rejects a formal %s relation to a proposed draft', async (relation) => {
    const repoRoot = await createRepo();
    const formalId = `DEC-20260711T120029Z-formal-${relation.replaceAll('_', '-')}`;
    const draftId = `DEC-20260711T120030Z-draft-${relation.replaceAll('_', '-')}`;
    await writeCard(repoRoot, `_draft/${draftId}.md`, makeCard({
      id: draftId,
      status: 'proposed',
    }));
    await writeCard(repoRoot, `${formalId}.md`, makeCard({
      id: formalId,
      [relation]: [draftId],
    }));
    await writeIndex(repoRoot, [formalId]);

    expectIssue(await validateDecisionWiki(repoRoot), 'DANGLING_RELATION');
  });

  it('rejects a stale INDEX DEC row for a proposed draft', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120031Z-indexed-draft';
    await writeCard(repoRoot, `_draft/${id}.md`, makeCard({ id, status: 'proposed' }));
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_STALE');
  });

  it('rejects a stale INDEX DEC row for an unknown ID', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120032Z-unknown-index-entry';
    await writeIndex(repoRoot, [id]);

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_STALE');
  });

  it('rejects duplicate visible INDEX rows for the same formal DEC card', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120033Z-duplicate-index-entry';
    const row = `| \`${id}\` | [開啟](./${id}.md) |`;
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndexRows(repoRoot, `${row}\n${row}`);

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_ENTRY_DUPLICATE');
  });

  it.each([
    ['a URI scheme', 'https://example.com/CARD.md'],
    ['an absolute path', '/tmp/CARD.md'],
    ['path traversal', '../archive/CARD.md'],
    ['another relative location', './archive/CARD.md'],
  ])('rejects a formal INDEX link using %s', async (_description, targetTemplate) => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120034Z-invalid-index-link';
    const target = targetTemplate.replace('CARD', id);
    await writeCard(repoRoot, `${id}.md`, makeCard({ id }));
    await writeIndexRows(repoRoot, `| \`${id}\` | [開啟](${target}) |`);

    expectIssue(await validateDecisionWiki(repoRoot), 'INDEX_LINK_INVALID');
  });

  it('ignores an unclosed HTML comment inside a closed fenced code block', async () => {
    const repoRoot = await createRepo();
    const id = 'DEC-20260711T120035Z-fenced-unclosed-comment';
    const card = makeCard({ id }).replace(
      'Context.',
      'Context.\n\n```html\n<!--\n```',
    );
    await writeCard(repoRoot, `${id}.md`, card);
    await writeIndex(repoRoot, [id]);

    await expect(validateDecisionWiki(repoRoot)).resolves.toEqual({
      ok: true,
      cards: 1,
      issues: [],
    });
  });
});
