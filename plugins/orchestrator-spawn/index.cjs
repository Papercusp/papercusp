"use strict";
/**
 * @papercupai/orchestrator-spawn — Phase 9 spawn primitive.
 *
 * Lets one agent launch another via 4 tools: spawn / poll / list_active /
 * cancel. State lives in a module-level Map (lost on operator restart;
 * acceptable for v1). The actual child agent runs via the orchestrator's
 * `invoke()`, fired as a background Promise — `spawn` returns immediately
 * with a spawnId.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (Phase 9).
 *
 * Hand-written CommonJS; mirrored by index.ts. Edit both in lockstep.
 */

const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { existsSync, readFileSync } = require('node:fs');

/* ─── Allowlist + caps ────────────────────────────────────────────── */

const ALLOWED = {
  architect: ['worker', 'validator', 'scoper', 'reviewer', 'debugger'],
  operator: ['worker', 'validator', 'scoper', 'reviewer', 'debugger', 'documenter', 'curator', 'architect'],
  debugger: ['validator'],
  scoper: ['validator', 'reviewer'],
  reviewer: ['architect'],
  worker: [],
  validator: [],
  documenter: [],
  curator: [],
};

const MAX_DEPTH = 3;
const MAX_CHILDREN_PER_PARENT = 5;
const MAX_CONCURRENT = 10;

/* ─── State ────────────────────────────────────────────────────────── */

/** Map<spawnId, SpawnRecord> */
const spawns = new Map();

function depthOf(parentSpawnId) {
  // Walk parent chain via the Map; counts how many spawns are in our
  // own ancestry. Bounded at MAX_DEPTH+1 so a malformed loop can't blow
  // up. The recursive view in PG handles cross-restart depth; this
  // in-process check is the same-session-only guard.
  let depth = 0;
  let cur = parentSpawnId;
  while (cur && depth <= MAX_DEPTH + 1) {
    const rec = spawns.get(cur);
    if (!rec) break;
    cur = rec.parentSpawnId;
    depth++;
  }
  return depth;
}

function countChildrenOf(parentSpawnId) {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.parentSpawnId === parentSpawnId) n++;
  }
  return n;
}

function countConcurrent() {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.status === 'running') n++;
  }
  return n;
}

/* ─── InvokeContext construction ──────────────────────────────────── */

function harnessPackageDir() {
  const fromEnv = process.env.PAPERCUSP_HARNESS_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), 'autonomous-harness');
}

function readPhaseFromConfig(stateDir) {
  try {
    const cfgPath = join(stateDir, 'config.json');
    if (!existsSync(cfgPath)) return 'staging';
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return cfg.phase || 'staging';
  } catch { return 'staging'; }
}

function buildInvokeContext(toolCtx) {
  const projectDir = toolCtx.projectDir;
  const stateDir = toolCtx.stateDir || join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  return {
    harnessDir: harnessPackageDir(),
    projectDir,
    stateDir,
    logDir,
    phase: readPhaseFromConfig(stateDir),
    claudeCmd: process.env.AGENT_CMD || process.env.CLAUDE || 'omp -p',
    agentBackend: 'omp',
    dept: '',
    log: (msg) => { /* swallow inside plugin handler — agent stdout writes via run.log.jsonl */ },
    workspaceId: toolCtx.workspaceId,
  };
}

/* ─── Spawn engine ─────────────────────────────────────────────────── */

async function loadOrchestrator() {
  // The orchestrator package re-exports `invoke` from its root (no
  // `/invoke` subpath in package.json#exports). Next dev compiles
  // src/index.ts on demand.
  return await import('@papercusp/orchestrator');
}

function makeSpawnRecord(input, toolCtx, childRole) {
  const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    spawnId,
    parentSpawnId: toolCtx.spawnId || null,
    parentRole: toolCtx.role,
    childRole,
    featureId: input.featureId || null,
    chunkId: input.chunkId || null,
    runId: toolCtx.runId,
    workspaceId: toolCtx.workspaceId,
    harnessSlug: toolCtx.harnessSlug,
    startedAtMs: Date.now(),
    finishedAtMs: null,
    status: 'running',
    abortController: new AbortController(),
    extras: Array.isArray(input.extras) ? [...input.extras] : [],
    output: null,
    error: null,
    exitCode: null,
    durationMs: null,
  };
}

/* ─── Tool handlers ────────────────────────────────────────────────── */

