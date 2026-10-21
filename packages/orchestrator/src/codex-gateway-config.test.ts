import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_MANAGED_MODEL_CATALOG_FILE,
  CODEX_MULTI_AGENT_CATALOG_FIELDS,
  CodexModelCatalogUnavailableError,
  codexGatewayConfigToml,
  codexManagedFeaturesToml,
  codexModelCatalogToml,
  materializeStrippedCodexModelCatalog,
  publishCodexConfig,
  stripCodexCatalogMultiAgent,
} from './codex-gateway-config';

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

// client-native-features-adoption-2026-10-21 P-001 (D-003/D-005): Codex native
// subagents and goals are off in every managed home.
describe('Codex native subagents and goals off by default', () => {
  it('codexManagedFeaturesToml turns native subagents and goals off in every variant', () => {
    for (const opts of [{}, { disableMemories: false }, { headless: true }, { disableMemories: false, headless: true }]) {
      const config = codexManagedFeaturesToml(opts);
      const features = config.indexOf('[features]');
      expect(features).toBeGreaterThan(-1);
      for (const line of ['multi_agent = false', 'goals = false']) {
        expect(config.filter((entry) => entry === line)).toHaveLength(1);
        expect(config.indexOf(line)).toBeGreaterThan(features);
      }
      expect(config.join('\n')).not.toMatch(/multi_agent\s*=\s*true|goals\s*=\s*true/);
    }
  });

  it('stripCodexCatalogMultiAgent removes both multi_agent fields from every model and leaves the input untouched', () => {
    const input = {
      fetched_at: '2026-10-21T00:00:00Z',
      models: [
        { slug: 'gpt-a', multi_agent_version: 'v2', multi_agent_reasoning_effort: 'low', context_window: 1 },
        { slug: 'gpt-b', multi_agent_version: 'v1' },
        { slug: 'gpt-c' },
      ],
    };
    const before = JSON.stringify(input);
    const stripped = stripCodexCatalogMultiAgent(input);
    expect(stripped.models).toEqual([{ slug: 'gpt-a', context_window: 1 }, { slug: 'gpt-b' }, { slug: 'gpt-c' }]);
    for (const model of stripped.models) {
      for (const field of CODEX_MULTI_AGENT_CATALOG_FIELDS) expect(model).not.toHaveProperty(field);
    }
    expect(stripped.fetched_at).toBe(input.fetched_at);
    expect(JSON.stringify(input)).toBe(before);
    expect(stripCodexCatalogMultiAgent({ notModels: true })).toEqual({ notModels: true });
  });

  it('materializeStrippedCodexModelCatalog prefers the newer cache, falls back to the bundled catalog, and refuses when no source exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-catalog-materialize-'));
    const codexHome = join(root, 'home');
    const userCodexHome = join(root, 'user');
    const cache = (slug: string, fetchedAt: string) => JSON.stringify({
      fetched_at: fetchedAt,
      models: [{ slug, multi_agent_version: 'v2', multi_agent_reasoning_effort: 'medium' }],
    });
    const readCatalog = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { models: Array<Record<string, unknown>> };
    const unexpectedBundled = () => { throw new Error('bundled catalog must not be read while a cache exists'); };
    const catalogPath = join(codexHome, CODEX_MANAGED_MODEL_CATALOG_FILE);
    try {
      mkdirSync(codexHome);
      mkdirSync(userCodexHome);

      // 1. Both caches present: the newer fetched_at wins, whichever home holds it.
      writeFileSync(join(codexHome, 'models_cache.json'), cache('home-model', '2026-10-01T00:00:00Z'));
      writeFileSync(join(userCodexHome, 'models_cache.json'), cache('user-model', '2026-10-20T00:00:00Z'));
      const fromUser = materializeStrippedCodexModelCatalog({ codexHome, userCodexHome, readBundledCatalog: unexpectedBundled });
      expect(fromUser).toMatchObject({
        path: catalogPath,
        source: 'user-cache',
        sourcePath: join(userCodexHome, 'models_cache.json'),
        modelCount: 1,
        fetchedAt: '2026-10-20T00:00:00Z',
      });
      expect(readCatalog(catalogPath).models).toEqual([{ slug: 'user-model' }]);
      if (process.platform !== 'win32') expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
      // The staging directory is gone; only the cache and the published catalog remain.
      expect(readdirSync(codexHome).sort()).toEqual([CODEX_MANAGED_MODEL_CATALOG_FILE, 'models_cache.json'].sort());

      writeFileSync(join(codexHome, 'models_cache.json'), cache('home-model', '2026-10-21T00:00:00Z'));
      const fromHome = materializeStrippedCodexModelCatalog({ codexHome, userCodexHome, readBundledCatalog: unexpectedBundled });
      expect(fromHome.source).toBe('home-cache');
      expect(readCatalog(catalogPath).models).toEqual([{ slug: 'home-model' }]);

      // 2. No usable cache (one absent, one with no models): the bundled catalog, stripped.
      rmSync(join(codexHome, 'models_cache.json'));
      writeFileSync(join(userCodexHome, 'models_cache.json'), JSON.stringify({ models: [] }));
      const bundled = JSON.stringify({ models: [{ slug: 'bundled-a', multi_agent_version: 'v2' }, { slug: 'bundled-b' }] });
      const fromBundled = materializeStrippedCodexModelCatalog({ codexHome, userCodexHome, readBundledCatalog: () => bundled });
      expect(fromBundled).toMatchObject({ source: 'bundled', sourcePath: null, modelCount: 2, fetchedAt: null });
      expect(readCatalog(catalogPath).models).toEqual([{ slug: 'bundled-a' }, { slug: 'bundled-b' }]);

      // 3. No source at all: refuse, naming every attempt, and publish nothing new.
      rmSync(catalogPath);
      let refusal: unknown = null;
      try {
        materializeStrippedCodexModelCatalog({
          codexHome,
          userCodexHome,
          readBundledCatalog: () => { throw new Error('codex: not installed\nsecond line'); },
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(CodexModelCatalogUnavailableError);
      expect((refusal as CodexModelCatalogUnavailableError).attempts).toEqual([
        'home-cache: absent',
        'user-cache: no models',
        'bundled: codex: not installed',
      ]);
      expect(existsSync(catalogPath)).toBe(false);
      expect(codexModelCatalogToml(catalogPath)).toEqual([`model_catalog_json = "${catalogPath}"`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
