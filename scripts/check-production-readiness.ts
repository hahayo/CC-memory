#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  assessProductionReadiness,
  collectProductionReadinessEvidence,
  readinessExitCode,
  type FileMetadata,
  type ProductionReadinessPaths,
  type ProductionReadinessReport,
  type ReadinessEvidenceSource,
} from './lib/production-readiness.js';

function kindOf(stats: Stats): FileMetadata['kind'] {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

const fileSource: ReadinessEvidenceSource = {
  metadata(filePath): FileMetadata {
    try {
      const stats = lstatSync(filePath);
      return {
        exists: true,
        kind: kindOf(stats),
        mode: stats.mode & 0o777,
        size: stats.size,
      };
    } catch {
      return { exists: false, kind: 'missing', mode: null, size: 0 };
    }
  },
  readText(filePath): string | null {
    try {
      const stats = lstatSync(filePath);
      if (!stats.isFile()) return null;
      return readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  },
};

function latestMatchingFile(directory: string, pattern: RegExp, missingName: string): string {
  try {
    const candidate = readdirSync(directory)
      .filter((name) => pattern.test(name))
      .sort()
      .at(-1);
    return path.join(directory, candidate ?? missingName);
  } catch {
    return path.join(directory, missingName);
  }
}

function latestDump(backupDir: string, kind: 'project' | 'personal'): string {
  return latestMatchingFile(
    backupDir,
    new RegExp(`^${kind}-\\d{8}T\\d{6}Z\\.dump$`),
    `${kind}-missing.dump`,
  );
}

export function defaultReadinessPaths(
  repoDir = process.cwd(),
  userHome = homedir(),
): ProductionReadinessPaths {
  const backupDir = path.join(userHome, 'backups', 'cc-memory');
  const benchmarkDir = path.join(repoDir, 'docs', 'auto-capture-v0.5');
  return {
    repoUnit: path.join(repoDir, 'ops', 'systemd', 'cc-memory-auto-capture.service'),
    installedUnit: path.join(
      userHome,
      '.config',
      'systemd',
      'user',
      'cc-memory-auto-capture.service',
    ),
    projectUrl: path.join(userHome, '.ccm-project-url'),
    alertEnv: path.join(userHome, '.ccm-memory-alert.env'),
    geminiKey: path.join(userHome, '.gemini-api-key'),
    projectDump: latestDump(backupDir, 'project'),
    personalDump: latestDump(backupDir, 'personal'),
    spool: path.join(userHome, '.cache', 'cc-memory', 'spool'),
    productionApproval: path.join(userHome, '.ccm-auto-capture-production-approved'),
    cutoffApproval: path.join(userHome, '.ccm-backlog-cutoff-approved'),
    benchmarkReport: latestMatchingFile(
      benchmarkDir,
      /^benchmark-\d{4}-\d{2}-\d{2}\.md$/,
      'benchmark-missing.md',
    ),
  };
}

export function collectDefaultProductionReadinessEvidence(
  repoDir = process.cwd(),
  userHome = homedir(),
  nodeVersion = process.version,
) {
  return collectProductionReadinessEvidence(
    defaultReadinessPaths(repoDir, userHome),
    fileSource,
    nodeVersion,
  );
}

function printHuman(report: ProductionReadinessReport): void {
  process.stdout.write(
    `CC-memory production readiness: ${report.overall} (advisory only; runbook approval still required)\n`,
  );
  for (const gate of report.gates) {
    process.stdout.write(`[${gate.status}] ${gate.id}: ${gate.reason}\n`);
    process.stdout.write(`  next: ${gate.remediation}\n`);
  }
}

export function main(args = process.argv.slice(2)): number {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(', ')}\nUsage: npm run readiness:production -- [--json]\n`);
    return 3;
  }

  const evidence = collectDefaultProductionReadinessEvidence();
  const report = assessProductionReadiness(evidence);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  return readinessExitCode(report);
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined
  && path.basename(invokedPath).replace(/\.[cm]?[jt]s$/, '') === 'check-production-readiness';
if (isMain) {
  process.exitCode = main();
}
