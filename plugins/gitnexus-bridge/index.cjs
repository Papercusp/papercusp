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
  PINNED_GITNEXUS_VERSION: () => PINNED_GITNEXUS_VERSION,
  TOOL_OVERRIDES: () => TOOL_OVERRIDES,
  _resetChildrenForTests: () => _resetChildrenForTests,
  default: () => index_default,
  gitnexusMissingMessage: () => gitnexusMissingMessage,
  gitnexusPath: () => gitnexusPath,
  pinnedGitnexusBin: () => pinnedGitnexusBin,
  quotaFor: () => quotaFor,
  resolveGitnexusExecutable: () => resolveGitnexusExecutable,
  rolesFor: () => rolesFor,
  tools: () => tools
});
module.exports = __toCommonJS(index_exports);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var import_node_fs = require("node:fs");
var IDLE_MS = 5 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 60 * 1e3;
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
    env: { ...process.env, PATH: gitnexusPath() }
  });
  const handle = {
    proc,
    pending: /* @__PURE__ */ new Map(),
    nextId: 1,
    buf: "",
    lastUseAt: Date.now(),
    idleTimer: setTimeout(() => {
    }, IDLE_MS)
  };
  proc.stdout.on("data", (chunk) => {
    handle.buf += chunk.toString("utf8");
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
  proc.on("close", () => {
    for (const p of handle.pending.values()) p.reject(new Error("gitnexus mcp process exited"));
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
  return ["operator", "architect", "reviewer", "debugger", "scoper", "worker", "validator"];
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
    description: "BROKEN as of WI-35557 (2026-08-09) \u2014 returns 0 results for every input, on every repo, always (upstream read-only-DB defect; a local fix was tried and confirmed to segfault the native binding, so it was reverted rather than shipped). Do NOT use for code search. Use `gitnexus.context` for an exact symbol you already have a name/uid for, or `grep -r`/`rg` for keyword search, until this is fixed.",
    guidance: {
      when: "Nothing right now \u2014 this tool is confirmed non-functional (WI-35557). Do not call it expecting real results.",
      notWhen: "Always, until WI-35557 is resolved. Use gitnexus.context (exact symbol) or grep -r/rg (keyword search) instead.",
      chaining: "N/A \u2014 see gitnexus.context for the working symbol-lookup path."
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
    description: "Fetch the full source and surrounding context for a specific symbol or file location the graph already identified (e.g. from a gitnexus.query/cypher result), without a manual file Read+offset.",
    guidance: {
      when: "After gitnexus.query or gitnexus.cypher returns a symbol/location and you need to read its actual source.",
      chaining: "Chain directly after gitnexus.query \u2014 its results are exactly this tool's input."
    }
  },
  impact: {
    description: 'Find every caller/consumer that would be affected by changing a given symbol \u2014 the blast-radius check before a rename, refactor, or deletion. Use INSTEAD of grep -r when you need to know "what would break" before a risky edit.',
    guidance: {
      when: 'Before renaming, refactoring, or deleting a symbol \u2014 "what depends on this", "what would break if I change X".',
      notWhen: "Not for exploring code you haven't decided to change yet \u2014 start with gitnexus.query."
    }
  }
};
function makeHandler(toolName) {
  return async (input, ctx) => {
    const workspaceId = ctx.workspaceId ?? "default";
    const handle = await ensureChild(workspaceId);
    bumpIdle(handle);
    ctx.progress?.(0, `forwarding to gitnexus.${toolName}`);
    const r = await rpc(handle, "tools/call", { name: toolName, arguments: input });
    if (r.error) {
      throw new Error(`gitnexus.${toolName}: ${r.error.message}`);
    }
    ctx.progress?.(100, "done");
    return r.result;
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
    "tools:gitnexus:rename",
    "tools:gitnexus:impact",
    "tools:gitnexus:route_map",
    "tools:gitnexus:tool_map",
    "tools:gitnexus:shape_check",
    "tools:gitnexus:api_impact",
    "tools:gitnexus:group_list",
    "tools:gitnexus:group_sync"
  ],
  async getDynamicTools() {
    const handle = await ensureChild("default");
    const upstream = await listUpstreamTools(handle);
    const definitions = [];
    const handlers = {};
    for (const t of upstream) {
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
      handlers[t.name] = makeHandler(t.name);
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
  PINNED_GITNEXUS_VERSION,
  TOOL_OVERRIDES,
  _resetChildrenForTests,
  gitnexusMissingMessage,
  gitnexusPath,
  pinnedGitnexusBin,
  quotaFor,
  resolveGitnexusExecutable,
  rolesFor,
  tools
});

// --- export-shape interop (see gen-gitnexus-bridge-runtime.mjs) ---
{
  const __exported = module.exports;
  const __plugin = __exported.default;
  if (!__plugin || typeof __plugin !== 'object') {
    throw new Error('gitnexus-bridge runtime: expected a default plugin export');
  }
  __plugin.default = __plugin;
  __plugin.tools = __exported.tools;
  for (const __k of Object.keys(__exported)) {
    if (__k !== 'default' && __k !== 'tools' && __plugin[__k] === undefined) {
      __plugin[__k] = __exported[__k];
    }
  }
  module.exports = __plugin;
}
