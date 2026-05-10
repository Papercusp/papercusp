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

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  return { path, prior, backupPath };
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
