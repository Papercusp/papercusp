"use strict";
/**
 * @papercupai/gitnexus-bridge — GENERATED runtime artifact. DO NOT EDIT.
 *
 * Source of truth: index.ts
 * Regenerate:      npm run gen:gitnexus-bridge
 * Verify:          npm run gen:gitnexus-bridge:check
 *
 * Hand-editing this file reintroduces the source/runtime drift that shipped a
 * bridge whose agent-facing TOOL_OVERRIDES existed only in the TypeScript
 * source and never reached the runtime.
 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// libs/papercusp/plugins/gitnexus-bridge/index.ts
var index_exports = {};
__export(index_exports, {
  FRESHNESS_STALE_MS: () => FRESHNESS_STALE_MS,
  MUTATING_TOOLS: () => MUTATING_TOOLS,
  PINNED_GITNEXUS_VERSION: () => PINNED_GITNEXUS_VERSION,
  RESPONSE_BUDGET_CHARS: () => RESPONSE_BUDGET_CHARS,
  TOOL_OVERRIDES: () => TOOL_OVERRIDES,
  _resetChildrenForTests: () => _resetChildrenForTests,
  _resetFreshnessCacheForTests: () => _resetFreshnessCacheForTests,
  applyRepoPolicy: () => applyRepoPolicy,
  applyResponseBudget: () => applyResponseBudget,
  decorateResult: () => decorateResult,
  default: () => index_default,
  deriveFreshness: () => deriveFreshness,
  describeChildExit: () => describeChildExit,
  formatFreshnessNote: () => formatFreshnessNote,
  gitnexusChildCwd: () => gitnexusChildCwd,
  gitnexusMissingMessage: () => gitnexusMissingMessage,
  gitnexusPath: () => gitnexusPath,
  isReadOnlyTool: () => isReadOnlyTool,
  looksLikeEmptyResult: () => looksLikeEmptyResult,
  pinnedGitnexusBin: () => pinnedGitnexusBin,
  quotaFor: () => quotaFor,
  repoPolicyFromEnv: () => repoPolicyFromEnv,
  resolveGitnexusChildCwd: () => resolveGitnexusChildCwd,
  resolveGitnexusExecutable: () => resolveGitnexusExecutable,
  rolesFor: () => rolesFor,
  tools: () => tools
});
module.exports = __toCommonJS(index_exports);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var import_node_fs = require("node:fs");
var import_node_string_decoder = require("node:string_decoder");
var IDLE_MS = 5 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 60 * 1e3;
var STDERR_RING_LINES = 40;
var STDERR_LINE_MAX = 500;
function describeChildExit(stderrLines, code, signal) {
  const how = signal ? `killed by signal ${signal}` : code === null ? "exited with no status" : `exited with code ${code}`;
  const tail = stderrLines.filter((l) => l.trim().length > 0);
  const diag = tail.length > 0 ? `
--- last ${tail.length} stderr line(s) from gitnexus ---
${tail.join("\n")}` : "\n(the child produced NO stderr output before exiting \u2014 an abrupt or native crash rather than a reported error)";
  return `gitnexus mcp process ${how}${diag}`;
}
function gitnexusPath() {
  const parts = (process.env.PATH ?? "").split(import_node_path.delimiter).filter(Boolean);
  const fallbacks = [
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${(0, import_node_os.homedir)()}/.local/bin`
  ];
  for (const f of fallbacks) if (!parts.includes(f)) parts.push(f);
  return parts.join(import_node_path.delimiter);
}
var PINNED_GITNEXUS_VERSION = "1.6.9";
function pinnedGitnexusBin() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".papercusp", "vendor", "gitnexus", "node_modules", ".bin", "gitnexus");
}
function resolveGitnexusExecutable() {
  const candidates = [
    // 1. Explicit operator override — escape hatch for packaged/odd hosts.
    { path: process.env.PAPERCUSP_GITNEXUS_BIN, source: "env:PAPERCUSP_GITNEXUS_BIN" },
    // 2. The pinned operator-owned vendor install (the supported path).
    { path: pinnedGitnexusBin(), source: "pinned-vendor" },
    // 3. Packaged desktop: Tauri vendors the binary beside the sidecar.
    {
      path: process.env.PAPERCUSP_SIDECAR_BIN_DIR ? (0, import_node_path.join)(process.env.PAPERCUSP_SIDECAR_BIN_DIR, "gitnexus") : void 0,
      source: "sidecar-bin"
    },
    // 4. Legacy global installs (`npm i -g gitnexus`), kept for continuity.
    { path: (0, import_node_path.join)((0, import_node_os.homedir)(), ".local", "bin", "gitnexus"), source: "global:~/.local/bin" },
    { path: "/home/linuxbrew/.linuxbrew/bin/gitnexus", source: "global:linuxbrew" },
    { path: "/opt/homebrew/bin/gitnexus", source: "global:homebrew" },
    { path: "/usr/local/bin/gitnexus", source: "global:/usr/local/bin" }
  ];
  for (const c of candidates) {
    if (c.path && (0, import_node_fs.existsSync)(c.path)) return { path: c.path, source: c.source };
  }
  return null;
}
function gitnexusMissingMessage() {
  return `GitNexus executable not found (pinned v${PINNED_GITNEXUS_VERSION}). Install it at the operator-owned path with:
  npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@${PINNED_GITNEXUS_VERSION}
or set PAPERCUSP_GITNEXUS_BIN to an absolute path. Topology questions should fall back to rg/grep until this resolves.`;
}
var children = /* @__PURE__ */ new Map();
function startChild() {
  const resolved = resolveGitnexusExecutable();
  if (!resolved) throw new Error(gitnexusMissingMessage());
  const proc = (0, import_node_child_process.spawn)(resolved.path, ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: gitnexusPath() },
    // D-066: the operator service runs from the release checkout, while the
    // registered GitNexus index belongs to the canonical staging checkout.
    // Inheriting process.cwd() makes GitNexus open a sibling clone against an
    // index built elsewhere; current context/impact/query probes then SIGSEGV.
    // Run the child in the registry's indexed root so the database, HEAD and
    // repository identity are one coherent tuple.
    cwd: gitnexusChildCwd()
  });
  const handle = {
    proc,
    pending: /* @__PURE__ */ new Map(),
    nextId: 1,
    buf: "",
    lastUseAt: Date.now(),
    idleTimer: setTimeout(() => {
    }, IDLE_MS),
    stderrRing: [],
    stderrPartial: ""
  };
  const stdoutDecoder = new import_node_string_decoder.StringDecoder("utf8");
  const stderrDecoder = new import_node_string_decoder.StringDecoder("utf8");
  proc.stderr.on("data", (chunk) => {
    handle.stderrPartial += stderrDecoder.write(chunk);
    let nl = handle.stderrPartial.indexOf("\n");
    while (nl !== -1) {
      const line = handle.stderrPartial.slice(0, nl).trimEnd();
      handle.stderrPartial = handle.stderrPartial.slice(nl + 1);
      if (line.length > 0) {
        handle.stderrRing.push(
          line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}\u2026` : line
        );
        if (handle.stderrRing.length > STDERR_RING_LINES) handle.stderrRing.shift();
      }
      nl = handle.stderrPartial.indexOf("\n");
    }
    if (handle.stderrPartial.length > STDERR_LINE_MAX * 2) {
      handle.stderrPartial = handle.stderrPartial.slice(-STDERR_LINE_MAX);
    }
  });
  proc.stdout.on("data", (chunk) => {
    handle.buf += stdoutDecoder.write(chunk);
    let nl = handle.buf.indexOf("\n");
    while (nl !== -1) {
      const line = handle.buf.slice(0, nl).trim();
      handle.buf = handle.buf.slice(nl + 1);
      if (line.length > 0) dispatchLine(handle, line);
      nl = handle.buf.indexOf("\n");
    }
  });
  proc.on("error", (err) => {
    for (const p of handle.pending.values()) p.reject(err);
    handle.pending.clear();
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
  });
  proc.on("close", (code, signal) => {
    handle.stderrPartial += stderrDecoder.end();
    stdoutDecoder.end();
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
function dispatchLine(handle, line) {
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg?.id !== "number") return;
  const pending = handle.pending.get(msg.id);
  if (!pending) return;
  handle.pending.delete(msg.id);
  pending.resolve(msg);
}
function rpc(handle, method, params) {
  const id = handle.nextId++;
  const req = { jsonrpc: "2.0", id, method, ...params !== void 0 ? { params } : {} };
  return new Promise((resolve, reject) => {
    handle.pending.set(id, { resolve, reject });
    handle.proc.stdin.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (handle.pending.has(id)) {
        handle.pending.delete(id);
        reject(new Error(`gitnexus mcp ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }
    }, REQUEST_TIMEOUT_MS).unref();
  });
}
function notify(handle, method, params) {
  const req = { jsonrpc: "2.0", method, ...params !== void 0 ? { params } : {} };
  handle.proc.stdin.write(JSON.stringify(req) + "\n");
}
function bumpIdle(handle) {
  handle.lastUseAt = Date.now();
  clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    for (const [k, h] of children.entries()) {
      if (h === handle) children.delete(k);
    }
    try {
      handle.proc.kill("SIGTERM");
    } catch {
    }
    setTimeout(() => {
      try {
        handle.proc.kill("SIGKILL");
      } catch {
      }
    }, 2e3).unref();
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
  const init = await rpc(handle, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "papercupai-gitnexus-bridge", version: "0.1.0" }
  });
  if (init.error) throw new Error(`gitnexus initialize failed: ${init.error.message}`);
  notify(handle, "notifications/initialized");
  return handle;
}
async function listUpstreamTools(handle) {
  const r = await rpc(handle, "tools/list", {});
  if (r.error) throw new Error(`gitnexus tools/list failed: ${r.error.message}`);
  const tools2 = r.result?.tools ?? [];
  return tools2;
}
function rolesFor(toolName) {
  if (toolName === "rename" || toolName === "group_sync") {
    return ["operator", "architect"];
  }
  return ["operator", "architect", "reviewer", "debugger", "scoper", "worker", "validator", "judge"];
}
function quotaFor(toolName) {
  const heavy = /* @__PURE__ */ new Set(["query", "cypher", "impact", "detect_changes", "api_impact"]);
  if (!heavy.has(toolName)) return void 0;
  return {
    worker: { perChunk: 5 },
    architect: { perRun: 30 },
    reviewer: { perRun: 15 },
    scoper: { perRun: 20 },
    debugger: { perRun: 20 }
  };
}
var TOOL_OVERRIDES = {
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
    description: "UNAVAILABLE (WI-35557, D-065) \u2014 historical builds returned zero results or unranked noise; current real-symbol probes SIGSEGV the shared GitNexus MCP process. This bridge now refuses the call before child dispatch so the broken query cannot take down working sibling tools. Do NOT use for code search. Use `gitnexus.context` for an exact symbol already known by name/uid, `graph:query` for callers/callees/topology, or `rg` for keyword search.",
    guidance: {
      when: "Nothing right now \u2014 this tool is fail-closed before dispatch because the upstream query path is unsafe (WI-35557, D-065).",
      notWhen: "Always, until a current live reproduction proves the native crash and false-result paths fixed. Use gitnexus.context (exact symbol), graph:query (topology), or rg (keyword search) instead.",
      chaining: "N/A \u2014 this bridge deliberately does not dispatch gitnexus.query."
    }
  },
  cypher: {
    description: 'Run a direct structural (Cypher) query against the code knowledge graph. Read-capable and NOT affected by the WI-35557 FTS/embedding defect (it queries graph edges directly, no FTS index needed) \u2014 but note gitnexus.query, the natural-language front door this was meant to follow up on a miss from, is itself broken (see gitnexus.query). Use for an exact structural answer (e.g. "every function that calls both A and B") when you can express it as a graph pattern.',
    guidance: {
      when: "When you need an exact graph-structure answer and can express it as a Cypher pattern \u2014 do not expect gitnexus.query to have run first (it's broken, WI-35557).",
      notWhen: "Not for prose search (search:fulltext/search:semantic) or when gitnexus.context (exact symbol) already answers it more simply.",
      chaining: "Follow up a gitnexus.context lookup with this when you need the wider graph structure around a known symbol."
    }
  },
  context: {
    description: "Retrieve indexed context and relationships for a known symbol. Supply uid or file_path to disambiguate names. Content may be stale or include neighboring text; read current source before editing. Empty results do not prove the symbol is absent.",
    guidance: {
      when: "For a bounded lookup after source, LSP, or graph:query identifies a symbol.",
      notWhen: "For exact literals, configuration, logs or runtime state use rg or the relevant state tool; use official LSP for compiler references.",
      chaining: "Inspect index revision and ambiguity, anchor the production symbol, then corroborate relevant locations in current source. On failure use scoped rg or LSP."
    }
  },
  impact: {
    description: "Find indexed callers and dependent symbols to investigate before changing a shared helper. Coverage is partial: stale, dynamic or unindexed consumers may be missing. Separate file links from resolved callers; zero callers does not establish safety.",
    guidance: {
      when: "Before a substantive shared-symbol rename, refactor or deletion; use graph:query for bounded callers/callees.",
      notWhen: "For ordinary reads, literal/config searches or runtime diagnosis; these do not require graph lookup. Use context for known-symbol navigation.",
      chaining: "Record index/source revisions, corroborate consumers in current source or official LSP, and test affected behavior. Report unchecked consumers and fall back on failure."
    }
  },
  explain: {
    description: "Explain persisted GitNexus taint findings from `gitnexus analyze --pdg`: source-to-sink flows, including interprocedural paths. Use it to inspect a known security finding or sink; omit `target` to enumerate findings.",
    guidance: {
      when: "When you need to inspect a known GitNexus taint finding or trace data into a security sink.",
      notWhen: "Not for keyword search or general navigation; use rg for text, gitnexus.context for a known symbol, or graph:query for callers/callees.",
      chaining: "Follow a finding from a security review or gitnexus.pdg_query into this tool."
    }
  },
  trace: {
    description: "Find the shortest directed symbol path between known code symbols. Use it for a focused execution flow; use `gitnexus.context` for source or `graph:query` for custom topology.",
    guidance: {
      when: "When you need the shortest caller/callee path between known symbols.",
      notWhen: "Not for keyword search or broad discovery; use rg for text or gitnexus.context for source.",
      chaining: "Start with known symbols returned by gitnexus.context or graph:query."
    }
  },
  tool_map: {
    description: 'List MCP/RPC tool definitions and their handler files for the indexed repository. The optional `repo` argument is a repository NAME, not a filesystem path or `@group`; omit it to use the papercusp index or pass `repo:"papercusp"`.',
    guidance: {
      when: "When you need the indexed definitions and handler locations for MCP/RPC tools.",
      notWhen: "Do not pass process.cwd(), an absolute filesystem path, or an `@group` as `repo`; this bridge accepts repository names only. Use graph:query or scoped rg for topology and current source.",
      chaining: 'Start with repo omitted or repo:"papercusp", then corroborate handler locations in current source before editing.'
    }
  },
  pdg_query: {
    description: "Query the persisted Program Dependence Graph from `gitnexus analyze --pdg`: `controls` returns CDG edges (what condition gates an anchored target); `flows` returns intra-procedural REACHING_DEF edges (where a variable flows; optional `variable` filter). Requires `target` (file path or symbol); there is no whole-repo scan. Without a PDG layer, it returns a clear note. Basic-block granularity; use `gitnexus.explain` for cross-function taint and `gitnexus.cypher` for raw edges. Full caveats: .claude/skills/gitnexus/gitnexus-guide/SKILL.md.",
    guidance: {
      when: "Use for guard/comprehension questions or tracing a binding inside one function after `analyze --pdg`.",
      notWhen: "Not for keyword search, callers/callees, or cross-function flow; use rg, graph:query, or gitnexus.explain.",
      chaining: "Anchor with a file/symbol target; add `variable` only in `flows` mode."
    }
  }
};
var MUTATING_TOOLS = /* @__PURE__ */ new Set(["rename", "group_sync"]);
function isReadOnlyTool(toolName) {
  return !MUTATING_TOOLS.has(toolName);
}
function repoPolicyFromEnv(env = process.env) {
  const defaultRepo = (env.PAPERCUSP_GITNEXUS_REPO_NAME ?? "").trim() || "papercusp";
  const extra = (env.PAPERCUSP_GITNEXUS_ALLOWED_REPOS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return { defaultRepo, allowed: /* @__PURE__ */ new Set([defaultRepo, ...extra]) };
}
function applyRepoPolicy(toolName, args, policy) {
  const raw = args.repo;
  if (raw === void 0 || raw === null || typeof raw === "string" && raw.trim() === "") {
    return { ...args, repo: policy.defaultRepo };
  }
  const allowedList = [...policy.allowed].join(", ");
  if (typeof raw !== "string") {
    throw new Error(
      `gitnexus.${toolName}: \`repo\` must be a repository NAME (got ${typeof raw}). Allowed: ${allowedList}.`
    );
  }
  const name = raw.trim();
  if (policy.allowed.has(name)) return { ...args, repo: name };
  throw new Error(
    `gitnexus.${toolName}: repo ${JSON.stringify(name)} is not allowed on this bridge (P-004, allowed/default repo). Allowed: ${allowedList}. A filesystem PATH or an "@group" is refused even when it exists \u2014 the bridge is scoped to this checkout, and reading another tree escapes that scope. Omit \`repo\` to use ${JSON.stringify(policy.defaultRepo)}, or add the name to PAPERCUSP_GITNEXUS_ALLOWED_REPOS.`
  );
}
var FRESHNESS_STALE_MS = 60 * 60 * 1e3;
function deriveFreshness(entry, headSha, nowMs) {
  if (!entry) return { ageMs: null, indexedCommit: null, behindHead: false, unknown: true };
  const indexedAtMs = entry.indexedAt ? Date.parse(entry.indexedAt) : Number.NaN;
  const ageMs = Number.isFinite(indexedAtMs) ? nowMs - indexedAtMs : null;
  const indexedCommit = entry.lastCommit ? entry.lastCommit.slice(0, 10) : null;
  const behindHead = Boolean(headSha && entry.lastCommit && !entry.lastCommit.startsWith(headSha) && !headSha.startsWith(entry.lastCommit));
  return { ageMs, indexedCommit, behindHead, unknown: ageMs == null && indexedCommit == null };
}
function formatFreshnessNote(f, looksNegative) {
  if (f.unknown) {
    return '\n\n\u26A0 INDEX FRESHNESS UNKNOWN \u2014 no gitnexus registry entry could be read, so the age and commit of the graph behind this answer are not established. Treat a "not found" as UNVERIFIED and confirm with grep/rg before concluding a symbol does not exist.';
  }
  const stale = f.ageMs != null && f.ageMs > FRESHNESS_STALE_MS;
  if (!stale && !looksNegative) return "";
  const ageMin = f.ageMs != null ? Math.round(f.ageMs / 6e4) : null;
  const parts = [];
  if (ageMin != null) parts.push(`built ${ageMin}min ago`);
  if (f.indexedCommit) parts.push(`at commit ${f.indexedCommit}`);
  if (f.behindHead) parts.push("HEAD has moved since");
  const desc = parts.length > 0 ? parts.join(", ") : "age unknown";
  if (looksNegative) {
    return `

\u26A0 EMPTY/NOT-FOUND RESULT FROM A ${stale ? "STALE" : ""} INDEX (${desc}). A symbol written after the index was built is reported EXACTLY like one that does not exist. Before concluding it is absent, confirm with grep/rg \u2014 or re-index.`;
  }
  return `

\u26A0 Index is stale (${desc}) \u2014 symbols added since then are missing from this answer.`;
}
var RESPONSE_BUDGET_CHARS = 2e4;
function applyResponseBudget(text, budget = RESPONSE_BUDGET_CHARS) {
  if (text.length <= budget) return { text, truncated: false, originalChars: text.length };
  const keep = text.slice(0, budget);
  return {
    text: keep + `

\u2026 \u26A0 TRUNCATED at ${budget} of ${text.length} chars by the gitnexus bridge response budget. This is a BOUNDED view, not a complete answer \u2014 do not read the absence of a later row as a real absence. Most oversized responses come from returning whole graph NODES: a File node carries the entire file body in \`content\`. Project the fields you need instead (RETURN f.filePath, f.name), or add LIMIT.`,
    truncated: true,
    originalChars: text.length
  };
}
function looksLikeEmptyResult(text) {
  const t = text.toLowerCase();
  return t.includes("not found") || t.includes('"row_count": 0') || t.includes("no results") || t.includes("no matches");
}
var FRESHNESS_TTL_MS = 6e4;
var freshnessCache = null;
function _resetFreshnessCacheForTests() {
  freshnessCache = null;
}
function readRegistryEntrySync(repoName) {
  try {
    const file = (0, import_node_path.join)((0, import_node_os.homedir)(), ".gitnexus", "registry.json");
    const raw = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
    if (!Array.isArray(raw)) return null;
    const hit = raw.find((e) => e && typeof e === "object" && e.name === repoName);
    return hit ?? null;
  } catch {
    return null;
  }
}
function resolveGitnexusChildCwd(entry, fallback, pathExists = import_node_fs.existsSync) {
  const indexedRoot = entry?.path;
  return indexedRoot && pathExists(indexedRoot) ? indexedRoot : fallback;
}
function gitnexusChildCwd() {
  const repoName = repoPolicyFromEnv().defaultRepo;
  return resolveGitnexusChildCwd(readRegistryEntrySync(repoName), process.cwd());
}
function headShaSync(cwd) {
  try {
    return (0, import_node_child_process.execFileSync)("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5e3 }).trim() || null;
  } catch {
    return null;
  }
}
function loadFreshness() {
  const now = Date.now();
  if (freshnessCache && now - freshnessCache.at < FRESHNESS_TTL_MS) return freshnessCache.value;
  const repoName = repoPolicyFromEnv().defaultRepo;
  const entry = readRegistryEntrySync(repoName);
  const root = entry && typeof entry.path === "string" ? entry.path : process.cwd();
  const value = deriveFreshness(entry, headShaSync(root), now);
  freshnessCache = { at: now, value };
  return value;
}
function decorateResult(result, f, budget = RESPONSE_BUDGET_CHARS) {
  const envelope = result;
  if (!Array.isArray(envelope?.content)) return result;
  const joined = envelope.content.map((c) => typeof c?.text === "string" ? c.text : "").join("");
  const note = formatFreshnessNote(f, looksLikeEmptyResult(joined));
  const content = envelope.content.map((c, i) => {
    if (typeof c?.text !== "string") return c;
    const withNote = i === envelope.content.length - 1 ? c.text + note : c.text;
    const budgeted = applyResponseBudget(withNote, budget);
    return { ...c, text: budgeted.text };
  });
  return { ...result, content };
}
function makeHandler(toolName, acceptsRepo) {
  return async (input, ctx) => {
    if (!isReadOnlyTool(toolName)) {
      throw new Error(
        `gitnexus.${toolName} is a MUTATING tool and is disabled on this bridge (P-004, read-only MCP). It writes files directly, bypassing the PreToolUse lock arbitration that keeps this shared tree safe. Use Edit/Write for file changes.`
      );
    }
    if (toolName === "query") {
      throw new Error(
        "gitnexus.query is unavailable and was not dispatched (WI-35557, D-065): current live probes SIGSEGV the shared GitNexus MCP process; historical builds returned empty or unranked noise. Use gitnexus.context for a known symbol, graph:query for callers/callees/topology, or rg for keywords."
      );
    }
    const rawArgs = input ?? {};
    const args = acceptsRepo ? applyRepoPolicy(toolName, rawArgs, repoPolicyFromEnv()) : rawArgs;
    const workspaceId = ctx.workspaceId ?? "default";
    const handle = await ensureChild(workspaceId);
    bumpIdle(handle);
    ctx.progress?.(0, `forwarding to gitnexus.${toolName}`);
    const r = await rpc(handle, "tools/call", { name: toolName, arguments: args });
    if (r.error) {
      throw new Error(`gitnexus.${toolName}: ${r.error.message}`);
    }
    ctx.progress?.(100, "done");
    return decorateResult(r.result, loadFreshness());
  };
}
var plugin = {
  kind: "plugin",
  name: "@papercupai/gitnexus-bridge",
  version: "0.1.0",
  papercusp: "^0.1.0",
  description: "Proxies GitNexus MCP tools (code-graph queries) into the Papercusp tool registry.",
  // Cold start (first `gitnexus mcp` spawn + loading a large code-graph index)
  // can exceed the loader's default 10s discovery budget, tripping it → 0 tools
  // + a load error. The warm handshake is sub-second; this headroom covers the
  // cold case. (revive-plugin-system-2026-06-04 D-003.)
  discoveryTimeoutMs: 3e4,
  capabilities: [
    "compute:exec:gitnexus",
    "tools:gitnexus:list_repos",
    "tools:gitnexus:query",
    "tools:gitnexus:cypher",
    "tools:gitnexus:context",
    "tools:gitnexus:detect_changes",
    // `tools:gitnexus:rename` and `tools:gitnexus:group_sync` are deliberately ABSENT:
    // both are mutating and are refused by MUTATING_TOOLS (P-004 read-only enforcement).
    // A declared capability that can no longer be exercised makes the audit surface read
    // wider than the code actually is.
    "tools:gitnexus:impact",
    "tools:gitnexus:route_map",
    "tools:gitnexus:tool_map",
    "tools:gitnexus:shape_check",
    "tools:gitnexus:api_impact",
    "tools:gitnexus:group_list"
  ],
  async getDynamicTools() {
    const handle = await ensureChild("default");
    const upstream = await listUpstreamTools(handle);
    const definitions = [];
    const handlers = {};
    for (const t of upstream) {
      if (!isReadOnlyTool(t.name)) {
        continue;
      }
      const cap = `tools:gitnexus:${t.name}`;
      const override = TOOL_OVERRIDES[t.name];
      const def = {
        name: t.name,
        description: override?.description ?? t.description ?? `gitnexus.${t.name}`,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        capabilities: [cap, "compute:exec:gitnexus"],
        roles: rolesFor(t.name),
        rolesQuota: quotaFor(t.name),
        timeoutSec: 60,
        expose: {
          mcp: { name: `gitnexus.${t.name}`, largeOutput: t.name === "query" || t.name === "cypher" || t.name === "impact" },
          http: { path: `/api/plugins/gitnexus/${t.name}` }
        },
        ...override ? { guidance: override.guidance } : {}
      };
      definitions.push(def);
      const acceptsRepo = Boolean(
        t.inputSchema?.properties?.repo
      );
      handlers[t.name] = makeHandler(t.name, acceptsRepo);
    }
    return { definitions, handlers };
  },
  async init(_ctx) {
  }
};
var index_default = plugin;
var tools = {};
function _resetChildrenForTests() {
  for (const h of children.values()) {
    clearTimeout(h.idleTimer);
    try {
      h.proc.kill("SIGKILL");
    } catch {
    }
  }
  children.clear();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FRESHNESS_STALE_MS,
  MUTATING_TOOLS,
  PINNED_GITNEXUS_VERSION,
  RESPONSE_BUDGET_CHARS,
  TOOL_OVERRIDES,
  _resetChildrenForTests,
  _resetFreshnessCacheForTests,
  applyRepoPolicy,
  applyResponseBudget,
  decorateResult,
  deriveFreshness,
  describeChildExit,
  formatFreshnessNote,
  gitnexusChildCwd,
  gitnexusMissingMessage,
  gitnexusPath,
  isReadOnlyTool,
  looksLikeEmptyResult,
  pinnedGitnexusBin,
  quotaFor,
  repoPolicyFromEnv,
  resolveGitnexusChildCwd,
  resolveGitnexusExecutable,
  rolesFor,
  tools
});

// --- export-shape interop (see gen-gitnexus-bridge-runtime.mjs) ---
// Builds a FRESH object rather than mutating the bundled plugin. esbuild
// exposes named exports as accessor properties, and some loaders (Vitest's
// module evaluator among them) surface the default export carrying those
// getter-only descriptors — assigning onto it throws at module-load time.
// Copying into a plain object sidesteps loader-dependent descriptors entirely.
{
  const __exported = module.exports;
  const __plugin = __exported.default;
  if (!__plugin || typeof __plugin !== 'object') {
    throw new Error('gitnexus-bridge runtime: expected a default plugin export');
  }
  const __final = Object.assign(
    Object.create(Object.getPrototypeOf(__plugin) || Object.prototype),
    __plugin,
  );
  for (const __k of Object.keys(__exported)) {
    if (__k !== 'default') __final[__k] = __exported[__k];
  }
  __final.default = __final;
  module.exports = __final;
}
