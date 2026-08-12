import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SYSTEMD_DIR = join(process.cwd(), 'ops', 'systemd');

function readUnit(name: string): string {
  return readFileSync(join(SYSTEMD_DIR, name), 'utf8');
}

describe('CC-memory systemd scheduling contracts', () => {
  it('keeps user service paths portable and the capture lock aligned with CLI defaults', () => {
    for (const name of [
      'cc-memory-auto-capture.service',
      'cc-memory-backup-freshness.service',
      'cc-memory-reminders.service',
      'cc-memory-todoist-sync.service',
    ]) {
      expect(readUnit(name)).not.toContain('/home/haha');
    }
    expect(readUnit('cc-memory-auto-capture.service')).toContain(
      'ExecStartPre=/usr/bin/mkdir -p -m 700 %h/.cache/cc-memory'
    );
    expect(readUnit('cc-memory-auto-capture.service')).toContain(
      '/usr/bin/flock -n -E 75 %h/.cache/cc-memory/auto-capture-run.lock'
    );
    expect(readUnit('cc-memory-auto-capture.service')).toContain('SuccessExitStatus=75');
  });

  it('checks committed R2 backup freshness hourly without embedding secrets in units', () => {
    const service = readUnit('cc-memory-backup-freshness.service');
    const timer = readUnit('cc-memory-backup-freshness.timer');
    const wrapper = readUnit('run-backup-freshness.sh');

    expect(service).toContain('Type=oneshot');
    expect(service).not.toContain('ConditionPathExists=');
    expect(service).toContain('EnvironmentFile=%h/.ccm-r2.env');
    expect(service).toContain('EnvironmentFile=%h/.ccm-memory-alert.env');
    expect(service).toContain(
      'ExecStart=%h/CC_project/CC-memory/ops/systemd/run-backup-freshness.sh',
    );
    expect(service).not.toMatch(/(SECRET_ACCESS_KEY|BOT_TOKEN)=\S+/);
    expect(timer).toContain('OnCalendar=hourly');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('RandomizedDelaySec=5min');
    expect(wrapper).toContain('age-recipient.txt');
    expect(wrapper).toContain('CC_BACKUP_MAX_AGE_HOURS');
    expect(wrapper).not.toContain('.hermes');
  });

  it('keeps auto-capture hook-driven with a oneshot service and no timer', () => {
    const service = readUnit('cc-memory-auto-capture.service');

    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ConditionPathExists=%h/.ccm-project-url');
    expect(service).toContain(
      'ConditionPathExists=%h/.ccm-auto-capture-production-approved'
    );
    expect(service).not.toContain('ConditionPathExists=%h/.ccm-memory-alert.env');
    expect(service).toContain('Environment=CC_MEMORY_REQUIRE_ALERTS=1');
    expect(service).not.toContain('[Install]');
    expect(existsSync(join(SYSTEMD_DIR, 'cc-memory-auto-capture.timer'))).toBe(false);
  });

  it('runs reminders from an independent personal DB and Telegram env', () => {
    const service = readUnit('cc-memory-reminders.service');
    const timer = readUnit('cc-memory-reminders.timer');
    const wrapper = readUnit('run-reminders.sh');
    const envExample = readUnit('cc-memory-reminders.env.example');

    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ConditionPathExists=%h/.ccm-personal-url');
    expect(service).toContain('ConditionPathExists=%h/.ccm-reminders.env');
    expect(service).not.toContain('.ccm-auto-capture-production-approved');
    expect(service).toContain('EnvironmentFile=%h/.ccm-reminders.env');
    expect(service).toContain('ExecStart=%h/CC_project/CC-memory/ops/systemd/run-reminders.sh');
    expect(timer).toContain('OnCalendar=*:0/5');
    expect(timer).toContain('Persistent=true');
    expect(wrapper).toContain('CC_FORCE_PROJECT_ID=__personal__');
    expect(wrapper).toContain('DATABASE_URL_PERSONAL');
    expect(wrapper).not.toContain('.hermes');
    expect(envExample).toContain('TELEGRAM_BOT_TOKEN=');
    expect(envExample).toContain('TELEGRAM_CHAT_ID=');
  });

  it('runs Todoist sync from independent personal DB and token files', () => {
    const service = readUnit('cc-memory-todoist-sync.service');
    const timer = readUnit('cc-memory-todoist-sync.timer');
    const wrapper = readUnit('run-todoist-sync.sh');

    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ConditionPathExists=%h/.ccm-personal-url');
    expect(service).toContain('ConditionPathExists=%h/.ccm-todoist-token');
    expect(service).not.toContain('.ccm-auto-capture-production-approved');
    expect(service).toContain('ExecStart=%h/CC_project/CC-memory/ops/systemd/run-todoist-sync.sh');
    expect(timer).toContain('OnCalendar=*:0/15');
    expect(timer).toContain('Persistent=true');
    expect(wrapper).toContain('CC_FORCE_PROJECT_ID=__personal__');
    expect(wrapper).toContain('DATABASE_URL_PERSONAL');
    expect(wrapper).toContain('TODOIST_API_TOKEN');
    expect(wrapper).not.toContain('.hermes');
  });
});
