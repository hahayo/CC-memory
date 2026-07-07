// src/services/observations.ts
//
// v0.5 M3 3a RED-phase shells only. M3 3b will fill the retrieval behavior.

import type { Observation } from '../db/schema.js';
import type {
  DbClient,
  MemoryIndexResult,
  SearchMemoriesInput,
  SearchResultEnvelope,
} from './types.js';

export interface TimelineResult {
  anchorId: string;
  depthBefore: number;
  depthAfter: number;
  observations: Observation[];
}

export async function searchObservationIndexes(
  _db: DbClient,
  _input: SearchMemoriesInput
): Promise<SearchResultEnvelope<MemoryIndexResult>> {
  throw new Error('searchObservationIndexes: not implemented (M3 3b)');
}

export async function timeline(
  _db: DbClient,
  _anchorId: string,
  _depthBefore: number,
  _depthAfter: number
): Promise<TimelineResult> {
  throw new Error('timeline: not implemented (M3 3b)');
}

export async function getObservations(
  _db: DbClient,
  _ids: string[]
): Promise<Observation[]> {
  throw new Error('getObservations: not implemented (M3 3b)');
}