async function spawn(input, ctx) {
  const callerRole = ctx.role;
  const childRole = String(input.role || '').trim();

  // 1. Allowlist
  const allowed = ALLOWED[callerRole] || [];
  if (!allowed.includes(childRole)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_role_not_allowed',
        message: `Role "${callerRole}" cannot spawn "${childRole}". Allowed: ${allowed.length ? allowed.join(', ') : '(none)'}.`,
      }, null, 2) }],
    };
  }

  // 2. Worker requires chunkId per the framework's quota window keying.
  if (childRole === 'worker' && !input.chunkId) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_invalid_input',
        message: 'role="worker" requires chunkId so the child\'s tool quotas window correctly.',
      }, null, 2) }],
    };
  }

  // 3. Depth cap (in-process portion; cross-restart depth comes from PG).
  const depth = depthOf(ctx.spawnId);
  if (depth >= MAX_DEPTH) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_depth_exceeded',
        message: `Spawn depth ${depth} >= cap ${MAX_DEPTH}. Cannot spawn another child from this lineage.`,
      }, null, 2) }],
    };
  }

  // 4. Per-parent cap.
  const childCount = countChildrenOf(ctx.spawnId);
  if (childCount >= MAX_CHILDREN_PER_PARENT) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_children_exceeded',
        message: `Parent already has ${childCount} children (cap ${MAX_CHILDREN_PER_PARENT}). Wait for some to finish or cancel before spawning more.`,
      }, null, 2) }],
    };
  }

  // 5. Global concurrency cap.
  const concurrent = countConcurrent();
  if (concurrent >= MAX_CONCURRENT) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_concurrent_exceeded',
        message: `${concurrent} spawns already running (cap ${MAX_CONCURRENT}). Wait or cancel.`,
      }, null, 2) }],
    };
  }

  // 6. Build the spawn record + InvokeContext + extras.
  const record = makeSpawnRecord(input, ctx, childRole);
  spawns.set(record.spawnId, record);

  const invokeCtx = buildInvokeContext(ctx);
  const extras = [...record.extras];
  if (record.featureId) extras.push(`FEATURE_ID=${record.featureId}`);
  if (record.chunkId) extras.push(`CHUNK_ID=${record.chunkId}`);

  // 7. Fire invoke() in the background. Don't await — return spawnId
  //    immediately. .then/.catch updates the record.
  loadOrchestrator()
    .then(({ invoke }) =>
      invoke(invokeCtx, childRole, extras, {
        parentSpawnId: record.spawnId, // child sees its own spawn id; PG records parent_spawn_id = our record's parentSpawnId via the URL chain
        signal: record.abortController.signal,
      }),
    )
    .then((result) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.exitCode = result?.exitCode ?? null;
      record.output = (result?.output ?? '').slice(-2000);
      record.status = record.abortController.signal.aborted
        ? 'cancelled'
        : (result?.exitCode === 0 ? 'done' : 'failed');
    })
    .catch((err) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.error = err instanceof Error ? err.message : String(err);
      record.status = record.abortController.signal.aborted ? 'cancelled' : 'failed';
    });

  return {
    content: [{ type: 'text', text: JSON.stringify({
      spawnId: record.spawnId,
      childRole,
      parentSpawnId: record.parentSpawnId,
      status: 'running',
      startedAtMs: record.startedAtMs,
      depth: depth + 1,
    }, null, 2) }],
  };
}

function recordToView(rec) {
  return {
    spawnId: rec.spawnId,
    parentSpawnId: rec.parentSpawnId,
    parentRole: rec.parentRole,
    childRole: rec.childRole,
    featureId: rec.featureId,
    chunkId: rec.chunkId,
    runId: rec.runId,
    harnessSlug: rec.harnessSlug,
    status: rec.status,
    startedAtMs: rec.startedAtMs,
    finishedAtMs: rec.finishedAtMs,
    durationMs: rec.durationMs,
    exitCode: rec.exitCode,
    error: rec.error,
    output: rec.output,
  };
}

async function poll(input, _ctx) {
  const spawnId = String(input.spawnId || '').trim();
  const rec = spawns.get(spawnId);
  if (!rec) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_not_found',
        message: `No spawn with id "${spawnId}" — either it predates this operator restart or never existed.`,
      }, null, 2) }],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
}

async function list_active(input, ctx) {
  const scope = (input && input.scope) === 'all' ? 'all' : 'mine';
  const out = [];
  for (const rec of spawns.values()) {
    if (rec.status !== 'running') continue;
    if (scope === 'mine' && rec.parentSpawnId !== ctx.spawnId) continue;
    out.push(recordToView(rec));
  }
  // Most recent first.
  out.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return {
    content: [{ type: 'text', text: JSON.stringify({ spawns: out, count: out.length, scope }, null, 2) }],
  };
}

async function cancel(input, ctx) {
  const spawnId = String(input.spawnId || '').trim();
  const rec = spawns.get(spawnId);
  if (!rec) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_not_found',
        message: `No spawn with id "${spawnId}".`,
      }, null, 2) }],
    };
  }

  // Same allowlist as spawn — if you can spawn the role, you can cancel
  // a running instance of it.
  const callerRole = ctx.role;
  const allowed = ALLOWED[callerRole] || [];
  if (!allowed.includes(rec.childRole)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_role_not_allowed',
        message: `Role "${callerRole}" cannot cancel a "${rec.childRole}" spawn. Allowed cancel targets: ${allowed.length ? allowed.join(', ') : '(none)'}.`,
      }, null, 2) }],
    };
  }

  if (rec.status !== 'running') {
    return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
  }

  rec.abortController.abort();
  // Status flips to 'cancelled' when the orchestrator's abort handler
  // resolves the promise; for poll() responses in the meantime we mark
  // it eagerly so consumers don't see a stale 'running'.
  rec.status = 'cancelled';
  return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
}

/* ─── Plugin export ────────────────────────────────────────────────── */

const tools = { spawn, poll, list_active, cancel };

const plugin = {
  kind: 'plugin',
  name: '@papercupai/orchestrator-spawn',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Phase 9 spawn primitive — agents spawning agents as a tool call.',
  capabilities: [
    'tools:orchestrator:spawn:worker',
    'tools:orchestrator:spawn:validator',
    'tools:orchestrator:spawn:scoper',
    'tools:orchestrator:spawn:reviewer',
    'tools:orchestrator:spawn:debugger',
    'tools:orchestrator:spawn:architect',
    'tools:orchestrator:spawn:documenter',
    'tools:orchestrator:spawn:curator',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = tools;

/** Test-only: drop all in-flight + finished spawns. */
module.exports._resetSpawnsForTests = function _resetSpawnsForTests() {
  for (const rec of spawns.values()) {
    try { rec.abortController.abort(); } catch { /* ignore */ }
  }
  spawns.clear();
};
// touch 1778408247
