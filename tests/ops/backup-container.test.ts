import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const COMPOSE = join(REPO_ROOT, 'docker-compose.coolify.yml');
const DOCKERFILE = join(REPO_ROOT, 'ops', 'backup', 'Dockerfile');
const DOCKERIGNORE = join(REPO_ROOT, '.dockerignore');

function serviceSection(compose: string, serviceName: string): string | undefined {
  const escapedName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return compose.match(
    new RegExp(
      `(?:^|\\n)  ${escapedName}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|\\nvolumes:\\n|$)`,
    ),
  )?.[0];
}

describe('Coolify backup container contract', () => {
  it('pins the PostgreSQL image and verified age/rclone tool releases', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');

    expect(dockerfile).toContain(
      'FROM pgvector/pgvector:0.8.6-pg18-bookworm@sha256:691673308c99d2161ba298736f3147f1f22d79de2fb7ec93ae9b4afcab870b62',
    );
    expect(dockerfile).toContain('ARG AGE_VERSION=1.3.1');
    expect(dockerfile).toContain(
      'ARG AGE_SHA256=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377',
    );
    expect(dockerfile).toContain('ARG RCLONE_VERSION=1.74.3');
    expect(dockerfile).toContain(
      'ARG RCLONE_SHA256=dbee7ccd7a5d617e4ed4cd4555c16669b511abfe8d31164f61be35ac9e999bd2',
    );
    expect(dockerfile).not.toMatch(/\blatest\b/);
    expect(dockerfile).toContain('RUN chmod 0755 /app/cc-memory-backup.sh');
    expect(dockerfile).toContain('USER postgres');
  });

  it('pins one backup service to each production database', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const projectSection = serviceSection(compose, 'backup-project');
    const personalSection = serviceSection(compose, 'backup-personal');

    expect(projectSection).toBeDefined();
    expect(projectSection).toMatch(/\n {6}CC_BACKUP_TARGET: project\n/);
    expect(projectSection).toMatch(/\n {6}PGDATABASE: cc_memory_project\n/);
    expect(personalSection).toBeDefined();
    expect(personalSection).toMatch(/\n {6}CC_BACKUP_TARGET: personal\n/);
    expect(personalSection).toMatch(/\n {6}PGDATABASE: cc_memory_personal\n/);
    expect(projectSection).not.toContain('CC_BACKUP_TARGET: personal');
    expect(personalSection).not.toContain('CC_BACKUP_TARGET: project');
    expect(projectSection).not.toContain('POSTGRES_PROJECT_DB');
    expect(personalSection).not.toContain('POSTGRES_PERSONAL_DB');
  });

  it('keeps both Coolify backup services idle, private, tmpfs-only, and decrypt-key-free', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const sections = [
      serviceSection(compose, 'backup-project'),
      serviceSection(compose, 'backup-personal'),
    ];

    for (const backupSection of sections) {
      expect(backupSection).toBeDefined();
      expect(backupSection).toContain('dockerfile: ops/backup/Dockerfile');
      expect(backupSection).toContain('CC_BACKUP_TMP_DIR: /backup-tmp');
      expect(backupSection).toContain('CC_MEMORY_AGE_RECIPIENT: ${CC_MEMORY_AGE_RECIPIENT}');
      expect(backupSection).toContain('/backup-tmp:size=2g,mode=0700,uid=999,gid=999');
      expect(backupSection).toContain('command: ["sleep", "infinity"]');
      expect(backupSection).toContain('condition: service_healthy');
      expect(backupSection).not.toContain('ports:');
      expect(backupSection).not.toMatch(/IDENTITY|PRIVATE_KEY|AGE_SECRET/i);
    }
  });

  it('limits the Docker build context to the backup image inputs', () => {
    const dockerignore = readFileSync(DOCKERIGNORE, 'utf8');

    expect(dockerignore.trim().split('\n')).toEqual([
      '**',
      '!ops/backup/Dockerfile',
      '!ops/backup/cc-memory-backup.sh',
    ]);
  });
});
