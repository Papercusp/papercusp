import { afterEach, describe, expect, it } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from './codex-gateway-config';

const originalPort = process.env.PAPERCUSP_GATEWAY_PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = originalPort;
});

describe('codexGatewayConfigToml model discovery', () => {
  it('disables startup update dialogs before feature tables for every managed home', () => {
    for (const opts of [{}, { disableMemories: false }, { headless: true }]) {
      const config = codexManagedFeaturesToml(opts);
      expect(config).toContain('check_for_update_on_startup = false');
      expect(config.indexOf('check_for_update_on_startup = false')).toBeLessThan(config.indexOf('[features]'));
    }
  });

  it('enables custom-provider model discovery in every managed Codex home', () => {
    expect(codexManagedFeaturesToml()).toContain('api_key_model_discovery = true');
    expect(codexManagedFeaturesToml({ disableMemories: false })).toContain('api_key_model_discovery = true');
  });

  it('disables interactive plugin authentication only for headless managed homes', () => {
    expect(codexManagedFeaturesToml({ headless: true })).toEqual(expect.arrayContaining([
      'plugins = false',
      'auth_elicitation = false',
    ]));
    expect(codexManagedFeaturesToml()).not.toContain('plugins = false');
    expect(codexManagedFeaturesToml()).not.toContain('auth_elicitation = false');
  });

  it.each([
    ['auto', null, { gatewayOn: true }],
    ['pinned', 'chatgpt-a', {}],
  ] as const)('routes %s inference and the native model catalog through the same gateway', (_label, account, opts) => {
    process.env.PAPERCUSP_GATEWAY_PORT = '9876';
    const config = codexGatewayConfigToml(account, opts);
    expect(config.tables).toContain('base_url = "http://127.0.0.1:9876/v1"');
    expect(config.tables).toContain('model_catalog_url = "http://127.0.0.1:9876/v1/models"');
    expect(config.tables).toContain('requires_openai_auth = false');
    expect(config.tables.join('\n')).toContain('"originator" = "codex_cli_rs"');
  });

  it('does not override model discovery for the default account that bypasses the gateway', () => {
    expect(codexGatewayConfigToml(null)).toEqual({ root: [], tables: [] });
  });

  it('isolates simultaneous private routes from the ambient gateway and from each other', () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '9876';
    const a = { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) };
    const b = { baseURL: 'http://127.0.0.1:32102', token: 'b'.repeat(64) };
    const render = (gateway: typeof a) => codexGatewayConfigToml(null, { gateway }).tables.join('\n');
    const first = render(a), second = render(b);
    a.baseURL = b.baseURL;
    expect(first).toContain('http://127.0.0.1:32101/v1/models');
    expect(first).toContain(`experimental_bearer_token = "${'a'.repeat(64)}"`);
    expect(first).not.toContain('32102');
    expect(second).toContain('http://127.0.0.1:32102/v1');
    expect(second).not.toContain('9876');
    expect(process.env.PAPERCUSP_GATEWAY_PORT).toBe('9876');
  });

  it.each(['https://127.0.0.1:32101', 'http://localhost:32101', 'http://127.0.0.1',
    'http://127.0.0.1:32101/v1', 'http://127.0.0.1:32101?x=1', 'http://user@127.0.0.1:32101'])
  ('refuses invalid explicit routes without default fallback: %s', baseURL => {
    expect(() => codexGatewayConfigToml(null, { gateway: { baseURL, token: 'a'.repeat(64) } })).toThrow(/scoped/);
  });

  it('refuses a weak or injectable private token', () => {
    for (const token of ['papercusp-gateway', 'a'.repeat(64) + '\n', 'a'.repeat(64) + '"']) {
      expect(() => codexGatewayConfigToml('pool', { gateway: { baseURL: 'http://127.0.0.1:32101', token } })).toThrow(/scoped/);
    }
  });
});
