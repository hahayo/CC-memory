// src/utils/writer-host.ts
import { hostname } from 'node:os';

type HostnameFn = () => string;

/**
 * 解析寫入者 host 識別字。
 * 優先順序：
 *   1. 環境變數 CC_MEMORY_WRITER（trim 後非空時使用；允許 CI / 容器覆蓋）
 *   2. hostnameFn()（預設 os.hostname()）
 *
 * 用途：v0.3 跨電腦同步稽核，寫入 project_memories.writer_host / tasks.writer_host，
 * 方便從 API 層直接看出某筆記憶 / 任務是哪台機器寫的。
 *
 * hostnameFn 可注入以便測試（直接 spyOn node:os 在 vitest 下會失敗）。
 */
export function resolveWriterHost(hostnameFn: HostnameFn = hostname): string {
  const envValue = process.env.CC_MEMORY_WRITER;
  if (envValue) {
    const trimmed = envValue.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return hostnameFn();
}
