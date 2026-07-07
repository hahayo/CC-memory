// src/services/refine.ts
//
// v0.5 M5 refine governance delete service.

import { and, eq, sql } from 'drizzle-orm';

import { observations, projectMemories } from '../db/schema.js';
import { InvalidArgumentError, NotFoundError } from './errors.js';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TARGETS: readonly RefineDeleteTarget[] = ['observation', 'memory'];
const REFINE_DELETE_NOT_FOUND_MESSAGE = 'refineDelete: target not found';

function validateProjectId(projectId: unknown, caller: string): string {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new InvalidArgumentError(`${caller}: projectId must be non-empty`, { projectId });
  }
  return projectId;
}

function validateNonEmptyId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} 必須為非空字串`, { [field]: value });
  }
  return value;
}

function validateUuid(value: unknown, field: string): string {
  const id = validateNonEmptyId(value, field);
  if (!UUID_RE.test(id)) {
    throw new InvalidArgumentError(`${field} 必須為 UUID`, { [field]: value });
  }
  return id;
}

function validateTarget(target: unknown): RefineDeleteTarget {
  if (typeof target !== 'string' || !VALID_TARGETS.includes(target as RefineDeleteTarget)) {
    throw new InvalidArgumentError('refineDelete: target must be observation | memory', {
      target,
    });
  }
  return target as RefineDeleteTarget;
}

export async function refineDelete(
  db: DbClient,
  input: RefineDeleteInput
): Promise<RefineDeleteResult> {
  const projectId = validateProjectId(input.projectId, 'refineDelete');
  const target = validateTarget(input.target);
  const id = validateUuid(input.id, 'id');
  const archivedAt = new Date().toISOString();
  const auditPatch = JSON.stringify({ refine: { deleted: { at: archivedAt } } });

  const rows =
    target === 'observation'
      ? ((await db
          .update(observations)
          .set({
            status: 'archived',
            metadata: sql`${observations.metadata} || ${auditPatch}::jsonb`,
          })
          .where(
            and(
              eq(observations.id, id),
              eq(observations.projectId, projectId),
              eq(observations.status, 'active')
            )
          )
          .returning({ id: observations.id })) as Array<{ id: string }>)
      : ((await db
          .update(projectMemories)
          .set({
            status: 'archived',
            metadata: sql`${projectMemories.metadata} || ${auditPatch}::jsonb`,
          })
          .where(
            and(
              eq(projectMemories.id, id),
              eq(projectMemories.projectId, projectId),
              eq(projectMemories.status, 'active')
            )
          )
          .returning({ id: projectMemories.id })) as Array<{ id: string }>);

  if (rows.length === 0) {
    throw new NotFoundError(REFINE_DELETE_NOT_FOUND_MESSAGE, { id, target });
  }

  return { id, target, archivedAt };
}
