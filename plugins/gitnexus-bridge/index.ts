/**
 * @papercupai/gitnexus-bridge — MCP-proxy plugin for GitNexus.
 *
 * Spawns `npx gitnexus mcp` as a long-lived stdio JSON-RPC child per
 * workspace, queries its tools/list at startup, and forwards every
 * tools/call to the child. The child is reused across many tool invocations
 * (idle TTL 5 min) so we don't pay graph-load latency on each request.
 *
 * Architecture (5th plugin shape: MCP-proxy):
 *   - getDynamicTools() spawns the child and probes tools/list
 *   - For each tool returned, we synthesize a ToolDefinition with our
 *     standard `tools:gitnexus:<name>` capability and operator+architect
 *     role allowlist, and a handler that JSON-RPCs the child
 *   - Children are keyed by workspace; killed after 5 min idle
 *
 * The plugin handler does NOT consume `ctx.spawn` (we manage children
 * ourselves to keep them resident across calls). `compute:exec:gitnexus`
 * is declared so the spawn surface is auditable.
 *
 * License note: GitNexus is PolyForm-Noncommercial-1.0.0. Bundling here
 * per pre-alpha freedom; revisit before any commercial launch.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter as PATH_DELIMITER } from 'node:path';
import { homedir } from 'node:os';
import type {
  Plugin,
  PapercuspContext,
  ToolDefinition,
  ToolHandler,
  PluginToolMap,
  ToolResult,
} from '@papercusp/plugin-sdk';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ChildHandle {
  proc: ChildProcessWithoutNullStreams;
  /** Pending JSON-RPC calls keyed by id. */
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  nextId: number;
  /** Buffer for line-delimited stdout. */
  buf: string;
  lastUseAt: number;
  /** Tear down on idle timeout. */
  idleTimer: NodeJS.Timeout;
}

const IDLE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

/**
 * The operator host runs under a frozen PATH (systemd unit / Tauri
 * sidecar) that often omits the dir holding the `gitnexus` binary:
 *   - dev box: Homebrew/linuxbrew bin, where `npm i -g gitnexus` lands it;
 *   - packaged desktop: `sidecar/bin`, where the build vendors it (Tauri
 *     prepends that dir to the sidecar PATH — so the bare name resolves
 *     there without any change here).
 * Spawning the bare name under the un-augmented PATH fails with
 * `spawn gitnexus ENOENT` and getDynamicTools() surfaces zero tools.
 * Augment PATH with the common global-bin locations so resolution (and
 * gitnexus's own `#!/usr/bin/env node` shebang) succeeds regardless of how
 * the host was launched. Idempotent — only appends dirs not already present.
 */
