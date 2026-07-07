// src/services/refine.ts
//
// v0.5 M5 5a RED-phase shell only. M5 5c will fill the refine_delete behavior.

import type { DbClient } from './types.js';

export type RefineDeleteTarget = 'observation' | 'memory';

export interface RefineDeleteInput {
  projectId: string;
  target: RefineDeleteTarget;
  id: string;
}

export interface RefineDeleteResult {
  id: string;
  target: RefineDeleteTarget;
  archivedAt: string; // ISO 8601
}

export async function refineDelete(
  _db: DbClient,
  _input: RefineDeleteInput
): Promise<RefineDeleteResult> {
  throw new Error('refineDelete: not implemented (M5 5c)');
}
