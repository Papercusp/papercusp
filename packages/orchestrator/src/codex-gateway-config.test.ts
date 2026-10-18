import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexGatewayConfigToml, codexManagedFeaturesToml, publishCodexConfig } from './codex-gateway-config';

const publicationFault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (publicationFault.partialWrite) {
      actual.writeFileSync(args[0], String(args[1]).slice(0, 5), args[2]);
      throw new Error('injected partial config write');
    }
    return actual.writeFileSync(...args);
  } };
});

describe('publishCodexConfig', () => {
  it('publishes a private replacement without changing bytes held by an existing reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-config-publication-'));
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'model = "prior"\n', { mode: 0o644 });
    const reader = openSync(path, 'r');
    try {
      publishCodexConfig(path, 'model = "next"\n');
      expect(readFileSync(reader, 'utf8')).toBe('model = "prior"\n');
      expect(readFileSync(path, 'utf8')).toBe('model = "next"\n');
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['config.toml']);
    } finally { closeSync(reader); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed output and cleans an interrupted staging write while preserving the live config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-config-publication-'));
    const path = join(dir, 'config.toml');
    const prior = 'model = "prior"\n';
    writeFileSync(path, prior);
    try {
      expect(() => publishCodexConfig(path, prior + '%3Fleftover')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(prior);
      publicationFault.partialWrite = true;
      expect(() => publishCodexConfig(path, 'model = "next"\n')).toThrow('injected partial config write');
      expect(readFileSync(path, 'utf8')).toBe(prior);
      expect(readdirSync(dir)).toEqual(['config.toml']);
    } finally {
      publicationFault.partialWrite = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  it('WI-6554700010009529: suppresses the RTK hook nag in every managed Codex home, before [features]', () => {
    for (const opts of [{}, { disableMemories: false }, { headless: true }]) {
      const config = codexManagedFeaturesToml(opts);
      const table = config.indexOf('[shell_environment_policy.set]');
      expect(table).toBeGreaterThan(-1);
      expect(config[table + 1]).toBe('RTK_SUPPRESS_HOOK_WARNING = "1"');
      expect(table).toBeLessThan(config.indexOf('[features]'));
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
