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
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter as PATH_DELIMITER, join as joinPath } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
  /**
   * Bounded ring of the child's most recent stderr lines.
   *
   * WHY: stderr is spawned as a pipe, so SOMETHING must drain it — an
   * unread pipe fills its ~64KB kernel buffer and then blocks the child
   * mid-write. Draining it into a bounded ring costs nothing and turns
   * every child death into a diagnosable event: without it, a crash
   * rejects its pending calls with a fixed string and the child's own
   * account of what went wrong is discarded as it is produced.
   */
  stderrRing: string[];
  /** Partial trailing stderr line still awaiting its newline. */
  stderrPartial: string;
}

const IDLE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
/** How many stderr lines to retain for crash diagnostics. */
const STDERR_RING_LINES = 40;
/** Per-line cap, so one pathological line cannot dominate the ring. */
const STDERR_LINE_MAX = 500;

/**
 * Render a child exit as a diagnosable error message.
 *
 * Note the empty-stderr branch: "the child said nothing" is itself a
 * finding (an abrupt/native death rather than a reported error), so it is
 * stated explicitly rather than rendered as a missing section — an absent
 * diagnostic and an unavailable one must not look alike.
 */
export function describeChildExit(
  stderrLines: readonly string[],
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const how = signal
    ? `killed by signal ${signal}`
    : code === null
      ? 'exited with no status'
      : `exited with code ${code}`;
  const tail = stderrLines.filter((l) => l.trim().length > 0);
  const diag =
    tail.length > 0
      ? `\n--- last ${tail.length} stderr line(s) from gitnexus ---\n${tail.join('\n')}`
      : '\n(the child produced NO stderr output before exiting — an abrupt or native' +
        ' crash rather than a reported error)';
  return `gitnexus mcp process ${how}${diag}`;
}

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
    // D-066: the operator service runs from the release checkout, while the
    // registered GitNexus index belongs to the canonical staging checkout.
    // Inheriting process.cwd() makes GitNexus open a sibling clone against an
    // index built elsewhere; current context/impact/query probes then SIGSEGV.
    // Run the child in the registry's indexed root so the database, HEAD and
    // repository identity are one coherent tuple.
    cwd: gitnexusChildCwd(),
  });
  const handle: ChildHandle = {
    proc,
    pending: new Map(),
    nextId: 1,
    buf: '',
    lastUseAt: Date.now(),
    idleTimer: setTimeout(() => {}, IDLE_MS),
    stderrRing: [],
    stderrPartial: '',
  };
  // Child streams can split a multi-byte UTF-8 character across data events.
  // Decode through StringDecoder so JSON-RPC lines and diagnostics never gain
  // replacement characters at a chunk boundary.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  // Drain stderr into a bounded ring. This is load-bearing twice over: it
  // keeps the pipe from filling (which would block the child), and it is
  // the ONLY place the child's own diagnostics are retained.
  proc.stderr.on('data', (chunk: Buffer) => {
    handle.stderrPartial += stderrDecoder.write(chunk);
    let nl = handle.stderrPartial.indexOf('\n');
    while (nl !== -1) {
      const line = handle.stderrPartial.slice(0, nl).trimEnd();
      handle.stderrPartial = handle.stderrPartial.slice(nl + 1);
      if (line.length > 0) {
        handle.stderrRing.push(
          line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}…` : line,
        );
        if (handle.stderrRing.length > STDERR_RING_LINES) handle.stderrRing.shift();
      }
      nl = handle.stderrPartial.indexOf('\n');
    }
    // A crash often kills the child mid-line, so the unterminated tail is
    // exactly the part worth keeping — but bound it so a newline-free
    // stream cannot grow without limit.
    if (handle.stderrPartial.length > STDERR_LINE_MAX * 2) {
      handle.stderrPartial = handle.stderrPartial.slice(-STDERR_LINE_MAX);
    }
  });
  // stdout is line-delimited JSON-RPC. Accumulate, split on \n, dispatch.
  proc.stdout.on('data', (chunk: Buffer) => {
    handle.buf += stdoutDecoder.write(chunk);
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
  proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    // Flush a trailing partial UTF-8 sequence before taking the diagnostic
    // snapshot. Stream close can arrive after the final data event that held
    // only part of a code point.
    handle.stderrPartial += stderrDecoder.end();
    stdoutDecoder.end();
    // Node hands this callback (code, signal) and the child's stderr has
    // been retained above; forward BOTH rather than constructing a generic
    // message. An error path that discards the diagnosis it was handed
    // converts a debuggable fault into a permanent mystery, and the cost is
    // paid by every later investigator instead of by the author.
    const tail = [...handle.stderrRing];
    if (handle.stderrPartial.trim().length > 0) tail.push(handle.stderrPartial.trim());
    const message = describeChildExit(tail, code, signal);
    for (const p of handle.pending.values()) p.reject(new Error(message));
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
  return ['operator', 'architect', 'reviewer', 'debugger', 'scoper', 'worker', 'validator', 'judge'];
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
 * These overrides replace upstream descriptions with question-specific guidance:
 * graph topology for known symbols, current text for literals/source, and official
 * LSP for compiler semantics. Tools with no entry keep upstream descriptions, so a
 * future upstream gitnexus release still flows through for anything not overridden.
 */
export const TOOL_OVERRIDES: Record<string, { description: string; guidance: NonNullable<ToolDefinition['guidance']> }> = {
  query: {
    // WI-35557 (2026-08-09): BROKEN on this install. Historical builds returned
    // either zero results or unranked noise. D-065 / EI-22342766996012704
    // (2026-09-04) measured a worse current outcome: a real-symbol query
    // SIGSEGVs the shared MCP child, taking the otherwise-working context / impact
    // tools down with it. Both retrieval legs are structurally dead: BM25
    // because upstream 1.6.3 defers `CREATE_FTS_INDEX` to the first query,
    // but every query path here (CLI and MCP) opens LadybugDB read-only, so
    // that write can never succeed (logs "Cannot execute write operations in
    // a read-only database!" on every call, forever); vector because
    // `analyze` only generates embeddings under an explicit --embeddings
    // flag AND a hardcoded 50k-node cap that papercusp's 257k-node graph
    // exceeds regardless. A local fix was attempted (eagerly creating FTS
    // indexes during `analyze`, while the DB is genuinely writable) and
    // CONFIRMED to segfault the native LadybugDB binding — reverted, not
    // shipped. The bridge therefore refuses query BEFORE ensureChild()/rpc(),
    // isolating the native crash instead of merely documenting it.
    description:
      'UNAVAILABLE (WI-35557, D-065) — historical builds returned zero results or unranked noise; ' +
      'current real-symbol probes SIGSEGV the shared GitNexus MCP process. This bridge now refuses ' +
      'the call before child dispatch so the broken query cannot take down working sibling tools. ' +
      'Do NOT use for code search. Use `gitnexus.context` for an exact symbol already known by name/uid, ' +
      '`graph:query` for callers/callees/topology, or `rg` for keyword search.',
    guidance: {
      when: 'Nothing right now — this tool is fail-closed before dispatch because the upstream query path is unsafe (WI-35557, D-065).',
      notWhen:
        'Always, until a current live reproduction proves the native crash and false-result paths fixed. Use gitnexus.context ' +
        '(exact symbol), graph:query (topology), or rg (keyword search) instead.',
      chaining: 'N/A — this bridge deliberately does not dispatch gitnexus.query.',
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
      'Retrieve indexed context and relationships for a known symbol. Supply uid or file_path to ' +
      'disambiguate names. Content may be stale or include neighboring text; read current source ' +
      'before editing. Empty results do not prove the symbol is absent.',
    guidance: {
      when: 'For a bounded lookup after source, LSP, or graph:query identifies a symbol.',
      notWhen: 'For exact literals, configuration, logs or runtime state use rg or the relevant state tool; use official LSP for compiler references.',
      chaining: 'Inspect index revision and ambiguity, anchor the production symbol, then corroborate relevant locations in current source. On failure use scoped rg or LSP.',
    },
  },
  impact: {
    description:
      'Find indexed callers and dependent symbols to investigate before changing a shared helper. ' +
      'Coverage is partial: stale, dynamic or unindexed consumers may be missing. Separate file ' +
      'links from resolved callers; zero callers does not establish safety.',
    guidance: {
      when: 'Before a substantive shared-symbol rename, refactor or deletion; use graph:query for bounded callers/callees.',
      notWhen: 'For ordinary reads, literal/config searches or runtime diagnosis; these do not require graph lookup. Use context for known-symbol navigation.',
      chaining: 'Record index/source revisions, corroborate consumers in current source or official LSP, and test affected behavior. Report unchecked consumers and fall back on failure.',
    },
  },
  explain: {
    description:
      'Explain persisted GitNexus taint findings from `gitnexus analyze --pdg`: source-to-sink flows, ' +
      'including interprocedural paths. Use it to inspect a known security finding or sink; omit `target` ' +
      'to enumerate findings.',
    guidance: {
      when: 'When you need to inspect a known GitNexus taint finding or trace data into a security sink.',
      notWhen:
        'Not for keyword search or general navigation; use rg for text, gitnexus.context for a known symbol, ' +
        'or graph:query for callers/callees.',
      chaining: 'Follow a finding from a security review or gitnexus.pdg_query into this tool.',
    },
  },
  trace: {
    description:
      'Find the shortest directed symbol path between known code symbols. Use it for a focused execution ' +
      'flow; use `gitnexus.context` for source or `graph:query` for custom topology.',
    guidance: {
      when: 'When you need the shortest caller/callee path between known symbols.',
      notWhen: 'Not for keyword search or broad discovery; use rg for text or gitnexus.context for source.',
      chaining: 'Start with known symbols returned by gitnexus.context or graph:query.',
    },
  },
  tool_map: {
    description:
      'List MCP/RPC tool definitions and their handler files for the indexed repository. The optional `repo` ' +
      'argument is a repository NAME, not a filesystem path or `@group`; omit it to use the papercusp index or ' +
      'pass `repo:"papercusp"`.',
    guidance: {
      when: 'When you need the indexed definitions and handler locations for MCP/RPC tools.',
      notWhen:
        'Do not pass process.cwd(), an absolute filesystem path, or an `@group` as `repo`; this bridge accepts repository names only. ' +
        'Use graph:query or scoped rg for topology and current source.',
      chaining:
        'Start with repo omitted or repo:"papercusp", then corroborate handler locations in current source before editing.',
    },
  },
  pdg_query: {
    description:
      'Query the persisted Program Dependence Graph from `gitnexus analyze --pdg`: `controls` returns ' +
      'CDG edges (what condition gates an anchored target); `flows` returns intra-procedural REACHING_DEF ' +
      'edges (where a variable flows; optional `variable` filter). Requires `target` (file path or symbol); ' +
      'there is no whole-repo scan. Without a PDG layer, it returns a clear note. Basic-block granularity; ' +
      'use `gitnexus.explain` for cross-function taint and `gitnexus.cypher` for raw edges. Full caveats: ' +
      '.claude/skills/gitnexus/gitnexus-guide/SKILL.md.',
    guidance: {
      when: 'Use for guard/comprehension questions or tracing a binding inside one function after `analyze --pdg`.',
      notWhen: 'Not for keyword search, callers/callees, or cross-function flow; use rg, graph:query, or gitnexus.explain.',
      chaining: 'Anchor with a file/symbol target; add `variable` only in `flows` mode.',
    },
  },
};

// ===========================================================================
// P-004 HARDENING — read-only enforcement, freshness metadata, response budgets.
// ===========================================================================

/**
 * Tools that MUTATE and are therefore never registered (P-004 "read-only MCP").
 *
 * `rename` is the load-bearing one: it performs a multi-file coordinated rename by
 * writing source files directly. On this shared tree that is not merely risky, it is a
 * RAIL VIOLATION — every file write here is arbitrated by the `PreToolUse` lock hook
 * (matched on Edit|Write|MultiEdit), and a plugin child process writing through its own
 * fd bypasses that hook completely, along with the secrets guard and the migration /
 * generated-file guards. It can silently clobber a peer's held file.
 *
 * `group_sync` rebuilds a group's contracts.json — a smaller write, excluded under the
 * same rule rather than carving an exception nobody can audit later.
 *
 * NOT REGISTERED rather than registered-and-refusing, deliberately: a tool that always
 * refuses still costs its full description in every agent's tool catalog, which is a
 * budgeted resource here, and buys no capability. The reason lives in this comment and
 * in this exported set, so it is discoverable without being carried in every prompt --
 * and without a per-discovery log line, which only restated this constant (see the
 * silence note in getDynamicTools).
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(['rename', 'group_sync']);

export function isReadOnlyTool(toolName: string): boolean {
  return !MUTATING_TOOLS.has(toolName);
}

/**
 * P-004 — ALLOWED / DEFAULT REPO.
 *
 * Every per-repo gitnexus tool takes an optional `repo`, which upstream documents as
 * "Repository name or path" (its own tool schema). The PATH half is what matters here:
 * it lets any caller aim the graph engine at a tree OUTSIDE the sanctioned checkout —
 * a peer's worktree, the release checkout, anything readable by the operator uid. The
 * read-only rail above stops this bridge WRITING; this one stops it READING out of
 * scope. `@group` forms are refused under the same rule: they fan a single call out
 * across repos, which is the same escape with a different spelling.
 *
 * The DEFAULT half guards a quieter failure. Upstream resolves an omitted `repo` as
 * "the only repo, if exactly one is indexed" — true on this box TODAY (the registry
 * holds `papercusp` alone) and false the moment a second repo is registered, at which
 * point every omitted-repo call silently changes meaning with nothing failing. Naming
 * the default explicitly makes the answer deterministic BEFORE that happens rather
 * than after someone has trusted a wrong one.
 */
export interface RepoPolicy {
  /** Injected when the caller omits `repo`. */
  defaultRepo: string;
  /** Every repo name a caller may name explicitly. */
  allowed: ReadonlySet<string>;
}

const REPO_INPUT_DESCRIPTION =
  'Repository name in the bridge allowlist only. Filesystem paths and `@group` selectors are refused by the P-004 scope policy. Omit `repo` to use the configured default.';

/** Replace the upstream path claim with the bridge's enforced repo-name scope. */
export function scopeRepoInputSchema(inputSchema: unknown): ToolDefinition['inputSchema'] {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return inputSchema as ToolDefinition['inputSchema'];
  }
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return inputSchema as ToolDefinition['inputSchema'];
  }
  const propertyMap = properties as Record<string, unknown>;
  const repo = propertyMap.repo;
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
    return inputSchema as ToolDefinition['inputSchema'];
  }
  return {
    ...schema,
    properties: {
      ...propertyMap,
      repo: { ...(repo as Record<string, unknown>), description: REPO_INPUT_DESCRIPTION },
    },
  } as ToolDefinition['inputSchema'];
}

export function repoPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RepoPolicy {
  const defaultRepo = (env.PAPERCUSP_GITNEXUS_REPO_NAME ?? '').trim() || 'papercusp';
  const extra = (env.PAPERCUSP_GITNEXUS_ALLOWED_REPOS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { defaultRepo, allowed: new Set([defaultRepo, ...extra]) };
}

/**
 * PURE — resolve the `repo` argument of one forwarded call against the policy.
 *
 * Applied ONLY to tools whose upstream schema actually declares `repo` (see
 * getDynamicTools). Deriving that from the schema rather than a hardcoded tool list is
 * deliberate: a hardcoded list silently stops covering a tool the day upstream adds one,
 * and a rail that quietly stops applying is worse than no rail.
 */
export function applyRepoPolicy(
  toolName: string,
  args: Record<string, unknown>,
  policy: RepoPolicy,
): Record<string, unknown> {
  const raw = args.repo;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ...args, repo: policy.defaultRepo };
  }
  const allowedList = [...policy.allowed].join(', ');
  if (typeof raw !== 'string') {
    throw new Error(
      `gitnexus.${toolName}: \`repo\` must be a repository NAME (got ${typeof raw}). ` +
        `Allowed: ${allowedList}.`,
    );
  }
  const name = raw.trim();
  if (policy.allowed.has(name)) return { ...args, repo: name };
  throw new Error(
    `gitnexus.${toolName}: repo ${JSON.stringify(name)} is not allowed on this bridge ` +
      `(P-004, allowed/default repo). Allowed: ${allowedList}. ` +
      'A filesystem PATH or an "@group" is refused even when it exists — the bridge is scoped ' +
      'to this checkout, and reading another tree escapes that scope. Omit `repo` to use ' +
      `${JSON.stringify(policy.defaultRepo)}, or add the name to PAPERCUSP_GITNEXUS_ALLOWED_REPOS.`,
  );
}

/** One `~/.gitnexus/registry.json` entry, as gitnexus writes it. */
export interface GitnexusRegistryStats {
  name?: string;
  path?: string;
  indexedAt?: string;
  lastCommit?: string;
  stats?: { files?: number };
}

export interface IndexFreshness {
  /** Milliseconds since the index was built; null when unknowable. */
  ageMs: number | null;
  /** Short sha the index was built from; null when unknowable. */
  indexedCommit: string | null;
  /** True when HEAD has moved past the indexed commit. */
  behindHead: boolean;
  /** True when we could not establish freshness at all — reported, never assumed fresh. */
  unknown: boolean;
}

export const FRESHNESS_STALE_MS = 60 * 60 * 1000;

/**
 * PURE — derive freshness from inputs, so the policy is testable without a registry
 * file, a clock, or a git subprocess.
 *
 * `unknown` is IN-BAND and must never collapse to "fresh". A missing registry entry
 * means we do not know what the graph contains; reporting that honestly is the whole
 * point, because the failure this guards against is a confident wrong answer.
 */
export function deriveFreshness(
  entry: GitnexusRegistryStats | null,
  headSha: string | null,
  nowMs: number,
): IndexFreshness {
  if (!entry) return { ageMs: null, indexedCommit: null, behindHead: false, unknown: true };
  const indexedAtMs = entry.indexedAt ? Date.parse(entry.indexedAt) : Number.NaN;
  const ageMs = Number.isFinite(indexedAtMs) ? nowMs - indexedAtMs : null;
  const indexedCommit = entry.lastCommit ? entry.lastCommit.slice(0, 10) : null;
  const behindHead = Boolean(headSha && entry.lastCommit && !entry.lastCommit.startsWith(headSha) && !headSha.startsWith(entry.lastCommit));
  return { ageMs, indexedCommit, behindHead, unknown: ageMs == null && indexedCommit == null };
}

/**
 * PURE — the note appended to a response, or '' when the index is fresh enough that a
 * note would be pure noise.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, reproduced live on 2026-08-21: asking the bridge
 * for `resolveGitnexusExecutable` returned `Symbol '...' not found`. The symbol exists —
 * it had been written three minutes AFTER the index was built. A "not found" from a
 * stale graph is indistinguishable from a genuine absence, and an agent that believes it
 * goes on to re-declare a symbol that already exists. So the note is escalated
 * specifically for negative answers: an empty result is exactly the case where staleness
 * changes the meaning of the answer.
 */
export function formatFreshnessNote(f: IndexFreshness, looksNegative: boolean): string {
  if (f.unknown) {
    return (
      '\n\n⚠ INDEX FRESHNESS UNKNOWN — no gitnexus registry entry could be read, so the age and ' +
      'commit of the graph behind this answer are not established. Treat a "not found" as ' +
      'UNVERIFIED and confirm with grep/rg before concluding a symbol does not exist.'
    );
  }
  // AGE ALONE decides staleness. `behindHead` deliberately does NOT, even though it is
  // the more intuitive signal: git-sync commits this whole tree every few minutes, so
  // HEAD has essentially ALWAYS moved past the indexed commit and a behindHead-triggered
  // warning fires on every response forever. Measured 2026-08-21 during live
  // verification — a FOUR-MINUTE-OLD index, freshly built by the hourly routine, was
  // being reported as stale on a perfectly good positive answer. A warning that is
  // always on is a warning nobody reads, which would cost us the NOT-FOUND case below —
  // the one that actually matters. behindHead is kept as explanatory DETAIL, shown only
  // once some other condition has already earned the note.
  const stale = f.ageMs != null && f.ageMs > FRESHNESS_STALE_MS;
  if (!stale && !looksNegative) return '';
  const ageMin = f.ageMs != null ? Math.round(f.ageMs / 60000) : null;
  const parts: string[] = [];
  if (ageMin != null) parts.push(`built ${ageMin}min ago`);
  if (f.indexedCommit) parts.push(`at commit ${f.indexedCommit}`);
  if (f.behindHead) parts.push('HEAD has moved since');
  const desc = parts.length > 0 ? parts.join(', ') : 'age unknown';
  if (looksNegative) {
    return (
      `\n\n⚠ EMPTY/NOT-FOUND RESULT FROM A ${stale ? 'STALE' : ''} INDEX (${desc}). ` +
      'A symbol written after the index was built is reported EXACTLY like one that does not ' +
      'exist. Before concluding it is absent, confirm with grep/rg — or re-index.'
    );
  }
  return `\n\n⚠ Index is stale (${desc}) — symbols added since then are missing from this answer.`;
}

/** Default ceiling on a single forwarded response. */
export const RESPONSE_BUDGET_CHARS = 20_000;

export interface BudgetedText {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * PURE — bound one response, and TEACH on the way out rather than just cutting.
 *
 * Why this is needed at all: every `File` node in this graph stores the ENTIRE FILE
 * CONTENT in `f.content` (measured 2026-08-21 — it is why the database is 4.26 GB). A
 * cypher that returns a bare node, rather than projecting fields, therefore dumps whole
 * source files into the caller's context, and a handful of them can consume a session's
 * whole budget. A silent cut would leave the caller reading a truncated answer as a
 * complete one, so the marker names the cause and the fix.
 */
export function applyResponseBudget(text: string, budget: number = RESPONSE_BUDGET_CHARS): BudgetedText {
  if (text.length <= budget) return { text, truncated: false, originalChars: text.length };
  const keep = text.slice(0, budget);
  return {
    text:
      keep +
      `\n\n… ⚠ TRUNCATED at ${budget} of ${text.length} chars by the gitnexus bridge response budget. ` +
      'This is a BOUNDED view, not a complete answer — do not read the absence of a later row as a real absence. ' +
      'Most oversized responses come from returning whole graph NODES: a File node carries the entire file ' +
      'body in `content`. Project the fields you need instead (RETURN f.filePath, f.name), or add LIMIT.',
    truncated: true,
    originalChars: text.length,
  };
}

/** Heuristic: does this response read as "nothing found"? Drives the escalated note. */
export function looksLikeEmptyResult(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('not found') ||
    t.includes('"row_count": 0') ||
    t.includes('no results') ||
    t.includes('no matches')
  );
}

/**
 * Freshness is read from disk, so it is cached briefly: every forwarded call wants it,
 * and the underlying facts change at most once per reindex (hourly). The TTL is what
 * keeps this off the hot path without letting the note itself go stale.
 */
const FRESHNESS_TTL_MS = 60_000;
let freshnessCache: { at: number; value: IndexFreshness } | null = null;

export function _resetFreshnessCacheForTests(): void {
  freshnessCache = null;
}

function readRegistryEntrySync(repoName: string): GitnexusRegistryStats | null {
  try {
    const file = joinPath(homedir(), '.gitnexus', 'registry.json');
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return null;
    const hit = raw.find((e) => e && typeof e === 'object' && (e as { name?: unknown }).name === repoName);
    return (hit as GitnexusRegistryStats | undefined) ?? null;
  } catch {
    // Absent/unparseable registry ⇒ freshness UNKNOWN, which deriveFreshness reports
    // honestly. It must never read as "fresh".
    return null;
  }
}

/** PURE — pick the indexed repository root, falling back only when it is unusable. */
export function resolveGitnexusChildCwd(
  entry: GitnexusRegistryStats | null,
  fallback: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const indexedRoot = entry?.path;
  return indexedRoot && pathExists(indexedRoot) ? indexedRoot : fallback;
}

/** Resolve the cwd for a real GitNexus MCP child from the same registry entry it queries. */
export function gitnexusChildCwd(): string {
  const repoName = repoPolicyFromEnv().defaultRepo;
  return resolveGitnexusChildCwd(readRegistryEntrySync(repoName), process.cwd());
}

function headShaSync(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

function loadFreshness(): IndexFreshness {
  const now = Date.now();
  if (freshnessCache && now - freshnessCache.at < FRESHNESS_TTL_MS) return freshnessCache.value;
  // Same resolution the repo rail uses, so the graph we REPORT freshness for can never
  // drift from the graph we actually QUERY.
  const repoName = repoPolicyFromEnv().defaultRepo;
  const entry = readRegistryEntrySync(repoName);
  const root = entry && typeof (entry as { path?: string }).path === 'string' ? (entry as { path: string }).path : process.cwd();
  const value = deriveFreshness(entry, headShaSync(root), now);
  freshnessCache = { at: now, value };
  return value;
}

/**
 * PURE — apply the freshness note and the response budget to a forwarded MCP envelope.
 *
 * ORDER MATTERS AND IS LOAD-BEARING: the freshness note is appended FIRST, then the
 * whole thing is budgeted. Budgeting first would let a large response push the note off
 * the end — losing exactly the warning that a big, confident-looking answer came from a
 * stale graph.
 */
export function decorateResult(result: ToolResult, f: IndexFreshness, budget: number = RESPONSE_BUDGET_CHARS): ToolResult {
  const envelope = result as unknown as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(envelope?.content)) return result;
  const joined = envelope.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
  const note = formatFreshnessNote(f, looksLikeEmptyResult(joined));

  const content = envelope.content.map((c, i) => {
    if (typeof c?.text !== 'string') return c;
    const withNote = i === envelope.content!.length - 1 ? c.text + note : c.text;
    const budgeted = applyResponseBudget(withNote, budget);
    return { ...c, text: budgeted.text };
  });
  return { ...(result as object), content } as ToolResult;
}

function makeHandler(toolName: string, acceptsRepo: boolean): ToolHandler {
  return async (input, ctx): Promise<ToolResult> => {
    // Defence in depth: a mutating tool is never registered, so this is unreachable via
    // the normal path — but a handler map is a public surface, and the rail should not
    // depend on registration being the only caller.
    if (!isReadOnlyTool(toolName)) {
      throw new Error(
        `gitnexus.${toolName} is a MUTATING tool and is disabled on this bridge (P-004, read-only MCP). ` +
          'It writes files directly, bypassing the PreToolUse lock arbitration that keeps this shared tree ' +
          'safe. Use Edit/Write for file changes.',
      );
    }
    // D-065: do this BEFORE repo policy, ensureChild(), progress, or rpc(). The
    // broken upstream query path can SIGSEGV the shared MCP child, which also
    // serves context/impact/trace. A documented warning alone does not contain
    // that blast radius; a local fail-closed boundary does.
    if (toolName === 'query') {
      throw new Error(
        'gitnexus.query is unavailable and was not dispatched (WI-35557, D-065): current live probes ' +
          'SIGSEGV the shared GitNexus MCP process; historical builds returned empty or unranked noise. ' +
          'Use gitnexus.context for a known symbol, graph:query for callers/callees/topology, or rg for keywords.',
      );
    }
    // P-004 allowed/default repo. Resolved BEFORE the child is spawned so a refused repo
    // costs nothing, and applied only to tools that actually declare `repo`.
    const rawArgs = (input ?? {}) as Record<string, unknown>;
    const args = acceptsRepo ? applyRepoPolicy(toolName, rawArgs, repoPolicyFromEnv()) : rawArgs;
    const workspaceId = ctx.workspaceId ?? 'default';
    const handle = await ensureChild(workspaceId);
    bumpIdle(handle);
    ctx.progress?.(0, `forwarding to gitnexus.${toolName}`);
    const r = await rpc(handle, 'tools/call', { name: toolName, arguments: args });
    if (r.error) {
      throw new Error(`gitnexus.${toolName}: ${r.error.message}`);
    }
    ctx.progress?.(100, 'done');
    // Upstream returns the standard MCP tool-call envelope: { content, isError? }.
    return decorateResult(r.result as ToolResult, loadFreshness());
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
    // `tools:gitnexus:rename` and `tools:gitnexus:group_sync` are deliberately ABSENT:
    // both are mutating and are refused by MUTATING_TOOLS (P-004 read-only enforcement).
    // A declared capability that can no longer be exercised makes the audit surface read
    // wider than the code actually is.
    'tools:gitnexus:impact',
    'tools:gitnexus:route_map',
    'tools:gitnexus:tool_map',
    'tools:gitnexus:shape_check',
    'tools:gitnexus:api_impact',
    'tools:gitnexus:group_list',
  ],

  async getDynamicTools(): Promise<{ definitions: ToolDefinition[]; handlers: PluginToolMap }> {
    // Boot a child against the 'default' workspace for tool discovery.
    // Real tool calls then route to per-workspace children.
    const handle = await ensureChild('default');
    const upstream = await listUpstreamTools(handle);

    const definitions: ToolDefinition[] = [];
    const handlers: PluginToolMap = {};
    for (const t of upstream) {
      // P-004 read-only enforcement. Dropped BEFORE a definition is built, so a mutating
      // tool costs nothing in the agent tool catalog.
      //
      // Deliberately SILENT: the refusal set is static, so a log here would restate a
      // constant on every discovery, in every process, forever — and on the anomaly
      // channel, where `vitest-fail-on-console` correctly reds any gate test that
      // imports this plugin (it did: events/catalog.test.ts). The rail operating as
      // designed is not an anomaly. What was dropped and why is auditable on demand
      // via the exported MUTATING_TOOLS / isReadOnlyTool(), and is already absent from
      // plugin.capabilities — all queryable, none of them noise.
      if (!isReadOnlyTool(t.name)) {
        continue;
      }
      // Annotated, not inferred: a bare `const cap = \`tools:...\`` widens to
      // `string`, which is not assignable to Capability's `tools:${string}`
      // member. Surfaced by EI-19305781578043773 giving this plugin a tsconfig.
      const cap: Capability = `tools:gitnexus:${t.name}`;
      const override = TOOL_OVERRIDES[t.name];
      const upstreamInputSchema = t.inputSchema ?? { type: 'object', properties: {} };
      const acceptsRepo = Boolean(
        (upstreamInputSchema.properties as Record<string, unknown> | undefined)?.repo,
      );
      const inputSchema = acceptsRepo ? scopeRepoInputSchema(upstreamInputSchema) : upstreamInputSchema;
      const def: ToolDefinition = {
        name: t.name,
        description: override?.description ?? t.description ?? `gitnexus.${t.name}`,
        inputSchema,
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
      // Derived from the UPSTREAM schema, never a hardcoded list — see applyRepoPolicy.
      handlers[t.name] = makeHandler(t.name, acceptsRepo);
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
