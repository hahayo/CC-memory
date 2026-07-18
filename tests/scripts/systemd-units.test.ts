import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SYSTEMD_DIR = join(process.cwd(), 'ops', 'systemd');

function readUnit(name: string): string {
  return readFileSync(join(SYSTEMD_DIR, name), 'utf8');
}

describe('CC-memory systemd scheduling contracts', () => {
  it('keeps auto-capture hook-driven with a oneshot service and no timer', () => {
    const service = readUnit('cc-memory-auto-capture.service');

    expect(service).toContain('Type=oneshot');
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
    expect(service).toContain('ExecStart=%h/CC_project/CC-memory/ops/systemd/run-todoist-sync.sh');
    expect(timer).toContain('OnCalendar=*:0/15');
    expect(timer).toContain('Persistent=true');
    expect(wrapper).toContain('CC_FORCE_PROJECT_ID=__personal__');
    expect(wrapper).toContain('DATABASE_URL_PERSONAL');
    expect(wrapper).toContain('TODOIST_API_TOKEN');
    expect(wrapper).not.toContain('.hermes');
  });
});
