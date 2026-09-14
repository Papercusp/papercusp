import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const artifact = readFileSync(new URL('./index.cjs', import.meta.url), 'utf8');

// Exercise the shipped CommonJS discovery path. Only the upstream process is
// replaced, so no real index is opened or changed and mutations stay in memory.
function loadBridge(source: string) {
  const module = { exports: {} as any };
  let spawned = 0;
  const spawn = () => {
    spawned++;
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write(line: string) {
          const request = JSON.parse(line);
          if (request.id === undefined) return true;
          const result = request.method === 'tools/list'
            ? { tools: ['context', 'impact', 'query'].map(name => ({
                name, description: 'upstream description', inputSchema: { type: 'object', properties: {} },
              })) }
            : request.method === 'initialize' ? {} : null;
          if (result === null) throw new Error(`unexpected upstream call: ${request.method}`);
          queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0', id: request.id, result,
          }) + '\n')));
          return true;
        },
      },
      kill() {
        child.killed = true;
        child.emit('close', 0, null);
        return true;
      },
    });
    return child;
  };
  runInNewContext(source, {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout, console,
    process: { ...process, env: { ...process.env, PAPERCUSP_GITNEXUS_BIN: process.execPath } },
    require: (name: string) => name === 'node:child_process'
      ? { ...require(name), spawn } : require(name),
  });
  return { bridge: module.exports, spawned: () => spawned };
}

function assertGuidance(definitions: Array<{ name: string; description: string; guidance?: unknown }>) {
  for (const name of ['context', 'impact']) {
    const def = definitions.find(row => row.name === name);
    expect(def).toBeDefined();
    const text = JSON.stringify(def);
    expect(text).not.toContain('gitnexus.query');
    expect(text).not.toMatch(/every caller|full source|INSTEAD of grep/);
    expect(text).toContain('current source');
    expect(text).toContain('graph:query');
    expect(text).toContain('runtime');
  }
}

describe('runtime discovery preserves selective guidance', () => {
  it('publishes local guidance through actual tools/list and refuses raw query without another child', async () => {
    const { bridge, spawned } = loadBridge(artifact);
    try {
      const { definitions, handlers } = await bridge.getDynamicTools();
      assertGuidance(definitions);
      expect(spawned()).toBe(1);
      await expect(handlers.query({ query: 'known-symbol' }, { workspaceId: 'isolated-guidance' }))
        .rejects.toThrow('was not dispatched');
      expect(spawned()).toBe(1);
    } finally {
      bridge._resetChildrenForTests();
    }
  });

  it('the same discovery oracle rejects an isolated forbidden-next-route mutation', async () => {
    const from = 'For a bounded lookup after source, LSP, or graph:query identifies a symbol.';
    expect(artifact.split(from)).toHaveLength(2);
    const { bridge } = loadBridge(artifact.replace(from, 'After gitnexus.query identifies a symbol.'));
    try {
      const { definitions } = await bridge.getDynamicTools();
      expect(() => assertGuidance(definitions)).toThrow();
    } finally {
      bridge._resetChildrenForTests();
    }
  });
});
