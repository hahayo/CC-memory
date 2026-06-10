// vitest.config.ts
//
// CC-memory 測試配置。
// 關鍵設定：`poolOptions.forks.singleFork: true`
//
// 原因：多數 integration tests 共用同一個 test PG（docker cc-memory-test-pg，
// 單一實例）。Vitest 預設每個 test file 開獨立 worker 並行，會造成：
//   - 不同 test file 的 afterEach cleanup 互相污染資料（即使用 project_id prefix 隔離，
//     某些查詢仍會碰到彼此的 row）
//   - PG 連線池在 worker 數 × 每 worker 建立的 drizzle client 下，
//     在重測試檔下可能耗盡 default max_connections=100，造成 10s hook timeout
//
// 本專案 test 全跑 < 3s，serialize 沒感。production code 本身仍可併發。

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 清 ambient env（CC_FORCE_PROJECT_ID / DATABASE_URL_PERSONAL / CC_MEMORY_PROJECT_ID），
    // 防 shell 環境讓 config / scope-policy 啟動期決策走到非測試分支。
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // integration tests 需要等 docker PG 啟動；default 5s 在 CI 偶爾不夠
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
