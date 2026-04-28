/**
 * Phase 6b — plugin runtime: componentId → React component resolver.
 *
 * Phase 6a (server) exposes plugin manifests via /api/plugins/* with
 * componentRoot + componentId as strings. Phase 6b (this file) takes those
 * strings and produces actual React components at render time.
 *
 * v1 (build-time): componentRoot must be an npm-resolvable package name
 *   (workspace package or installed dep). Dynamic import + named-export
 *   lookup. Plugins must be in transpilePackages if they ship TS sources.
 *
 * v2 (iframe, deferred): same API, different loader — postMessage RPC to
 *   a CDN-hosted iframe instead of in-process import. See spec §8.6.
 */
import type { ComponentType } from 'react';
import { lazy } from 'react';

export interface ComponentRef {
  /** npm package name (e.g. '@restart/papercup-shared') */
  componentRoot: string;
  /** Named export within that module (e.g. 'DirectivesView') */
  componentId: string;
}

/**
 * Pattern 1 — a plugin tab can ship as either an in-process React component
 * (componentRoot + componentId) or an iframe URL. PluginTabs picks the
 * render mode at component-mount time based on which is present.
 *
 * If both are set, the host prefers iframeUrl (cheaper to validate at
 * runtime; no rebuild required to update). `replaces` lets a plugin tab
 * supersede a built-in dashboard tab id (docs/vscode/pi/etc.); the
 * dashboard hides the built-in version when a replacement is present.
 */
export interface DashboardTabContribution {
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
  componentRoot?: string;
  componentId?: string;
  iframeUrl?: string;
  replaces?: string[];
}

export interface SidebarItemContribution {
  pluginName: string;
  id: string;
  label: string;
  href: string;
  icon?: string;
}

export interface RouteContribution extends ComponentRef {
  pluginName: string;
  slug: string;
  label: string;
  icon?: string;
}

export interface ContributionsResponse {
  project: { slug: string; path: string | null };
  dashboardTabs: DashboardTabContribution[];
  sidebarItems: SidebarItemContribution[];
  routes: RouteContribution[];
}

/**
 * Fetch contributions for a project slug from the host's /api/plugins endpoint.
 *
 * Designed to be called from React Server Components or client-side fetchers.
 * On the server, callers can pass an absolute URL; on the client, a relative
 * path resolves against the current origin.
 */
export async function fetchContributions(
  slug: string,
  baseUrl: string = '',
): Promise<ContributionsResponse> {
  const url = `${baseUrl}/api/plugins/${encodeURIComponent(slug)}/contributions`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`fetchContributions(${slug}): ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ContributionsResponse;
}

/**
 * Resolve a (componentRoot, componentId) pair to a React.lazy()-wrapped
 * component, suitable for use inside <Suspense>.
 *
 * Caches per (componentRoot, componentId) so the same plugin tab rendered
 * twice doesn't trigger two dynamic imports.
 */
const cache = new Map<string, ComponentType<unknown>>();

export function resolveComponent(ref: ComponentRef): ComponentType<unknown> {
  const key = `${ref.componentRoot}#${ref.componentId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const Component = lazy(async () => {
    let mod: Record<string, unknown>;
    try {
      // Dynamic import — webpack/turbopack will resolve componentRoot at
      // build time IF it's listed in transpilePackages or is a regular dep.
      // Plain runtime dynamic-import without bundler help only works for
      // packages already present in node_modules.
      mod = (await import(/* webpackIgnore: true */ ref.componentRoot)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `resolveComponent: failed to import componentRoot "${ref.componentRoot}". ` +
          `Plugin must be in transpilePackages or installed as a dep. Original: ${String(err)}`,
      );
    }
    const exported = mod[ref.componentId];
    if (typeof exported !== 'function') {
      const available = Object.keys(mod).filter((k) => typeof mod[k] === 'function');
      throw new Error(
        `resolveComponent: "${ref.componentId}" is not an exported function in "${ref.componentRoot}". ` +
          `Available named exports: ${available.join(', ') || '(none)'}`,
      );
    }
    return { default: exported as ComponentType<unknown> };
  });

  cache.set(key, Component);
  return Component;
}

/**
 * Test-only: clear the resolver cache. Use sparingly — production code
 * should never need to evict.
 */
export function _resetCacheForTests(): void {
  cache.clear();
}
