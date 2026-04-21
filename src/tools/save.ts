// src/tools/save.ts
//
// v0.3 Stage 1 Track M：改成薄殼，實作搬到 src/services/memories.ts。
// 保留舊 export 名稱讓既有 import 可繼續使用；型別同步 re-export。

export { saveMemory } from '../services/memories.js';
export type { SaveMemoryInput, SaveMemoryResult } from '../services/types.js';
