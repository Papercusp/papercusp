/**
 * Shared OMP inference-gateway `models.yml` builder.
 *
 * OMP carries routing in its per-session agent home rather than environment
 * variables. A pinned route includes `x-papercusp-account`; an auto route omits
 * that header and lets the gateway choose/fail over. Neither mode is emitted
 * unless the caller explicitly supplies a pin or `gatewayOn`.
 */

export type OmpGatewayProvider = 'anthropic' | 'openai';
export type OmpGatewayAccountProvider = 'claude' | 'codex';

export interface OmpGatewayModelRoute {
  /** Exact model id sent through the gateway after removing an OMP effort suffix. */
  modelId: string;
  gatewayProvider: OmpGatewayProvider;
  accountProvider: OmpGatewayAccountProvider;
}

export const OMP_GATEWAY_PLACEHOLDER_KEY = 'papercusp-gateway';
export const OMP_GATEWAY_PROVIDER_ID = 'papercusp-gateway';
export const OMP_MODELS_REL_PATH = '.omp/agent/models.yml';

const ACCOUNT_HEADER = 'x-papercusp-account';
const OWNER_HEADER = 'x-papercusp-owner';
const PRIORITY_HEADER = 'x-papercusp-priority';

const DEFAULT_MODELS: Record<OmpGatewayProvider, string[]> = {
  anthropic: ['claude-sonnet-4-6'],
  openai: ['gpt-5-codex'],
};

const PROVIDER_API: Record<OmpGatewayProvider, string> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
};

export interface OmpGatewayModelsConfigOpts {
  accountId?: string | null;
  /** Emit an unpinned gateway route for explicit auto mode. */
  gatewayOn?: boolean;
  provider: OmpGatewayProvider;
  ownerId?: string | null;
  priority?: string | null;
  port?: number;
  models?: string[];
}

export interface OmpGatewayModelsConfig {
  relPath: string;
  content: string;
  providerId: string;
  modelSelector: string;
  models: string[];
  headers: Record<string, string>;
  baseUrl: string;
}

export function ompProviderForAccountProvider(p: 'claude' | 'codex'): OmpGatewayProvider {
  return p === 'codex' ? 'openai' : 'anthropic';
}

const EFFORT_SUFFIXES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function modelIdWithoutEffort(value: string): string {
  const colon = value.lastIndexOf(':');
  if (colon < 0) return value;
  return EFFORT_SUFFIXES.has(value.slice(colon + 1).toLowerCase()) ? value.slice(0, colon) : value;
}

/**
 * Map an OMP model selector to a gateway wire and credential provider only when
 * the selector's ORIGINAL provider is known to speak that wire. Model ids alone
 * are insufficient: e.g. an amazon-bedrock Claude id is not interchangeable
 * with Anthropic /v1/messages, and silently stripping its provider changes the
 * requested model/account route.
 */
export function ompGatewayModelFromSpec(spec?: string | null): OmpGatewayModelRoute | null {
  const value = spec?.trim();
  if (!value) return null;

  const slash = value.indexOf('/');
  const provider = slash >= 0 ? value.slice(0, slash).trim().toLowerCase() : '';
  const modelId = modelIdWithoutEffort(slash >= 0 ? value.slice(slash + 1).trim() : value);
  if (!modelId) return null;

  if (provider === 'anthropic' || provider === 'claude-bridge') {
    return /^claude-/.test(modelId)
      ? { modelId, gatewayProvider: 'anthropic', accountProvider: 'claude' }
      : null;
  }
  if (provider === 'openai' || provider === 'openai-codex') {
    return { modelId, gatewayProvider: 'openai', accountProvider: 'codex' };
  }
  if (provider === OMP_GATEWAY_PROVIDER_ID) {
    if (/^claude-/.test(modelId)) {
      return { modelId, gatewayProvider: 'anthropic', accountProvider: 'claude' };
    }
    if (/^(?:gpt-|o\d)/.test(modelId)) {
      return { modelId, gatewayProvider: 'openai', accountProvider: 'codex' };
    }
    return null;
  }

  // Legacy role defaults may still be stored as a bare upstream id. Keep those
  // exact ids compatible without allowing a qualified foreign provider through.
  if (slash < 0 && /^claude-/.test(modelId)) {
    return { modelId, gatewayProvider: 'anthropic', accountProvider: 'claude' };
  }
  if (slash < 0 && /^(?:gpt-|o\d)/.test(modelId)) {
    return { modelId, gatewayProvider: 'openai', accountProvider: 'codex' };
  }
  return null;
}

export function ompModelIdFromSpec(spec?: string | null): string | null {
  return ompGatewayModelFromSpec(spec)?.modelId ?? null;
}

function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

function gatewayBaseUrl(provider: OmpGatewayProvider, port: number): string {
  const root = `http://127.0.0.1:${port}`;
  return provider === 'openai' ? `${root}/v1` : root;
}

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function ompGatewayModelsConfig(
  opts: OmpGatewayModelsConfigOpts,
): OmpGatewayModelsConfig | null {
  const accountId = opts.accountId?.trim();
  if (!accountId && !opts.gatewayOn) return null;

  const port = opts.port && opts.port > 0 ? opts.port : gatewayPort();
  const baseUrl = gatewayBaseUrl(opts.provider, port);
  const api = PROVIDER_API[opts.provider];
  const models = (opts.models?.length ? opts.models : DEFAULT_MODELS[opts.provider])
    .map((model) => model.trim())
    .filter(Boolean);
  const modelIds = models.length ? models : DEFAULT_MODELS[opts.provider];

  const headers: Record<string, string> = {};
  if (accountId) headers[ACCOUNT_HEADER] = accountId;
  const ownerId = opts.ownerId?.trim();
  if (ownerId) headers[OWNER_HEADER] = ownerId;
  const priority = opts.priority?.trim();
  if (priority) headers[PRIORITY_HEADER] = priority;

  const headerLines = Object.entries(headers).map(
    ([key, value]) => `      ${yamlString(key)}: ${yamlString(value)}`,
  );
  const headerBlock = headerLines.length ? ['    headers:', ...headerLines] : [];
  const modelLines = modelIds.flatMap((id) => [
    `      - id: ${yamlString(id)}`,
    `        name: ${yamlString(`Papercusp Gateway ${id}`)}`,
    `        api: ${api}`,
    '        input: [text]',
    '        contextWindow: 200000',
    '        maxTokens: 8192',
  ]);

  const content = [
    '# BEGIN PAPERCUSP_OMP_GATEWAY',
    '# Managed by @papercusp/orchestrator/omp-gateway-config.',
    '# The gateway strips the placeholder credential and injects the routed account OAuth.',
    'providers:',
    `  ${OMP_GATEWAY_PROVIDER_ID}:`,
    `    baseUrl: ${yamlString(baseUrl)}`,
    `    apiKey: ${yamlString(OMP_GATEWAY_PLACEHOLDER_KEY)}`,
    `    api: ${api}`,
    '    auth: apiKey',
    ...headerBlock,
    '    models:',
    ...modelLines,
    '# END PAPERCUSP_OMP_GATEWAY',
    '',
  ].join('\n');

  return {
    relPath: OMP_MODELS_REL_PATH,
    content,
    providerId: OMP_GATEWAY_PROVIDER_ID,
    modelSelector: `${OMP_GATEWAY_PROVIDER_ID}/${modelIds[0]}`,
    models: modelIds,
    headers,
    baseUrl,
  };
}
