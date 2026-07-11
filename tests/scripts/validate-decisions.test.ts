import { createHash } from 'node:crypto';
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
    ref: user-confirmation-2026-07-11
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
  const rows = ids.map((id) => `| \`${id}\` |`).join('\n');
  await writeFile(
    join(repoRoot, 'docs', 'decisions', 'INDEX.md'),
    `# 決策索引\n\n| ID |\n|---|\n${rows}\n`,
  );
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
});
