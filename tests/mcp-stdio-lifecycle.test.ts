import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = join(process.cwd(), 'build', 'index.js');
const TEST_DATABASE_URL = 'postgres://cc_memory:unused@127.0.0.1:1/cc_memory_lifecycle';
const SERVER_VERSION = '0.5.0';
const children = new Set<ChildProcessWithoutNullStreams>();

interface JsonRpcResponse {
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: Array<{ name?: string }>;
  };
}

function spawnServer(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_URL_PERSONAL: undefined,
      CC_FORCE_PROJECT_ID: undefined,
      CC_MEMORY_PROJECT_ID: undefined,
      GEMINI_API_KEY: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 5_000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for JSON-RPC response id=${id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id === id) {
          cleanup();
          resolve(response);
          return;
        }
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`server closed before JSON-RPC response id=${id}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onClose);
    };
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

async function waitForStderr(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stderr pattern ${pattern}`));
    }, 5_000);
    const onData = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
      if (pattern.test(stderr)) {
        cleanup();
        resolve(stderr);
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`server closed before stderr pattern ${pattern}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('close', onClose);
    };
    child.stderr.on('data', onData);
    child.once('close', onClose);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
  children.clear();
});

describe('MCP stdio lifecycle', () => {
  it('survives delayed initialize, lists tools, and exits cleanly on stdin EOF', async () => {
    const child = spawnServer();
    await once(child, 'spawn');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(child.exitCode).toBeNull();

    const initialize = waitForResponse(child, 1);
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cc-memory-lifecycle-test', version: '1.0.0' },
      },
    });
    expect((await initialize).result?.serverInfo).toEqual({
      name: 'cc-memory',
      version: SERVER_VERSION,
    });

    send(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const tools = waitForResponse(child, 2);
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await tools).result?.tools?.map((tool) => tool.name)).toContain('cc_memory_save');

    child.stdin.end();
    await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
  }, 12_000);

  it('handles SIGTERM through graceful shutdown instead of signal termination', async () => {
    const child = spawnServer();
    const stderrPromise = waitForStderr(child, /CC-memory MCP server/);
    await once(child, 'spawn');
    const stderr = await stderrPromise;
    expect(stderr).toContain(`v${SERVER_VERSION} started`);

    child.kill('SIGTERM');
    await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
  }, 8_000);
});
