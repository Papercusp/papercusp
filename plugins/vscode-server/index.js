"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Tab rendering is driven by the manifest's `dashboardTabs[].iframeUrlConfigKey`
// (papercusp.json). See sibling notes in fumadocs/index.ts.
const plugin = {
    kind: 'plugin',
    name: '@papercupai/vscode-server',
    version: '0.1.2',
    papercusp: '^0.1.0',
    description: 'Embed code-server as a dashboard tab.',
    capabilities: ['ui:dashboard-tab'],
};
exports.default = plugin;
