/**
 * @papercupai/pi-coding — embed the Pi coding-agent terminal.
 *
 * Reference plugin for spec §14.7 P7 — replaces the legacy hard-coded `pi`
 * tab on the harness dashboard. Activation is gated by the operator-controlled
 * PAPERCUSP_TABS_FROM_PLUGINS feature flag in the harness UI.
 */
import type { Plugin } from '@papercusp/plugin-sdk';
import PiTab from './tab';

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/pi-coding',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Pi coding-agent terminal as a dashboard tab.',
  capabilities: ['ui:dashboard-tab'],
  dashboardTabs: [
    {
      id: 'pi',
      label: 'Pi',
      icon: 'Terminal',
      component: PiTab,
    },
  ],
};

export default plugin;
