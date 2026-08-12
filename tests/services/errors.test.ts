import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/services/errors.js';

describe('isUniqueViolation', () => {
  it('recognizes direct postgres-js unique violations', () => {
    expect(isUniqueViolation({
      code: '23505',
      constraint_name: 'tasks_idempotency_project_key_idx',
    }, 'tasks_idempotency_project_key_idx')).toBe(true);
  });

  it('recognizes a unique violation wrapped by DrizzleQueryError.cause', () => {
    expect(isUniqueViolation({
      cause: {
        code: '23505',
        constraint_name: 'tasks_idempotency_project_key_idx',
      },
    }, 'tasks_idempotency_project_key_idx')).toBe(true);
  });

  it('rejects another constraint and terminates on a cyclic cause chain', () => {
    expect(isUniqueViolation({
      cause: {
        code: '23505',
        constraint_name: 'another_unique_constraint',
      },
    }, 'tasks_idempotency_project_key_idx')).toBe(false);

    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});