function gitnexusPath(): string {
  const parts = (process.env.PATH ?? '').split(PATH_DELIMITER).filter(Boolean);
  const fallbacks = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${homedir()}/.local/bin`,
  ];
  for (const f of fallbacks) if (!parts.includes(f)) parts.push(f);
  return parts.join(PATH_DELIMITER);
}

/**
 * Children are keyed by workspace ID. Even though gitnexus's catalog is
 * machine-global (it indexes per-repo and shows them all), keying by
 * workspace gives us clean idle-cleanup semantics and avoids leaking
 * one workspace's request stream into another's.
 */
const children = new Map<string, ChildHandle>();

function startChild(): ChildHandle {
  // Call gitnexus directly. `npx --yes gitnexus mcp` would be more robust
  // for users who haven't `npm i -g`'d, but npm-as-child-of-node hits an
  // internal bug on Node 25 ("Cannot destructure property 'package' of
  // 'node.target'"). Direct PATH lookup works — plugin requires a global
  // install (`npm i -g gitnexus`); plugin host surfaces a clean discovery
  // error if the binary is missing.
  const proc = spawn('gitnexus', ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: gitnexusPath() },
  });
  const handle: ChildHandle = {
    proc,
    pending: new Map(),
    nextId: 1,
    buf: '',
    lastUseAt: Date.now(),
    idleTimer: setTimeout(() => {}, IDLE_MS),
  };
  // stdout is line-delimited JSON-RPC. Accumulate, split on \n, dispatch.
  proc.stdout.on('data', (chunk: Buffer) => {
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
    // Drop from registry so ensureChild() starts a fresh one next time.
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
  });
  proc.on('close', () => {
    for (const p of handle.pending.values()) p.reject(new Error('gitnexus mcp process exited'));
    handle.pending.clear();
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
  });
  return handle;
}

function dispatchLine(handle: ChildHandle, line: string): void {
  let msg: JsonRpcResponse | null = null;
  try {
    msg = JSON.parse(line) as JsonRpcResponse;
  } catch {
    // gitnexus may print stderr-like info on stdout occasionally; ignore.
    return;
  }
  if (typeof msg?.id !== 'number') return;
  const pending = handle.pending.get(msg.id);
  if (!pending) return;
  handle.pending.delete(msg.id);
  pending.resolve(msg);
}

function rpc(handle: ChildHandle, method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = handle.nextId++;
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
  return new Promise<JsonRpcResponse>((resolve, reject) => {
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

function notify(handle: ChildHandle, method: string, params?: Record<string, unknown>): void {
  const req = { jsonrpc: '2.0' as const, method, ...(params !== undefined ? { params } : {}) };
  handle.proc.stdin.write(JSON.stringify(req) + '\n');
}

function bumpIdle(handle: ChildHandle): void {
  handle.lastUseAt = Date.now();
  clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
    try { handle.proc.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { handle.proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
  }, IDLE_MS);
  handle.idleTimer.unref();
}

async function ensureChild(workspaceId: string): Promise<ChildHandle> {
  let handle = children.get(workspaceId);
  if (handle && !handle.proc.killed) {
    bumpIdle(handle);
    return handle;
  }
  handle = startChild();
  children.set(workspaceId, handle);
  bumpIdle(handle);
  // MCP handshake — initialize then notifications/initialized.
  const init = await rpc(handle, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'papercupai-gitnexus-bridge', version: '0.1.0' },
  });
  if (init.error) throw new Error(`gitnexus initialize failed: ${init.error.message}`);
  notify(handle, 'notifications/initialized');
  return handle;
}

interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function listUpstreamTools(handle: ChildHandle): Promise<UpstreamTool[]> {
  const r = await rpc(handle, 'tools/list', {});
  if (r.error) throw new Error(`gitnexus tools/list failed: ${r.error.message}`);
  const tools = (r.result as { tools?: UpstreamTool[] })?.tools ?? [];
  return tools;
}

/**
 * Roles allowed to call gitnexus tools. Reading-only tools (the bulk —
 * query/cypher/context/impact/etc) are wide; the destructive `rename`
 * and group-mutation tools (group_sync) get tighter gates.
 */
function rolesFor(toolName: string): ToolDefinition['roles'] {
  if (toolName === 'rename' || toolName === 'group_sync') {
    return ['operator', 'architect'];
  }
  return ['operator', 'architect', 'reviewer', 'debugger', 'scoper', 'worker', 'validator'];
}

function quotaFor(toolName: string): ToolDefinition['rolesQuota'] {
  // Default: quota the heavier reads (query, cypher, impact) per-run for
  // non-workers; per-chunk for workers. List/context/route_map/tool_map
  // are cheap; leave unquoted.
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

function makeHandler(toolName: string): ToolHandler {
  return async (input, ctx): Promise<ToolResult> => {
    const workspaceId = ctx.workspaceId ?? 'default';
    const handle = await ensureChild(workspaceId);
    bumpIdle(handle);
    ctx.progress?.(0, `forwarding to gitnexus.${toolName}`);
    const r = await rpc(handle, 'tools/call', { name: toolName, arguments: input as Record<string, unknown> });
    if (r.error) {
      throw new Error(`gitnexus.${toolName}: ${r.error.message}`);
    }
    ctx.progress?.(100, 'done');
    // Upstream returns the standard MCP tool-call envelope: { content, isError? }.
    return r.result as ToolResult;
  };
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/gitnexus-bridge',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Proxies GitNexus MCP tools (code-graph queries) into the Papercusp tool registry.',
  // Cold start (first `gitnexus mcp` spawn + loading a large code-graph index)
  // can exceed the loader's default 10s discovery budget, tripping it → 0 tools
  // + a load error. The warm handshake is sub-second; this headroom covers the
  // cold case. (revive-plugin-system-2026-06-04 D-003.)
  discoveryTimeoutMs: 30_000,
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

  async getDynamicTools(): Promise<{ definitions: ToolDefinition[]; handlers: PluginToolMap }> {
    // Boot a child against the 'default' workspace for tool discovery.
    // Real tool calls then route to per-workspace children.
    const handle = await ensureChild('default');
    const upstream = await listUpstreamTools(handle);

    const definitions: ToolDefinition[] = [];
    const handlers: PluginToolMap = {};
    for (const t of upstream) {
      const cap = `tools:gitnexus:${t.name}`;
      const def: ToolDefinition = {
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

  async init(_ctx: PapercuspContext): Promise<void> {
    // Lifecycle hook fired per (plugin, harness). No-op for the bridge —
    // children are spawned lazily on first tool call.
  },
};

export default plugin;
export const tools: PluginToolMap = {};

/**
 * Test-only: kill all child processes and clear the registry. Used by
 * jest/vitest teardown so each test starts fresh.
 */
export function _resetChildrenForTests(): void {
  for (const h of children.values()) {
    clearTimeout(h.idleTimer);
    try { h.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
  children.clear();
}
