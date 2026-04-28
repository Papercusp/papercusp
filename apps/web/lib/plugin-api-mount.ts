/**
 * Phase 6b item 2 — apiRoutes mounting.
 *
 * Discovers loaded plugins on first call and mounts each plugin's
 * `apiRoutes` (a Hono app) at `/api/plugins/<plugin-name>`.
 *
 * The mount is idempotent and lazy: the first call to `mountPluginApiRoutes()`
 * does the discovery + mounting and caches a promise so subsequent calls
 * become no-ops. Failures during a single plugin's load are caught + logged
 * so a misbehaving plugin can't take down the whole API surface.
 *
 * Plugin authors expose `apiRoutes` in their manifest as a Hono app. The
 * SDK types this as `unknown` (to keep the SDK Hono-version-agnostic); we
 * duck-type at mount time and skip plugins that don't expose a Hono-shaped
 * route() / fetch() handler.
 */
import type { Hono } from 'hono';
import { loadPlugins, type LoadedPlugin } from '@papercusp/plugin-loader';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ApiRouteHandle {
  // Hono and Hono-compatible routers must implement at minimum `fetch`.
  fetch: (req: Request, ...rest: any[]) => Promise<Response> | Response;
}

function looksLikeHonoApp(x: unknown): x is ApiRouteHandle {
  return typeof x === 'object' && x !== null && typeof (x as any).fetch === 'function';
}

function discoverHarnessSlugs(): string[] {
  const harnessRoot = join(homedir(), '.papercusp', 'harnesses');
  if (!existsSync(harnessRoot)) return [];
  try {
    return readdirSync(harnessRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

let mountedPromise: Promise<{ mounted: number; skipped: number; errors: string[] }> | null = null;
let mountedCounts: { mounted: number; skipped: number; errors: string[] } | null = null;

export interface MountPluginApiRoutesOptions {
  /** Override the global-plugins discovery directory (tests). */
  globalPluginsDir?: string;
  /** Override the harness-slug list (tests). Defaults to scanning ~/.papercusp/harnesses. */
  harnessSlugs?: string[];
}

/**
 * Mount plugin apiRoutes onto the parent Hono app. Idempotent: safe to call
 * from multiple modules; only does work the first time per options snapshot.
 *
 * Resolves with a summary of what was mounted, what was skipped, and any
 * errors encountered. Always resolves — never rejects (errors are collected).
 */
export function mountPluginApiRoutes(parent: Hono<any, any, any>, opts: MountPluginApiRoutesOptions = {}): Promise<{ mounted: number; skipped: number; errors: string[] }> {
  if (mountedPromise) return mountedPromise;

  mountedPromise = (async () => {
    const errors: string[] = [];
    let mounted = 0;
    let skipped = 0;

    let discovered: { loaded: LoadedPlugin[]; errors: Array<{ error: string; path: string }> };
    try {
      discovered = await loadPlugins({
        globalPluginsDir: opts.globalPluginsDir,
        harnessSlugs: opts.harnessSlugs ?? discoverHarnessSlugs(),
      });
    } catch (e: any) {
      errors.push(`plugin discovery failed: ${e?.message ?? String(e)}`);
      const result = { mounted: 0, skipped: 0, errors };
      mountedCounts = result;
      return result;
    }

    for (const lp of discovered.loaded) {
      const apiRoutes = lp.plugin.apiRoutes;
      if (apiRoutes === undefined || apiRoutes === null) {
        skipped++;
        continue;
      }
      if (!looksLikeHonoApp(apiRoutes)) {
        errors.push(`plugin "${lp.plugin.name}" apiRoutes is not Hono-shaped (no .fetch); skipping`);
        skipped++;
        continue;
      }
      try {
        const safeName = lp.plugin.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        // Use Hono.mount() — accepts any fetch handler (including a real
        // Hono instance via its bound .fetch). Works for plugins that ship
        // Hono apps and plugins that ship custom Web-Fetch handlers alike.
        parent.mount(`/plugins/${safeName}`, apiRoutes.fetch.bind(apiRoutes) as any);
        mounted++;
      } catch (e: any) {
        errors.push(`plugin "${lp.plugin.name}" mount failed: ${e?.message ?? String(e)}`);
      }
    }

    for (const err of discovered.errors) {
      errors.push(`plugin discovery error at ${err.path}: ${err.error}`);
    }

    const result = { mounted, skipped, errors };
    mountedCounts = result;
    return result;
  })();

  return mountedPromise;
}

/** Inspector for tests / health endpoints — null until first mount completes. */
export function pluginApiRoutesStatus() {
  return mountedCounts;
}

/** Resets the cache. Tests use this to re-mount with different fixtures. */
export function _resetPluginApiRoutesForTests() {
  mountedPromise = null;
  mountedCounts = null;
}
