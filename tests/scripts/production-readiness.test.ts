import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BENCHMARK_REPORT_STATUS_LINES } from '../../scripts/lib/benchmark-runner.js';

import {
  collectDefaultProductionReadinessEvidence,
  defaultReadinessPaths,
  main as readinessMain,
} from '../../scripts/check-production-readiness.js';
import {
  assessProductionReadiness,
  collectProductionReadinessEvidence,
  readinessExitCode,
  type ProductionReadinessPaths,
  type ProductionReadinessEvidence,
  type ReadinessEvidenceSource,
} from '../../scripts/lib/production-readiness.js';

const REQUIRED_UNIT = `[Unit]
ConditionPathExists=%h/.ccm-project-url
ConditionPathExists=%h/.ccm-auto-capture-production-approved
[Service]
Environment=CC_MEMORY_REQUIRE_ALERTS=1
`;

function secureFile(size = 32) {
  return { exists: true, kind: 'file' as const, mode: 0o600, size };
}

function baselineEvidence(): ProductionReadinessEvidence {
  return {
    nodeVersion: 'v22.22.0',
    repoUnit: { path: 'repo.service', content: REQUIRED_UNIT },
    installedUnit: { path: 'installed.service', content: REQUIRED_UNIT },
    projectUrl: secureFile(),
    alertEnv: secureFile(),
    geminiKey: secureFile(40),
    projectDump: secureFile(1000),
    personalDump: secureFile(1000),
    spool: { exists: true, kind: 'directory', mode: 0o700, size: 0 },
    productionApproval: { exists: false, kind: 'missing', mode: null, size: 0 },
    cutoffApproval: { exists: false, kind: 'missing', mode: null, size: 0 },
    benchmarkReport: BENCHMARK_REPORT_STATUS_LINES.pendingHumanAnnotation,
  };
}

