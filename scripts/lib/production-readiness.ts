import { BENCHMARK_REPORT_STATUS_LINES } from './benchmark-runner.js';

export type ReadinessStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN';

export interface FileMetadata {
  exists: boolean;
  kind: 'file' | 'directory' | 'symlink' | 'other' | 'missing';
  mode: number | null;
  size: number;
}

export interface UnitEvidence {
  path: string;
  content: string | null;
}

export interface ProductionReadinessEvidence {
  nodeVersion: string;
  repoUnit: UnitEvidence;
  installedUnit: UnitEvidence;
  projectUrl: FileMetadata;
  alertEnv: FileMetadata;
  geminiKey: FileMetadata;
  projectDump: FileMetadata;
  personalDump: FileMetadata;
  spool: FileMetadata;
  productionApproval: FileMetadata;
  cutoffApproval: FileMetadata;
  benchmarkReport: string | null;
}

export interface ProductionReadinessPaths {
  repoUnit: string;
  installedUnit: string;
  projectUrl: string;
  alertEnv: string;
  geminiKey: string;
  projectDump: string;
  personalDump: string;
  spool: string;
  productionApproval: string;
  cutoffApproval: string;
  benchmarkReport: string;
}

export interface ReadinessEvidenceSource {
  metadata(path: string): FileMetadata;
  readText(path: string): string | null;
}

export interface ReadinessGate {
  id:
    | 'g1-recoverability'
    | 'g2-secret-safety'
    | 'g3-quality'
    | 'g4-backlog-cutoff'
    | 'g5-canary'
    | 'g6-observation-cutover';
  status: ReadinessStatus;
  reason: string;
  remediation: string;
}

export interface ProductionReadinessReport {
  advisoryOnly: true;
  generatedAt: string;
  overall: ReadinessStatus;
  gates: ReadinessGate[];
  evidence: {
    nodeVersion: string;
    repoUnitPath: string;
    installedUnitPath: string;
    productionApprovalPresent: boolean;
    cutoffApprovalPresent: boolean;
  };
}

const REQUIRED_UNIT_LINES = [
  'ConditionPathExists=%h/.ccm-project-url',
  'ConditionPathExists=%h/.ccm-auto-capture-production-approved',
  'Environment=CC_MEMORY_REQUIRE_ALERTS=1',
] as const;

export function collectProductionReadinessEvidence(
  paths: ProductionReadinessPaths,
  source: ReadinessEvidenceSource,
  nodeVersion: string,
): ProductionReadinessEvidence {
  return {
    nodeVersion,
    repoUnit: { path: paths.repoUnit, content: source.readText(paths.repoUnit) },
    installedUnit: {
      path: paths.installedUnit,
      content: source.readText(paths.installedUnit),
    },
    projectUrl: source.metadata(paths.projectUrl),
    alertEnv: source.metadata(paths.alertEnv),
    geminiKey: source.metadata(paths.geminiKey),
    projectDump: source.metadata(paths.projectDump),
    personalDump: source.metadata(paths.personalDump),
    spool: source.metadata(paths.spool),
    productionApproval: source.metadata(paths.productionApproval),
    cutoffApproval: source.metadata(paths.cutoffApproval),
    benchmarkReport: source.readText(paths.benchmarkReport),
  };
}

function isSecureRegularFile(file: FileMetadata): boolean {
  return file.exists && file.kind === 'file' && file.mode === 0o600 && file.size > 0;
}

function assessRecoverability(evidence: ProductionReadinessEvidence): ReadinessGate {
  if (!isSecureRegularFile(evidence.projectDump) || !isSecureRegularFile(evidence.personalDump)) {
    return {
      id: 'g1-recoverability',
      status: 'FAIL',
      reason: 'One or both local database dumps are missing, empty, non-regular, or not mode 0600.',
      remediation: 'Create fresh project and personal dumps and verify full restore before canary.',
    };
  }

  return {
    id: 'g1-recoverability',
    status: 'BLOCKED',
    reason: 'Local dump metadata is valid, but offsite copy and restore cannot be proven offline.',
    remediation: 'Copy verified dumps and the backlog archive offsite, then complete human review.',
  };
}

function assessSecretSafety(evidence: ProductionReadinessEvidence): ReadinessGate {
  if (!isSecureRegularFile(evidence.geminiKey)) {
    return {
      id: 'g2-secret-safety',
      status: 'FAIL',
      reason: 'Gemini credential metadata is missing, empty, non-regular, or not mode 0600.',
      remediation: 'Revoke the exposed credential and install a newly issued credential as mode 0600.',
    };
  }

  return {
    id: 'g2-secret-safety',
    status: 'BLOCKED',
    reason: 'Credential file metadata is valid, but provider-side revocation and replacement are external facts.',
    remediation: 'Revoke the exposed credential in the provider console and complete human verification.',
  };
}

