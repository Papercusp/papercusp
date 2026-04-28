/**
 * @papercupai/docs-viewer — embed the docs site as a harness dashboard tab.
 *
 * Reference plugin for spec §14.7 P7 — replaces the legacy hard-coded `docs`
 * tab. Activation gated by the PAPERCUSP_TABS_FROM_PLUGINS feature flag.
 */
import type { Plugin } from '@papercusp/plugin-sdk';

// Tab rendering is driven by the manifest's `dashboardTabs[].iframeUrlConfigKey`
// (papercusp.json). The runtime-loaded plugin model can't `import` a React
// component (Turbopack can't dynamic-import .tsx via createRequire), and the
// manifest's iframe pattern handles the docs-as-iframe case directly.
//
// `tab.tsx` is kept on disk for build-time hosts that resolve `componentId`
// against an in-host registry. For marketplace runtime install, it's unused.
const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/docs-viewer',
  version: '0.1.1',
  papercusp: '^0.1.0',
  description: 'Docs site embedded in a dashboard tab.',
  capabilities: ['ui:dashboard-tab'],
};

export default plugin;
