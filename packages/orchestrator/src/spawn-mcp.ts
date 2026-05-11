/**
 * Per-spawn MCP config: write a `.mcp.json` so OMP discovers the
 * Papercusp MCP host with the seven per-spawn URL params baked in.
 *
 * OMP's MCP discovery is path-based (no env-var override exists for an
 * explicit MCP config path), so this module does the dance:
 *
 *   1. Save any existing `<cwd>/.mcp.json` to a sibling backup.
 *   2. Write our spawn-specific `.mcp.json`.
 *   3. After the spawn exits, delete ours and restore the backup.
 *
 * Workers running in parallel must use distinct cwds (worktrees) — two
 * spawns sharing a cwd would race-clobber each other's `.mcp.json`. The
 * orchestrator's existing branch-isolation worktree pattern provides
 * that automatically.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4: tool discovery
 * for OMP — single mcpServers entry, seven URL query params).
 */

import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

/** Construction inputs — all seven per-spawn URL params plus the host URL. */
export interface SpawnMcpConfigInput {
  /**
   * Base URL of the operator's MCP HTTP/SSE endpoint.
   * Default `http://localhost:3070/api/sse`. Override via the
   * `PAPERCUSP_OPERATOR_URL` env var if the operator runs on a
   * different host:port.
   */
  operatorUrl?: string;
  /** Harness slug. Required. */
  harnessSlug: string;
  /** Workspace ID. Required. */
  workspaceId: string;
  /** Calling agent role. Required. */
  role: string;
  /** Orchestrator run ID. Required. */
  runId: string;
  /** Unique per-spawn ID. Required. */
  spawnId: string;
  /** Feature ID, if the spawn is feature-scoped (workers, validators, debuggers). */
  featureId?: string | null;
  /** Chunk ID, if the spawn is chunk-scoped (worker chunks). */
  chunkId?: string | null;
  /** Parent spawn ID, set when this spawn was created by another agent's `orchestrator.spawn` call. */
  parentSpawnId?: string | null;
}

// Default port flips on NODE_ENV: dev operator runs on :3055, prod on :3070.
// Override with PAPERCUSP_OPERATOR_URL when neither default applies (CI,
// Tauri sidecar with custom port, etc).
const DEFAULT_OPERATOR_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:3055/api/sse'
    : 'http://localhost:3070/api/sse';

/** Build the JSON-serializable mcp.json contents for a spawn. */
export function buildSpawnMcpConfig(input: SpawnMcpConfigInput): {
  mcpServers: Record<string, { url: string }>;
} {
  const base = input.operatorUrl ?? process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL;
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  return {
    mcpServers: {
      papercusp: {
        url: `${base}?${params.toString()}`,
      },
    },
  };
}

const FILENAME = '.mcp.json';
const BACKUP_SUFFIX = '.papercusp.bak';

/**
 * Write a per-spawn `.mcp.json` to `cwd`, saving any existing file's
 * content. Returns a token the caller passes to `restoreSpawnMcp`.
 *
 * Writes are best-effort: if anything fails (permission, disk full),
 * we throw rather than silently spawn without our config — the agent
 * would then have built-in tools but no plugin tools, which is a
 * confusing partial state.
 */
export interface SpawnMcpHandle {
  /** Path of the written file. */
  path: string;
  /** Content of the file we displaced (null if there wasn't one). */
  prior: string | null;
  /** Path of our backup of the prior file (null if no prior). */
  backupPath: string | null;
}