function assessQuality(benchmarkReport: string | null): ReadinessGate {
  const reportLines = new Set(
    benchmarkReport?.split(/\r?\n/).map((line) => line.trim()) ?? [],
  );
  if (reportLines.has(BENCHMARK_REPORT_STATUS_LINES.partial)) {
    return {
      id: 'g3-quality',
      status: 'PARTIAL',
      reason: 'The benchmark report explicitly states that it is partial and cannot support Go/No-Go.',
      remediation:
        'Resolve every report incompleteness (including 100% production embedding coverage), ' +
        'run all ten hybrid queries, and complete human scoring.',
    };
  }
  if (reportLines.has(BENCHMARK_REPORT_STATUS_LINES.pendingHumanAnnotation)) {
    return {
      id: 'g3-quality',
      status: 'BLOCKED',
      reason: 'Automated benchmark collection is complete but the required human annotation is not.',
      remediation: 'Complete all three human-scored hard metrics before deciding Go.',
    };
  }
  return {
    id: 'g3-quality',
    status: 'UNKNOWN',
    reason: 'No recognized machine-generated benchmark readiness state was found.',
    remediation: 'Generate the canonical benchmark report; prose or self-attestation is not accepted.',
  };
}

function assessBacklog(evidence: ProductionReadinessEvidence): ReadinessGate {
  if (!evidence.spool.exists) {
    return {
      id: 'g4-backlog-cutoff',
      status: 'FAIL',
      reason: 'The capture spool path is missing.',
      remediation: 'Restore or recreate the spool path without deleting historical capture data.',
    };
  }
  return {
    id: 'g4-backlog-cutoff',
    status: 'BLOCKED',
    reason: evidence.spool.kind === 'symlink'
      ? 'A spool epoch symlink exists, but archive verification and operator authorization require human evidence.'
      : 'The live spool has not been cut over to a versioned epoch symlink.',
    remediation: 'Run the approved fingerprint-bound cutoff and verify its archive; never infer success from a symlink alone.',
  };
}

function assessCanary(evidence: ProductionReadinessEvidence): ReadinessGate {
  const nodeMajor = Number.parseInt(evidence.nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    return {
      id: 'g5-canary',
      status: 'FAIL',
      reason: `Node.js runtime ${evidence.nodeVersion || '(unknown)'} does not satisfy the >=20 contract.`,
      remediation: 'Use Node.js 20 or newer; CI and production verification should use Node.js 22.',
    };
  }
  const repoContent = evidence.repoUnit.content;
  const installedContent = evidence.installedUnit.content;
  const repoLines = new Set(
    repoContent?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [],
  );
  const repoContractValid = repoContent !== null
    && REQUIRED_UNIT_LINES.every((line) => repoLines.has(line));

  if (!repoContractValid) {
    return {
      id: 'g5-canary',
      status: 'FAIL',
      reason: 'The reviewed repository unit does not contain every production safety gate.',
      remediation: 'Restore the project URL, production approval, and mandatory alert gates in the repo unit.',
    };
  }
  if (installedContent === null || installedContent !== repoContent) {
    return {
      id: 'g5-canary',
      status: 'FAIL',
      reason: 'The installed auto-capture unit is missing, not a regular file, or differs byte-for-byte from the reviewed repo unit.',
      remediation: 'Install the reviewed unit while the runtime pause gate remains active, then verify again.',
    };
  }
  if (!isSecureRegularFile(evidence.projectUrl) || !isSecureRegularFile(evidence.alertEnv)) {
    return {
      id: 'g5-canary',
      status: 'FAIL',
      reason: 'Project URL or alert configuration metadata is missing, empty, non-regular, or not mode 0600.',
      remediation: 'Install secure configuration files and prove alert delivery before requesting a canary.',
    };
  }
  return {
    id: 'g5-canary',
    status: 'BLOCKED',
    reason: 'Static canary prerequisites pass, but authorization, execution, and runtime observation are human-controlled.',
    remediation: 'Request a short-lived marker, run one tick, inspect journal and database scope, then revoke the marker.',
  };
}

function overallStatus(gates: ReadinessGate[]): ReadinessStatus {
  if (gates.some((gate) => gate.status === 'FAIL')) return 'FAIL';
  if (gates.some((gate) => gate.status === 'PARTIAL')) return 'PARTIAL';
  if (gates.some((gate) => gate.status === 'UNKNOWN')) return 'UNKNOWN';
  if (gates.some((gate) => gate.status === 'BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

export function assessProductionReadiness(
  evidence: ProductionReadinessEvidence,
  now = new Date(),
): ProductionReadinessReport {
  const gates: ReadinessGate[] = [
    assessRecoverability(evidence),
    assessSecretSafety(evidence),
    assessQuality(evidence.benchmarkReport),
    assessBacklog(evidence),
    assessCanary(evidence),
    {
      id: 'g6-observation-cutover',
      status: 'BLOCKED',
      reason: 'The production observation window and claude-mem pause require human-controlled runtime evidence.',
      remediation: 'Observe the approved canary window, then pause rather than uninstall claude-mem.',
    },
  ];

  return {
    advisoryOnly: true,
    generatedAt: now.toISOString(),
    overall: overallStatus(gates),
    gates,
    evidence: {
      nodeVersion: evidence.nodeVersion,
      repoUnitPath: evidence.repoUnit.path,
      installedUnitPath: evidence.installedUnit.path,
      productionApprovalPresent: evidence.productionApproval.exists,
      cutoffApprovalPresent: evidence.cutoffApproval.exists,
    },
  };
}

export function readinessExitCode(report: ProductionReadinessReport): 0 | 1 | 2 {
  if (report.overall === 'PASS') return 0;
  if (report.overall === 'FAIL' || report.overall === 'PARTIAL') return 1;
  return 2;
}
