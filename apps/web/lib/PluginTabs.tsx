/**
 * Phase 6b — <PluginTabs> client component.
 *
 * Drop-in surface for rendering dashboard tabs contributed by plugins.
 * Hosts integrate with:
 *
 *   <PluginTabs slug={harnessSlug} />
 *
 * The component fetches /api/plugins/<slug>/contributions on mount,
 * resolves each tab's (componentRoot, componentId) pair to a React.lazy
 * component, and renders them with a tab-strip UX.
 *
 * Lazy-loaded so the import cost of plugin code is paid only when the
 * user clicks a tab, not on initial dashboard render.
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import {
  fetchContributions,
  resolveComponent,
  type DashboardTabContribution,
} from './plugin-runtime';

interface PluginTabsProps {
  slug: string;
  /** Optional — additional props passed to each tab's component */
  componentProps?: Record<string, unknown>;
  /** Optional — placeholder shown while a tab is loading */
  fallback?: React.ReactNode;
}

export default function PluginTabs({ slug, componentProps, fallback }: PluginTabsProps) {
  const [tabs, setTabs] = useState<DashboardTabContribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchContributions(slug)
      .then((res) => {
        if (cancelled) return;
        setTabs(res.dashboardTabs);
        if (res.dashboardTabs.length > 0) setActive(res.dashboardTabs[0].id);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div role="alert" style={{ color: 'var(--sl-color-red, #c00)', padding: 8 }}>
        Plugin tabs failed to load: {error}
      </div>
    );
  }

  if (tabs === null) {
    return <div aria-busy>Loading plugin tabs…</div>;
  }

  if (tabs.length === 0) {
    return null;
  }

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];
  const ActiveComponent = resolveComponent(activeTab);

  return (
    <div className="plugin-tabs">
      <div role="tablist" aria-label="Plugin-contributed tabs" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--sl-color-hairline, #ccc)' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab.id;
          return (
            <button
              key={tab.pluginName + ':' + tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(tab.id)}
              style={{
                padding: '8px 12px',
                background: isActive ? 'var(--sl-color-bg-accent, #e0e0e0)' : 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--sl-color-accent, #07b)' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {tab.label}
              <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                ({tab.pluginName})
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" style={{ padding: 12 }}>
        <Suspense fallback={fallback ?? <div aria-busy>Loading {activeTab.label}…</div>}>
          <ActiveComponent {...(componentProps ?? {})} />
        </Suspense>
      </div>
    </div>
  );
}
