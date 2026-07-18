import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../src/services/types.js';

vi.mock('../../src/services/reminders.js', () => ({
  getDueReminders: vi.fn(async () => []),
}));

vi.mock('../../src/services/delivery-queue.js', () => ({
  enqueueDue: vi.fn(async () => undefined),
  claimDeliverable: vi.fn(async () => []),
  markDelivered: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => 'pending'),
}));

import { getDueReminders } from '../../src/services/reminders.js';
import { runOneTick } from '../../scripts/hermes-reminder-poll.js';

describe('reminder poll delivery channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records Telegram as the delivery channel after the systemd cutover', async () => {
    const tx = {} as DbClient;
    const db = {
      transaction: async (callback: (client: DbClient) => Promise<void>) => callback(tx),
    } as DbClient;

    await runOneTick(db, { projectId: '__personal__' });

    expect(getDueReminders).toHaveBeenCalledWith(tx, {
      projectId: '__personal__',
      channel: 'telegram',
    });
  });
});