export function writeSpawnMcp(cwd: string, input: SpawnMcpConfigInput): SpawnMcpHandle {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const config = buildSpawnMcpConfig(input);
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  // Mode 0600: stop a sibling worker on the same UID from `cat`-ing
  // this .mcp.json to steal the (signed, role-bearing) URL. Same-UID
  // root-equivalent code can still read it; this is friction, not
  // enforcement. See apps/operator/docs/spawn-signing-threat-model.md.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/**
 * Async variant — same as writeSpawnMcp but also signs the URL params
 * with the HMAC key stored at `harness_shared.operator_secrets`
 * (`spawn-signing-key`). Required by the operator's MCP route when
 * `PAPERCUSP_REQUIRE_SPAWN_SIG=1`; otherwise soft-warn but accept.
 *
 * Best-effort: if PG is unreachable or the key row is missing, falls
 * back to the unsigned URL and logs a warning. The operator side will
 * also warn — pair the two signals to spot transition issues.
 *
 * The operator subprocess that hosts the orchestrator inherits its
 * PG DSN via env (DATABASE_URL or PAPERCUSP_PG_DSN). If neither is
 * set we can't sign — that's the only case where we fall back.
 *
 * See: apps/operator/lib/spawn-signing.ts for the verification side.
 */
export async function writeSignedSpawnMcp(
  cwd: string,
  input: SpawnMcpConfigInput,
  opts: { ttlSec?: number } = {},
): Promise<SpawnMcpHandle> {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const base = input.operatorUrl ?? process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL;
  const params = buildSpawnUrlParams(input);
  try {
    await signSpawnParams(params, opts.ttlSec ?? 24 * 60 * 60);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[spawn-mcp] signing failed (${err instanceof Error ? err.message : String(err)}); ` +
        'emitting unsigned URL. Operator must be in soft-warn mode for this to work.',
    );
  }
  const config = {
    mcpServers: { papercusp: { url: `${base}?${params.toString()}` } },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/* ─── Signing (HMAC-SHA256 over canonical params) ─────────────────────
 * Duplicated in apps/operator/lib/spawn-signing.ts because the
 * orchestrator runs as a separate process and can't import from the
 * operator app directly. Keep the canonicalization rule in lockstep
 * with that file or signatures will mismatch.
 * ──────────────────────────────────────────────────────────────────── */

const SIGNED_PARAM_ALLOWLIST = new Set([
  'harness',
  'workspace',
  'role',
  'run',
  'spawn',
  'feature',
  'chunk',
  'parent_spawn',
  'client',
  'exp',
]);

interface KeyCache { buf: Buffer; rotatedAt: number; loadedAt: number; }
let __keyCache: KeyCache | null = null;

// Honor PG's authoritative rotated_at so a rotate on the operator
// invalidates this process's cache on its next read. Spawning is
// already a heavy op; one indexed PG read is in the noise. The
// 5-minute TTL is a safety net for when rotated_at can't be read.
async function loadSigningKey(): Promise<Buffer> {
  const dsn = process.env.DATABASE_URL ?? process.env.PAPERCUSP_PG_DSN;
  if (!dsn) throw new Error('no PG DSN in env (DATABASE_URL/PAPERCUSP_PG_DSN)');
  const sql = postgres(dsn);
  try {
    const rows = await sql<{ value_b64: string; rotated_at: Date }[]>`
      SELECT value_b64, rotated_at FROM harness_shared.operator_secrets
      WHERE name = 'spawn-signing-key' LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error('spawn-signing-key row missing — operator boots mint it on first verify call');
    }
    const rotatedAt = new Date(rows[0].rotated_at).getTime();
    if (
      __keyCache &&
      __keyCache.rotatedAt === rotatedAt &&
      Date.now() - __keyCache.loadedAt < 5 * 60 * 1000
    ) {
      return __keyCache.buf;
    }
    const buf = Buffer.from(rows[0].value_b64, 'base64');
    __keyCache = { buf, rotatedAt, loadedAt: Date.now() };
    return buf;
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

function canonicalizeForSign(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) throw new Error(`duplicate param: ${k}`);
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function signSpawnParams(params: URLSearchParams, ttlSec: number): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  params.set('exp', String(exp));
  params.delete('sig');
  const key = await loadSigningKey();
  const sig = createHmac('sha256', key).update(canonicalizeForSign(params)).digest('base64url');
  params.set('sig', sig);
}

function buildSpawnUrlParams(input: SpawnMcpConfigInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  return params;
}

/**
 * Restore the prior `.mcp.json` after a spawn completes (or errors).
 * Always called from a finally block so the user's existing config
 * survives spawn failures.
 *
 * Idempotent: safe to call multiple times. Best-effort cleanup —
 * surfacing a failure here would mask the real spawn error.
 */
export function restoreSpawnMcp(handle: SpawnMcpHandle): void {
  try {
    if (existsSync(handle.path)) {
      unlinkSync(handle.path);
    }
  } catch { /* ignore */ }
  if (handle.backupPath) {
    try {
      if (existsSync(handle.backupPath)) {
        renameSync(handle.backupPath, handle.path);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Extract the `CHUNK_ID=<id>` value from the extras array (mirroring
 * `extractFeatureId` in run-id.ts). Returns null if absent.
 *
 * extras looks like `['FEATURE_ID=F-AUTH-003', 'CHUNK_ID=ck_01HXV9Z']`
 * — the orchestrator main loop and chunk-loop-driver both pass them.
 */
export function extractChunkId(extras: readonly string[]): string | null {
  for (const e of extras) {
    if (e.startsWith('CHUNK_ID=')) return e.slice('CHUNK_ID='.length).trim() || null;
  }
  return null;
}
