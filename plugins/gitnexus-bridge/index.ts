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
import { delimiter as PATH_DELIMITER, join as joinPath } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type {
  Capability,
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
export function gitnexusPath(): string {
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
 * The exact GitNexus version this bridge is vetted against. Bump only with
 * a re-run of the index-compatibility + canary checks (plan
 * code-intelligence-routing-lsp-gitnexus-2026-08-20, D-004).
 */
export const PINNED_GITNEXUS_VERSION = '1.6.9';

/**
 * Operator-owned pinned install location. Deliberately OUTSIDE the repo and
 * outside the shared workspace node_modules: a shared-tree install rewrites
 * `node_modules/.bin` under every other agent's in-flight test run, so this
 * bridge's dependency is vendored to its own prefix instead.
 *
 *   npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@<pinned>
 */
export function pinnedGitnexusBin(): string {
  return joinPath(homedir(), '.papercusp', 'vendor', 'gitnexus', 'node_modules', '.bin', 'gitnexus');
}

/**
 * Resolve the executable to spawn, in priority order, returning the FIRST
 * that exists on disk. Resolution is explicit and absolute rather than a
 * bare-name PATH lookup: the operator host runs under a frozen PATH, and a
 * bare name there fails with `spawn gitnexus ENOENT`, which surfaces to
 * agents as a plugin with ZERO tools rather than as an error (WI-40192 /
 * plan D-004 — this exact outage).
 *
 * `null` means genuinely not installed; callers must raise a discovery
 * error naming the install command, never register an empty tool list.
 */
export function resolveGitnexusExecutable(): { path: string; source: string } | null {
  const candidates: Array<{ path: string | undefined; source: string }> = [
    // 1. Explicit operator override — escape hatch for packaged/odd hosts.
    { path: process.env.PAPERCUSP_GITNEXUS_BIN, source: 'env:PAPERCUSP_GITNEXUS_BIN' },
    // 2. The pinned operator-owned vendor install (the supported path).
    { path: pinnedGitnexusBin(), source: 'pinned-vendor' },
    // 3. Packaged desktop: Tauri vendors the binary beside the sidecar.
    {
      path: process.env.PAPERCUSP_SIDECAR_BIN_DIR
        ? joinPath(process.env.PAPERCUSP_SIDECAR_BIN_DIR, 'gitnexus')
        : undefined,
      source: 'sidecar-bin',
    },
    // 4. Legacy global installs (`npm i -g gitnexus`), kept for continuity.
    { path: joinPath(homedir(), '.local', 'bin', 'gitnexus'), source: 'global:~/.local/bin' },
    { path: '/home/linuxbrew/.linuxbrew/bin/gitnexus', source: 'global:linuxbrew' },
    { path: '/opt/homebrew/bin/gitnexus', source: 'global:homebrew' },
    { path: '/usr/local/bin/gitnexus', source: 'global:/usr/local/bin' },
  ];
  for (const c of candidates) {
    if (c.path && existsSync(c.path)) return { path: c.path, source: c.source };
  }
  return null;
}

/** Discovery error text — names the fix rather than just the symptom. */
export function gitnexusMissingMessage(): string {
  return (
    `GitNexus executable not found (pinned v${PINNED_GITNEXUS_VERSION}). ` +
    `Install it at the operator-owned path with:\n` +
    `  npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@${PINNED_GITNEXUS_VERSION}\n` +
    `or set PAPERCUSP_GITNEXUS_BIN to an absolute path. ` +
    `Topology questions should fall back to rg/grep until this resolves.`
  );
}

/**
 * Children are keyed by workspace ID. Even though gitnexus's catalog is
 * machine-global (it indexes per-repo and shows them all), keying by
 * workspace gives us clean idle-cleanup semantics and avoids leaking
 * one workspace's request stream into another's.
 */
const children = new Map<string, ChildHandle>();

function startChild(): ChildHandle {
  // Spawn an ABSOLUTE, pinned executable (D-004). `npx --yes gitnexus mcp`
  // would be more robust for users who haven't installed it, but
  // npm-as-child-of-node hits an internal bug on Node 25 ("Cannot
  // destructure property 'package' of 'node.target'"). A bare-name PATH
  // lookup was the previous approach and is what produced the live outage
  // this resolver exists to prevent: under the operator's frozen PATH it
  // fails `spawn gitnexus ENOENT`, and the plugin then registers ZERO
  // tools — indistinguishable to an agent from "gitnexus has nothing to
  // say". Fail loudly instead.
  const resolved = resolveGitnexusExecutable();
  if (!resolved) throw new Error(gitnexusMissingMessage());
  // PATH is still augmented: gitnexus's own `#!/usr/bin/env node` shebang
  // has to resolve `node` from the child's PATH.
  const proc = spawn(resolved.path, ['mcp'], {
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
export function rolesFor(toolName: string): ToolDefinition['roles'] {
  if (toolName === 'rename' || toolName === 'group_sync') {
    return ['operator', 'architect'];
  }
  return ['operator', 'architect', 'reviewer', 'debugger', 'scoper', 'worker', 'validator'];
}

export function quotaFor(toolName: string): ToolDefinition['rolesQuota'] {
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

/**
 * EI-18681162379647090: description/guidance OVERRIDES for the tools agents most need to
 * find by plain-language intent. Upstream gitnexus's own tool descriptions are written in
 * the tool's own vocabulary ("code knowledge graph", "execution flows", "Reciprocal Rank
 * Fusion") — an agent that measured tools:find for phrasings like "find call sites without
 * grep" got ZERO code-search hits, because none of the agent-side words ("where is X
 * defined", "who calls this", "search the repo for") appear anywhere in the indexed text
 * (tools:find embeds `name + description + guidance.when + argSchema`, see
 * agent-tools/tools/find.ts's buildCorpus). Reachable ONLY by agents who already know the
 * literal word "gitnexus" — which is exactly the set that doesn't need to search for it.
 *
 * These overrides REPLACE upstream's description (still the authoritative capability, just
 * re-worded) and add `guidance.when`/`notWhen` in first-person agent vocabulary, explicitly
 * framed as a replacement for shelling out to `grep -r`/`rg` on code (the previous wording,
 * "Complements grep/IDE search", read as permission to keep using grep alongside it rather
 * than instead of it). Tools with no entry here keep upstream's description unchanged, so a
 * future upstream gitnexus release still flows through for anything not overridden.
 */
export const TOOL_OVERRIDES: Record<string, { description: string; guidance: NonNullable<ToolDefinition['guidance']> }> = {
  query: {
    // WI-35557 (2026-08-09): BROKEN on this install — returns 0 results for
    // EVERY input, always. Both retrieval legs are structurally dead: BM25
    // because upstream 1.6.3 defers `CREATE_FTS_INDEX` to the first query,
    // but every query path here (CLI and MCP) opens LadybugDB read-only, so
    // that write can never succeed (logs "Cannot execute write operations in
    // a read-only database!" on every call, forever); vector because
    // `analyze` only generates embeddings under an explicit --embeddings
    // flag AND a hardcoded 50k-node cap that papercusp's 257k-node graph
    // exceeds regardless. A local fix was attempted (eagerly creating FTS
    // indexes during `analyze`, while the DB is genuinely writable) and
    // CONFIRMED to segfault the native LadybugDB binding — reverted, not
    // shipped. Until fixed upstream, do not advertise this as working:
    // description/guidance say so plainly rather than promising a search
    // that silently returns empty (the worst shape — reads as "no match"
    // rather than "broken tool").
    description:
      'BROKEN as of WI-35557 (2026-08-09) — returns 0 results for every input, on every repo, always ' +
      '(upstream read-only-DB defect; a local fix was tried and confirmed to segfault the native ' +
      'binding, so it was reverted rather than shipped). Do NOT use for code search. Use ' +
      '`gitnexus.context` for an exact symbol you already have a name/uid for, or `grep -r`/`rg` for ' +
      'keyword search, until this is fixed.',
    guidance: {
      when: 'Nothing right now — this tool is confirmed non-functional (WI-35557). Do not call it expecting real results.',
      notWhen:
        'Always, until WI-35557 is resolved. Use gitnexus.context (exact symbol) or grep -r/rg ' +
        '(keyword search) instead.',
      chaining: 'N/A — see gitnexus.context for the working symbol-lookup path.',
    },
  },
  cypher: {
    description:
      'Run a direct structural (Cypher) query against the code knowledge graph. Read-capable and NOT ' +
      'affected by the WI-35557 FTS/embedding defect (it queries graph edges directly, no FTS index ' +
      'needed) — but note gitnexus.query, the natural-language front door this was meant to follow up ' +
      'on a miss from, is itself broken (see gitnexus.query). Use for an exact structural answer (e.g. ' +
      '"every function that calls both A and B") when you can express it as a graph pattern.',
    guidance: {
      when: 'When you need an exact graph-structure answer and can express it as a Cypher pattern — do not expect gitnexus.query to have run first (it\'s broken, WI-35557).',
      notWhen: 'Not for prose search (search:fulltext/search:semantic) or when gitnexus.context (exact symbol) already answers it more simply.',
      chaining: 'Follow up a gitnexus.context lookup with this when you need the wider graph structure around a known symbol.',
    },
  },
  context: {
    description:
      'Fetch the full source and surrounding context for a specific symbol or file location the ' +
      'graph already identified (e.g. from a gitnexus.query/cypher result), without a manual file ' +
      'Read+offset.',
    guidance: {
      when: 'After gitnexus.query or gitnexus.cypher returns a symbol/location and you need to read its actual source.',
      chaining: 'Chain directly after gitnexus.query — its results are exactly this tool\'s input.',
    },
  },
  impact: {
    description:
      'Find every caller/consumer that would be affected by changing a given symbol — the ' +
      'blast-radius check before a rename, refactor, or deletion. Use INSTEAD of grep -r when you need ' +
      'to know "what would break" before a risky edit.',
    guidance: {
      when: 'Before renaming, refactoring, or deleting a symbol — "what depends on this", "what would break if I change X".',
      notWhen: 'Not for exploring code you haven\'t decided to change yet — start with gitnexus.query.',
    },
  },
};

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
      // Annotated, not inferred: a bare `const cap = \`tools:...\`` widens to
      // `string`, which is not assignable to Capability's `tools:${string}`
      // member. Surfaced by EI-19305781578043773 giving this plugin a tsconfig.
      const cap: Capability = `tools:gitnexus:${t.name}`;
      const override = TOOL_OVERRIDES[t.name];
      const def: ToolDefinition = {
        name: t.name,
        description: override?.description ?? t.description ?? `gitnexus.${t.name}`,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        capabilities: [cap, 'compute:exec:gitnexus'],
        roles: rolesFor(t.name),
        rolesQuota: quotaFor(t.name),
        timeoutSec: 60,
        expose: {
          mcp: { name: `gitnexus.${t.name}`, largeOutput: t.name === 'query' || t.name === 'cypher' || t.name === 'impact' },
          http: { path: `/api/plugins/gitnexus/${t.name}` },
        },
        ...(override ? { guidance: override.guidance } : {}),
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
