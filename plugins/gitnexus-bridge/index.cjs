"use strict";
/**
 * @papercupai/gitnexus-bridge — runtime artifact, hand-written CommonJS.
 * Mirrors index.ts. Edit both in lockstep until we add a build step.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D2 dynamic-tools).
 */

const { spawn } = require('node:child_process');

const IDLE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const children = new Map();

function startChild() {
  // Call gitnexus directly. We tried `npx --yes gitnexus mcp` but npm-as-
  // child-of-node hits an internal bug on Node 25 ("Cannot destructure
  // property 'package' of 'node.target'") so the npx wrapper never reaches
  // the gitnexus entry. Direct PATH lookup works fine — gitnexus must be
  // globally installed (`npm i -g gitnexus`); plugin host surfaces a clean
  // discovery error if it isn't.
  const proc = spawn('gitnexus', ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const handle = {
    proc,
    pending: new Map(),
    nextId: 1,
    buf: '',
    lastUseAt: Date.now(),
    idleTimer: setTimeout(() => {}, IDLE_MS),
  };
  proc.stdout.on('data', (chunk) => {
    handle.buf += chunk.toString('utf8');
    let nl = handle.buf.indexOf('\n');
    while (nl !== -1) {
      const line = handle.buf.slice(0, nl).trim();
      handle.buf = handle.buf.slice(nl + 1);
      if (line.length > 0) dispatchLine(handle, line);
      nl = handle.buf.indexOf('\n');
    }
  });
  proc.on('error', (err) => {
    for (const p of handle.pending.values()) p.reject(err);
    handle.pending.clear();
  });
  proc.on('close', () => {
    for (const p of handle.pending.values()) p.reject(new Error('gitnexus mcp process exited'));
    handle.pending.clear();
  });
  return handle;
}

function dispatchLine(handle, line) {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg?.id !== 'number') return;
  const pending = handle.pending.get(msg.id);
  if (!pending) return;
  handle.pending.delete(msg.id);
  pending.resolve(msg);
}

function rpc(handle, method, params) {
  const id = handle.nextId++;
  const req = { jsonrpc: '2.0', id, method };
  if (params !== undefined) req.params = params;
  return new Promise((resolve, reject) => {
    handle.pending.set(id, { resolve, reject });
    handle.proc.stdin.write(JSON.stringify(req) + '\n');
    setTimeout(() => {
      if (handle.pending.has(id)) {
        handle.pending.delete(id);
        reject(new Error(`gitnexus mcp ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }
    }, REQUEST_TIMEOUT_MS).unref();
  });
}

function notify(handle, method, params) {
  const req = { jsonrpc: '2.0', method };
  if (params !== undefined) req.params = params;
  handle.proc.stdin.write(JSON.stringify(req) + '\n');
}

function bumpIdle(handle) {
  handle.lastUseAt = Date.now();
  clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
    try { handle.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { handle.proc.kill('SIGKILL'); } catch {} }, 2000).unref();
  }, IDLE_MS);
  handle.idleTimer.unref();
}

async function ensureChild(workspaceId) {
  let handle = children.get(workspaceId);
  if (handle && !handle.proc.killed) {
    bumpIdle(handle);
    return handle;
  }
  handle = startChild();
  children.set(workspaceId, handle);
  bumpIdle(handle);
  const init = await rpc(handle, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'papercupai-gitnexus-bridge', version: '0.1.0' },
  });
  if (init.error) throw new Error(`gitnexus initialize failed: ${init.error.message}`);
  notify(handle, 'notifications/initialized');
  return handle;
}

async function listUpstreamTools(handle) {
  const r = await rpc(handle, 'tools/list', {});
  if (r.error) throw new Error(`gitnexus tools/list failed: ${r.error.message}`);
  return (r.result?.tools) ?? [];
}

function rolesFor(toolName) {
  if (toolName === 'rename' || toolName === 'group_sync') {
    return ['operator', 'architect'];
  }
  return ['operator', 'architect', 'reviewer', 'debugger', 'scoper', 'worker', 'validator'];
}

function quotaFor(toolName) {
  const heavy = new Set(['query', 'cypher', 'impact', 'detect_changes', 'api_impact']);
  if (!heavy.has(toolName)) return undefined;
  return {
    worker: { perChunk: 5 },
    architect: { perRun: 30 },
    reviewer: { perRun: 15 },
    scoper: { perRun: 20 },
    debugger: { perRun: 20 },
  };
}

function makeHandler(toolName) {
  return async (input, ctx) => {
    const workspaceId = ctx.workspaceId ?? 'default';
    const handle = await ensureChild(workspaceId);
    bumpIdle(handle);
    if (typeof ctx.progress === 'function') ctx.progress(0, `forwarding to gitnexus.${toolName}`);
    const r = await rpc(handle, 'tools/call', { name: toolName, arguments: input });
    if (r.error) throw new Error(`gitnexus.${toolName}: ${r.error.message}`);
    if (typeof ctx.progress === 'function') ctx.progress(100, 'done');
    return r.result;
  };
}

const plugin = {
  kind: 'plugin',
  name: '@papercupai/gitnexus-bridge',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Proxies GitNexus MCP tools (code-graph queries) into the Papercusp tool registry.',
  capabilities: [
    'compute:exec:gitnexus',
    
    'tools:gitnexus:list_repos',
    'tools:gitnexus:query',
    'tools:gitnexus:cypher',
    'tools:gitnexus:context',
    'tools:gitnexus:detect_changes',
    'tools:gitnexus:rename',
    'tools:gitnexus:impact',
    'tools:gitnexus:route_map',
    'tools:gitnexus:tool_map',
    'tools:gitnexus:shape_check',
    'tools:gitnexus:api_impact',
    'tools:gitnexus:group_list',
    'tools:gitnexus:group_sync',
  ],

  async getDynamicTools() {
    const handle = await ensureChild('default');
    const upstream = await listUpstreamTools(handle);

    const definitions = [];
    const handlers = {};
    for (const t of upstream) {
      const cap = `tools:gitnexus:${t.name}`;
      const def = {
        name: t.name,
        description: t.description ?? `gitnexus.${t.name}`,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        capabilities: [cap, 'compute:exec:gitnexus'],
        roles: rolesFor(t.name),
        rolesQuota: quotaFor(t.name),
        timeoutSec: 60,
        expose: {
          mcp: { name: `gitnexus.${t.name}`, largeOutput: t.name === 'query' || t.name === 'cypher' || t.name === 'impact' },
          http: { path: `/api/plugins/gitnexus/${t.name}` },
        },
      };
      definitions.push(def);
      handlers[t.name] = makeHandler(t.name);
    }
    return { definitions, handlers };
  },

  async init() {
    // Lifecycle no-op; children spawn lazily.
  },
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = {};
module.exports._resetChildrenForTests = function _resetChildrenForTests() {
  for (const h of children.values()) {
    clearTimeout(h.idleTimer);
    try { h.proc.kill('SIGKILL'); } catch {}
  }
  children.clear();
};
