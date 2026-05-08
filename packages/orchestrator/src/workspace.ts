/**
 * Workspace resolution. The active workspace ID is the only piece of
 * orchestrator state that has to live on the filesystem before any DB
 * connection exists — chicken-and-egg: we can't query Postgres for "which
 * workspace are we in" without first knowing which DB to connect to.
 *
 * The registry at `~/.papercusp-workspaces/registry.json` is owned by
 * the operator (and the CLI's `papercusp workspace` commands). The
 * orchestrator only reads it; it never writes.
 *
 * Format mirrors `apps/operator/lib/workspace-registry.ts`:
 *   { current: 'default', workspaces: [{ id, name, dbName, ... }, ...] }
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_PATH = join(homedir(), '.papercusp-workspaces', 'registry.json');
const DEFAULT_WORKSPACE_ID = 'default';

interface WorkspaceRegistry {
  current?: string;
  workspaces?: Array<{ id: string; name?: string; dbName?: string }>;
}

/**
 * Returns the active workspace ID. Order of resolution:
 *   1. PAPERCUSP_WORKSPACE_ID env var (CLI/test override)
 *   2. registry.json `current` field
 *   3. 'default' fallback
 *
 * Synchronous + cached after first call. The registry is small and the
 * orchestrator queries it many times per run; cache amortizes I/O.
 */
let cached: string | null = null;

export function activeWorkspaceId(): string {
  if (cached !== null) return cached;
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim()) {
    cached = env.trim();
    return cached;
  }
  if (existsSync(REGISTRY_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as WorkspaceRegistry;
      if (typeof raw.current === 'string' && raw.current.trim()) {
        cached = raw.current.trim();
        return cached;
      }
    } catch {
      /* malformed registry — fall through to default */
    }
  }
  cached = DEFAULT_WORKSPACE_ID;
  return cached;
}

/** Test-only: clear the cache so platform/env mocks take effect. */
export function _resetActiveWorkspaceCache(): void {
  cached = null;
}
