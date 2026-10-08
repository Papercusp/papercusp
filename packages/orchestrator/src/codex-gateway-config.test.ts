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
});