describe('production readiness evidence assessor', () => {
  it('fails when the installed production unit differs from the reviewed repo unit', () => {
    const evidence = baselineEvidence();
    evidence.installedUnit.content = REQUIRED_UNIT.replace(
      'Environment=CC_MEMORY_REQUIRE_ALERTS=1\n',
      '',
    );

    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));

    expect(report.gates.find((gate) => gate.id === 'g5-canary')?.status).toBe('FAIL');
    expect(report.overall).toBe('FAIL');
    expect(readinessExitCode(report)).toBe(1);
  });

  it('fails static canary readiness on an unsupported Node.js major version', () => {
    const evidence = baselineEvidence();
    evidence.nodeVersion = 'v18.20.8';

    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));

    expect(report.gates.find((gate) => gate.id === 'g5-canary')).toMatchObject({
      status: 'FAIL',
      reason: expect.stringContaining('Node.js'),
    });
  });

  it.each([
    '#ConditionPathExists=%h/.ccm-project-url',
    'Environment=CC_MEMORY_REQUIRE_ALERTS=10',
  ])('does not accept a commented or prefix-only unit contract line: %s', (replacement) => {
    const evidence = baselineEvidence();
    evidence.repoUnit.content = REQUIRED_UNIT.replace(
      replacement.startsWith('#')
        ? 'ConditionPathExists=%h/.ccm-project-url'
        : 'Environment=CC_MEMORY_REQUIRE_ALERTS=1',
      replacement,
    );
    evidence.installedUnit.content = evidence.repoUnit.content;

    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));

    expect(report.gates.find((gate) => gate.id === 'g5-canary')?.status).toBe('FAIL');
  });

  it('never treats local files as proof of provider revocation or offsite recovery', () => {
    const report = assessProductionReadiness(
      baselineEvidence(),
      new Date('2026-08-12T00:00:00Z'),
    );

    expect(report.gates.find((gate) => gate.id === 'g1-recoverability')?.status).toBe(
      'BLOCKED',
    );
    expect(report.gates.find((gate) => gate.id === 'g2-secret-safety')?.status).toBe(
      'BLOCKED',
    );
    expect(report.overall).toBe('BLOCKED');
    expect(readinessExitCode(report)).toBe(2);
  });

  it('keeps a partial benchmark as a non-deployable result', () => {
    const evidence = baselineEvidence();
    evidence.benchmarkReport = BENCHMARK_REPORT_STATUS_LINES.partial;

    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));

    expect(report.gates.find((gate) => gate.id === 'g3-quality')?.status).toBe('PARTIAL');
    expect(report.overall).toBe('PARTIAL');
    expect(readinessExitCode(report)).toBe(1);
  });

  it('does not accept a canonical status string embedded inside prose', () => {
    const evidence = baselineEvidence();
    evidence.benchmarkReport = `(草稿引用) ${BENCHMARK_REPORT_STATUS_LINES.pendingHumanAnnotation}`;

    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));

    expect(report.gates.find((gate) => gate.id === 'g3-quality')?.status).toBe('UNKNOWN');
  });

  it('serializes allowlisted metadata without any secret value field', () => {
    const evidence = baselineEvidence();
    const sentinel = 'SENSITIVE-CONTENT-MUST-NOT-LEAK';
    evidence.repoUnit.content = `${REQUIRED_UNIT}\n# ${sentinel}`;
    evidence.installedUnit.content = evidence.repoUnit.content;
    evidence.benchmarkReport = `${BENCHMARK_REPORT_STATUS_LINES.partial}\n${sentinel}`;
    const report = assessProductionReadiness(evidence, new Date('2026-08-12T00:00:00Z'));
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('contentValue');
    expect(serialized).toContain('advisoryOnly');
  });

  it('collects only metadata for credential and connection files', () => {
    const readPaths: string[] = [];
    const paths: ProductionReadinessPaths = {
      repoUnit: '/repo/unit',
      installedUnit: '/installed/unit',
      projectUrl: '/secrets/project-url',
      alertEnv: '/secrets/alerts',
      geminiKey: '/secrets/gemini',
      projectDump: '/backup/project.dump',
      personalDump: '/backup/personal.dump',
      spool: '/spool',
      productionApproval: '/approval/production',
      cutoffApproval: '/approval/cutoff',
      benchmarkReport: '/repo/benchmark.md',
    };
    const source: ReadinessEvidenceSource = {
      metadata: () => secureFile(),
      readText: (path) => {
        readPaths.push(path);
        return path.endsWith('.md') ? BENCHMARK_REPORT_STATUS_LINES.partial : REQUIRED_UNIT;
      },
    };

    collectProductionReadinessEvidence(paths, source, 'v22.22.0');

    expect(readPaths).toEqual(['/repo/unit', '/installed/unit', '/repo/benchmark.md']);
  });

  it('selects only the newest timestamped dumps and benchmark report', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-memory-readiness-paths-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const backup = path.join(home, 'backups', 'cc-memory');
    const docs = path.join(repo, 'docs', 'auto-capture-v0.5');
    mkdirSync(backup, { recursive: true });
    mkdirSync(docs, { recursive: true });
    for (const name of [
      'project-20260810T000000Z.dump',
      'project-20260811T000000Z.dump',
      'project-backup.dump',
      'personal-20260811T000000Z.dump',
      'personal-not-a-timestamp.dump',
    ]) writeFileSync(path.join(backup, name), 'fixture');
    for (const name of [
      'benchmark-2026-08-11.md',
      'benchmark-2026-08-12.md',
      'benchmark-latest.md',
    ]) writeFileSync(path.join(docs, name), 'fixture');

    try {
      const paths = defaultReadinessPaths(repo, home);
      expect(path.basename(paths.projectDump)).toBe('project-20260811T000000Z.dump');
      expect(path.basename(paths.personalDump)).toBe('personal-20260811T000000Z.dump');
      expect(path.basename(paths.benchmarkReport)).toBe('benchmark-2026-08-12.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exit 3 for unknown CLI arguments before collecting evidence', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readinessMain(['--bogus'])).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown argument'));
    stderr.mockRestore();
  });

  it('uses lstat metadata and rejects a credential symlink without reading its target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cc-memory-readiness-symlink-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    mkdirSync(path.join(repo, 'ops', 'systemd'), { recursive: true });
    mkdirSync(path.join(repo, 'docs', 'auto-capture-v0.5'), { recursive: true });
    mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
    mkdirSync(path.join(home, 'backups', 'cc-memory'), { recursive: true });
    writeFileSync(path.join(root, 'credential-target'), 'SENSITIVE-CONTENT-MUST-NOT-LEAK');
    symlinkSync(path.join(root, 'credential-target'), path.join(home, '.gemini-api-key'));

    try {
      const evidence = collectDefaultProductionReadinessEvidence(repo, home, 'v22.22.0');
      expect(evidence.geminiKey).toMatchObject({ exists: true, kind: 'symlink' });
      expect(JSON.stringify(evidence.geminiKey)).not.toContain('SENSITIVE-CONTENT-MUST-NOT-LEAK');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
