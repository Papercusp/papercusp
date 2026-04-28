/**
 * Tests for plugin-cli.ts CI surfaces (--accept-defaults, --set, list).
 * Interactive prompt flows are not unit-tested — the smoke matrix covers them.
 *
 * Run: cd libs/papercusp/packages/cli && npx tsx --test src/plugin-cli.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cmdPluginEnable, cmdPluginDisable, cmdPluginConfig } from './plugin-cli.ts';

const HARNESS = `plugin-cli-test-${process.pid}`;
const SLUG = `pcli-fixture-${process.pid}`;
const ROOT = join(homedir(), '.papercusp');
const HARNESS_DIR = join(ROOT, 'harnesses', HARNESS);
const PLUGIN_DIR = join(ROOT, 'global-plugins', SLUG);
const ENABLED_PATH = join(HARNESS_DIR, 'enabled-plugins.json');
const CONFIG_PATH = join(HARNESS_DIR, 'plugin-configs', `${SLUG}.json`);

before(async () => {
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(
    join(PLUGIN_DIR, 'papercusp.json'),
    JSON.stringify(
      {
        name: SLUG,
        version: '0.1.0',
        kind: 'plugin',
        description: 'pcli test fixture',
        configSchema: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', default: 'acct-default' },
            verbose: { type: 'boolean', default: false },
            maxRetries: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
          },
        },
        defaultConfig: { accountId: 'acct-default', verbose: false, maxRetries: 3 },
      },
      null,
      2,
    ),
  );
});

after(async () => {
  await fs.rm(PLUGIN_DIR, { recursive: true, force: true });
  await fs.rm(HARNESS_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(HARNESS_DIR, { recursive: true, force: true });
});

describe('cmdPluginEnable --accept-defaults', () => {
  it('writes config from defaults and registers in enabled-plugins.json', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.equal(enabled.enabled[SLUG].version, '0.1.0');
    assert.match(enabled.enabled[SLUG].configHash, /^sha256-/);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.deepEqual(cfg, { accountId: 'acct-default', verbose: false, maxRetries: 3 });
  });

  it('exits non-zero for an unknown plugin slug', async () => {
    const exit = process.exit;
    let exitCode: number | null = null;
    (process as { exit: typeof process.exit }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('process.exit-stub');
    }) as typeof process.exit;
    try {
      await assert.rejects(
        () => cmdPluginEnable(['definitely-not-installed', '--harness', HARNESS, '--accept-defaults']),
      );
      assert.equal(exitCode, 1);
    } finally {
      (process as { exit: typeof process.exit }).exit = exit;
    }
  });
});

describe('cmdPluginDisable', () => {
  it('removes the entry but preserves config on disk', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginDisable([SLUG, '--harness', HARNESS]);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.equal(enabled.enabled[SLUG], undefined);
    assert.equal(existsSync(CONFIG_PATH), true);
  });

  it('is a no-op when not enabled', async () => {
    await fs.mkdir(HARNESS_DIR, { recursive: true });
    await fs.writeFile(ENABLED_PATH, JSON.stringify({ enabled: {} }));
    await cmdPluginDisable(['not-enabled', '--harness', HARNESS]);
    const enabled = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8'));
    assert.deepEqual(enabled.enabled, {});
  });
});

describe('cmdPluginConfig --set', () => {
  it('updates config keys and re-hashes', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    const before = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8')).enabled[SLUG].configHash;
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'accountId=acct-prod', '--set', 'verbose=true', '--set', 'maxRetries=7']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.deepEqual(cfg, { accountId: 'acct-prod', verbose: true, maxRetries: 7 });
    const after = JSON.parse(await fs.readFile(ENABLED_PATH, 'utf8')).enabled[SLUG].configHash;
    assert.notEqual(before, after);
  });

  it('coerces booleans + numbers correctly', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'maxRetries=42', '--set', 'verbose=false']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.equal(cfg.maxRetries, 42);
    assert.equal(cfg.verbose, false);
  });

  it('supports dotted keys for nested config', async () => {
    await cmdPluginEnable([SLUG, '--harness', HARNESS, '--accept-defaults']);
    await cmdPluginConfig([SLUG, '--harness', HARNESS, '--set', 'nested.key.path=hello']);
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    assert.equal((cfg.nested as { key: { path: string } }).key.path, 'hello');
  });
});
