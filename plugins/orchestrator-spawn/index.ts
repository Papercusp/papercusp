/**
 * @papercupai/orchestrator-spawn — Phase 9 spawn primitive.
 *
 * TS twin of index.cjs. The .cjs is the runtime artifact (Next-discoverable
 * via createRequire); this file is for type-checking + future-build
 * pipelines.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (Phase 9).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import type { Plugin, PluginToolMap, ToolHandler, ToolResult, AgentRole } from '@papercusp/plugin-sdk';

const ALLOWED: Record<string, AgentRole[]> = {
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

interface SpawnRecord {
  spawnId: string;
  parentSpawnId: string | null;
  parentRole: string;
  childRole: string;
  featureId: string | null;
  chunkId: string | null;
  runId: string;
  workspaceId: string;
  harnessSlug: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  abortController: AbortController;
  extras: string[];
  output: string | null;
  error: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

const spawns = new Map<string, SpawnRecord>();

function depthOf(parentSpawnId: string | null | undefined): number {
  let depth = 0;
  let cur: string | null | undefined = parentSpawnId ?? null;
  while (cur && depth <= MAX_DEPTH + 1) {
    const rec = spawns.get(cur);
    if (!rec) break;
    cur = rec.parentSpawnId;
    depth++;
  }
  return depth;
}

function countChildrenOf(parentSpawnId: string | null | undefined): number {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.parentSpawnId === parentSpawnId) n++;
  }
  return n;
}

function countConcurrent(): number {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.status === 'running') n++;
  }
  return n;
}

function harnessPackageDir(): string {
  return process.env.PAPERCUSP_HARNESS_DIR || join(homedir(), 'autonomous-harness');
}

function readPhaseFromConfig(stateDir: string): string {
  try {
    const cfgPath = join(stateDir, 'config.json');
    if (!existsSync(cfgPath)) return 'staging';
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return (cfg.phase as string) || 'staging';
  } catch { return 'staging'; }
}

function buildInvokeContext(toolCtx: any): any {
  const projectDir: string = toolCtx.projectDir;
  const stateDir: string = toolCtx.stateDir || join(projectDir, '.papercusp');
  return {
    harnessDir: harnessPackageDir(),
    projectDir,
    stateDir,
    logDir: join(stateDir, 'logs'),
    phase: readPhaseFromConfig(stateDir),
    claudeCmd: process.env.AGENT_CMD || process.env.CLAUDE || 'omp -p',
    agentBackend: 'omp',
    dept: '',
    log: () => {},
    workspaceId: toolCtx.workspaceId,
  };
}

async function loadOrchestrator(): Promise<{ invoke: (...args: unknown[]) => Promise<unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import('@papercusp/orchestrator')) as any;
}

const spawn: ToolHandler = async (input: any, ctx: any): Promise<ToolResult> => {
  const callerRole = ctx.role as string;
  const childRole = String(input?.role || '').trim();
  const allowed = ALLOWED[callerRole] || [];
  if (!allowed.includes(childRole as AgentRole)) {
    return errorResult('spawn_role_not_allowed',
      `Role "${callerRole}" cannot spawn "${childRole}". Allowed: ${allowed.length ? allowed.join(', ') : '(none)'}.`);
  }
  if (childRole === 'worker' && !input?.chunkId) {
    return errorResult('spawn_invalid_input', 'role="worker" requires chunkId.');
  }
  const depth = depthOf(ctx.spawnId);
  if (depth >= MAX_DEPTH) {
    return errorResult('spawn_depth_exceeded', `Spawn depth ${depth} >= cap ${MAX_DEPTH}.`);
  }
  const childCount = countChildrenOf(ctx.spawnId);
  if (childCount >= MAX_CHILDREN_PER_PARENT) {
    return errorResult('spawn_children_exceeded',
      `Parent already has ${childCount} children (cap ${MAX_CHILDREN_PER_PARENT}).`);
  }
  const concurrent = countConcurrent();
  if (concurrent >= MAX_CONCURRENT) {
    return errorResult('spawn_concurrent_exceeded',
      `${concurrent} spawns already running (cap ${MAX_CONCURRENT}).`);
  }
  const record: SpawnRecord = {
    spawnId: `s-${Date.now()}-${randomUUID().slice(0, 8)}`,
    parentSpawnId: ctx.spawnId || null,
    parentRole: callerRole,
    childRole,
    featureId: input?.featureId || null,
    chunkId: input?.chunkId || null,
    runId: ctx.runId,
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.harnessSlug,
    startedAtMs: Date.now(),
    finishedAtMs: null,
    status: 'running',
    abortController: new AbortController(),
    extras: Array.isArray(input?.extras) ? [...input.extras] : [],
    output: null,
    error: null,
    exitCode: null,
    durationMs: null,
  };
  spawns.set(record.spawnId, record);
  const invokeCtx = buildInvokeContext(ctx);
  const extras = [...record.extras];
  if (record.featureId) extras.push(`FEATURE_ID=${record.featureId}`);
  if (record.chunkId) extras.push(`CHUNK_ID=${record.chunkId}`);
  loadOrchestrator()
    .then(({ invoke }) => invoke(invokeCtx, childRole, extras, {
      parentSpawnId: record.spawnId,
      signal: record.abortController.signal,
    }))
    .then((result: any) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.exitCode = result?.exitCode ?? null;
      record.output = String(result?.output ?? '').slice(-2000);
      record.status = record.abortController.signal.aborted
        ? 'cancelled'
        : (result?.exitCode === 0 ? 'done' : 'failed');
    })
    .catch((err: unknown) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.error = err instanceof Error ? err.message : String(err);
      record.status = record.abortController.signal.aborted ? 'cancelled' : 'failed';
    });
  return { content: [{ type: 'text', text: JSON.stringify({
    spawnId: record.spawnId,
    childRole,
    parentSpawnId: record.parentSpawnId,
    status: 'running',
    startedAtMs: record.startedAtMs,
    depth: depth + 1,
  }, null, 2) }] };
};

function recordToView(rec: SpawnRecord) {
  return {
    spawnId: rec.spawnId, parentSpawnId: rec.parentSpawnId,
    parentRole: rec.parentRole, childRole: rec.childRole,
    featureId: rec.featureId, chunkId: rec.chunkId,
    runId: rec.runId, harnessSlug: rec.harnessSlug,
    status: rec.status, startedAtMs: rec.startedAtMs,
    finishedAtMs: rec.finishedAtMs, durationMs: rec.durationMs,
    exitCode: rec.exitCode, error: rec.error, output: rec.output,
  };
}

const poll: ToolHandler = async (input: any) => {
  const spawnId = String(input?.spawnId || '').trim();
  const rec = spawns.get(spawnId);
  if (!rec) return errorResult('spawn_not_found', `No spawn with id "${spawnId}".`);
  return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
};

const list_active: ToolHandler = async (input: any, ctx: any) => {
  const scope = input?.scope === 'all' ? 'all' : 'mine';
  const out: ReturnType<typeof recordToView>[] = [];
  for (const rec of spawns.values()) {
    if (rec.status !== 'running') continue;
    if (scope === 'mine' && rec.parentSpawnId !== ctx.spawnId) continue;
    out.push(recordToView(rec));
  }
  out.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return { content: [{ type: 'text', text: JSON.stringify({ spawns: out, count: out.length, scope }, null, 2) }] };
};

const cancel: ToolHandler = async (input: any, ctx: any) => {
  const spawnId = String(input?.spawnId || '').trim();
  const rec = spawns.get(spawnId);
  if (!rec) return errorResult('spawn_not_found', `No spawn with id "${spawnId}".`);
  const callerRole = ctx.role as string;
  const allowed = ALLOWED[callerRole] || [];
  if (!allowed.includes(rec.childRole as AgentRole)) {
    return errorResult('spawn_role_not_allowed',
      `Role "${callerRole}" cannot cancel a "${rec.childRole}" spawn.`);
  }
  if (rec.status !== 'running') {
    return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
  }
  rec.abortController.abort();
  rec.status = 'cancelled';
  return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
};

function errorResult(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }, null, 2) }] };
}

export const tools: PluginToolMap = { spawn, poll, list_active, cancel };

const plugin: Plugin = {
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

export default plugin;

/** Test-only. */
export function _resetSpawnsForTests(): void {
  for (const rec of spawns.values()) {
    try { rec.abortController.abort(); } catch { /* ignore */ }
  }
  spawns.clear();
}
