/**
 * Papercusp MCP server — read-only harness introspection.
 *
 * Exposes 7 tools matching the pi/omp extension: status, list_features,
 * lineage, audit, proposals, decisions, issues. The omp client adds an
 * `mcp_<server>_<tool>` prefix automatically, so the LLM sees:
 *   mcp_papercusp_status, mcp_papercusp_list_features, etc.
 *
 * Configured per-harness via env vars set by the papercusp sidecar when it
 * spawns omp:
 *   PAPERCUSP_HARNESS_SLUG  — required
 *   PAPERCUSP_API_BASE      — defaults to http://127.0.0.1:3055
 *
 * v1 is read-only by design. Mutating tools (post comment, fire event,
 * accept proposal) want explicit user-confirmation UI before they exist.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const apiBase = () => process.env.PAPERCUSP_API_BASE ?? 'http://127.0.0.1:3055';
const harnessSlug = () => {
  const v = process.env.PAPERCUSP_HARNESS_SLUG;
  return v && v.length > 0 ? v : null;
};

async function getJson(path) {
  const slug = harnessSlug();
  if (!slug) {
    throw new Error(
      'PAPERCUSP_HARNESS_SLUG not set — papercusp tools require running inside a harness pty. ' +
        'If you launched omp manually outside the papercusp dashboard, these tools are unavailable.',
    );
  }
  const url = `${apiBase()}/api/harness/${encodeURIComponent(slug)}${path}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} from ${url}`);
  return await r.json();
}

const tools = [
  {
    name: 'status',
    description:
      'Get the current papercusp harness mission status. Returns counts (features by status), iteration number, last orchestrator decision, mission cost USD, and active competitions. Use when the user asks "where is the harness now?" or "what is the harness doing?".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => await getJson('/status'),
  },
  {
    name: 'list_features',
    description:
      'List all features in the harness, optionally filtered by status. Each feature has feature_id, title, status, summary, attempts, claims, expected_cost_cents, and tags. Use to find features in a specific state ("which features are stuck?").',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: todo, in_progress, passed, failed, blocked, etc. Omit to return all.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const data = await getJson('/status');
      let features = data?.features ?? [];
      if (args?.status) features = features.filter((f) => f.status === args.status);
      return features;
    },
  },
  {
    name: 'lineage',
    description:
      "Walk a feature's parent_id chain back up to the root goal. Returns the chain as a list of {level, kind, id, title}. Use to understand WHY a feature exists.",
    inputSchema: {
      type: 'object',
      properties: { feature_id: { type: 'string', description: 'Feature ID like F-042' } },
      required: ['feature_id'],
      additionalProperties: false,
    },
    handler: async (args) =>
      await getJson(`/feature/${encodeURIComponent(args.feature_id)}/lineage?format=json`),
  },
  {
    name: 'audit',
    description:
      'Get the audit log for a specific feature — every status transition, claim, attempt count change, with timestamps and actor. Use for debugging "why does feature F-X look like that?".',
    inputSchema: {
      type: 'object',
      properties: { feature_id: { type: 'string', description: 'Feature ID like F-042' } },
      required: ['feature_id'],
      additionalProperties: false,
    },
    handler: async (args) =>
      await getJson(`/features/${encodeURIComponent(args.feature_id)}/audit`),
  },
  {
    name: 'proposals',
    description:
      'List pending proposals from the scoper role. Each proposal is a not-yet-approved feature suggestion. Use to see what the scoper wants to work on next.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => await getJson('/proposals'),
  },
  {
    name: 'decisions',
    description:
      'Get recent orchestrator decisions — what role was dispatched, on what feature, with what outcome. Use to see "what has the orchestrator been doing?".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => await getJson('/decisions'),
  },
  {
    name: 'issues',
    description:
      "List open issues for the harness. Issues are user-reported or validator-detected problems waiting for resolution. Use to find what's broken or blocked.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => await getJson('/issues'),
  },
];

const toolsByName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'papercusp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = toolsByName.get(req.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `papercusp tool error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
