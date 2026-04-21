// src/tools/index.ts
//
// v0.3 Stage 1 Track M：tools 變薄殼 barrel。
// 新 code 應直接 from '../services/memories.js' / '../services/types.js'。

export { saveMemory } from './save.js';
export type { SaveMemoryInput, SaveMemoryResult } from './save.js';

// 注意：tools/search 是 legacy 適配層，回 Memory[]；
// 若要取 SearchResultEnvelope 請 import from '../services/memories.js'
export { searchMemories } from './search.js';
export type { SearchInput, SearchMode } from './search.js';

export { listMemories } from './list.js';
export type { ListInput } from './list.js';

export { getMemory } from './get.js';
export { deleteMemory } from './delete.js';

export { getProjectStats } from './stats.js';
export type { ProjectStats } from './stats.js';
