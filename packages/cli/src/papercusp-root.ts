/**
 * Single source of truth for the CLI's "Papercusp root" path.
 *
 * The substrate moved from ~/.papercusp/ to per-workspace storage at
 * ~/.papercusp-workspaces/<id>/.papercusp/. Callers should never join
 * `homedir() + '.papercusp'` directly — use {@link papercuspRoot} so the
 * workspace migration stays transparent.
 *
 * Resolution order:
 *   1. PAPERCUSP_HOME env var (escape hatch)
 *   2. Active workspace per ~/.papercusp-workspaces/registry.json `current`
 *   3. Default workspace (~/.papercusp-workspaces/default/.papercusp)
 *   4. Legacy ~/.papercusp/ (pre-workspaces installs)
 *
 * Cached for the process lifetime.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | null = null;

export function papercuspRoot(): string {
  if (cached) return cached;
  cached = resolve();
  return cached;
}

/** Test-only: clear the cache so a different env can be picked up. */
export function _resetPapercuspRootForTests(): void {
  cached = null;
}

function resolve(): string {
  if (process.env.PAPERCUSP_HOME) return process.env.PAPERCUSP_HOME;

  const wsIndex = join(homedir(), '.papercusp-workspaces', 'registry.json');
  if (existsSync(wsIndex)) {
    try {
      const parsed = JSON.parse(readFileSync(wsIndex, 'utf8')) as { current?: string };
      if (parsed.current) {
        const cand = join(homedir(), '.papercusp-workspaces', parsed.current, '.papercusp');
        if (existsSync(cand)) return cand;
      }
    } catch { /* fall through */ }
  }

  const def = join(homedir(), '.papercusp-workspaces', 'default', '.papercusp');
  if (existsSync(def)) return def;

  return join(homedir(), '.papercusp');
}

/** Convenience for "give me a path under the papercusp root". */
export function papercuspPath(...parts: string[]): string {
  return join(papercuspRoot(), ...parts);
}
