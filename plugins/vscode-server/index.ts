/**
 * @papercupai/vscode-server — embeds code-server as a harness dashboard tab.
 *
 * Reference plugin for spec §14.7 P5 — the smallest possible pilot. No
 * routines, no actions, no server runtime; just a single dashboardTab that
 * iframes the operator's local code-server install at the harness's project
 * directory.
 */
import type { Plugin } from '@papercusp/plugin-sdk';

// Tab rendering is driven by the manifest's `dashboardTabs[].iframeUrlConfigKey`
// (papercusp.json). See sibling notes in fumadocs/index.ts.
const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/vscode-server',
  version: '0.1.1',
  papercusp: '^0.1.0',
  description: 'Embed code-server as a dashboard tab.',
  capabilities: ['ui:dashboard-tab'],
};

export default plugin;
