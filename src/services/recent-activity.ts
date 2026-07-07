// src/services/recent-activity.ts
//
// v0.5 M4 4a RED-phase shell only. M4 4b will fill the Recent Activity builder.

import type { DbClient } from './types.js';

export interface RecentActivityRow {
  id: string;
  updatedAt: string; // ISO 8601
  summaryExcerpt: string;
  observationCount: number;
  /** 讀 metadata.capture.discovery_tokens，不現算 */
  discoveryTokens: number;
}

export interface RecentActivityResult {
  /** 注入污染防線 marker（capture worker 看到會排除） */
  source: 'cc-memory-inject';
  projectId: string;
  rows: RecentActivityRow[];
}

export interface BuildRecentActivityInput {
  projectId: string;
  limit?: number;
  tokenBudget?: number;
}

export async function buildRecentActivity(
  _db: DbClient,
  _input: BuildRecentActivityInput
): Promise<RecentActivityResult> {
  throw new Error('buildRecentActivity: not implemented (M4 4b)');
}
