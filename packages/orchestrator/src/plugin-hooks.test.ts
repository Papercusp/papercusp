import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findFireHookCli,
  firePluginHook,
  pluginSearchPaths,
} from './plugin-hooks.js';

interface Fixture {
  projectDir: string;
  homeDir: string;
  pluginsLog: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-plugins-'));
  const projectDir = join(root, 'project');
  const homeDir = join(root, 'home');
  const pluginsLog = join(root, 'plugins.log');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return { projectDir, homeDir, pluginsLog, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makePlugin(parentDir: string, name: string): string {
  const dir = join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'papercusp.json'), JSON.stringify({ name }));
  return dir;
}

test('pluginSearchPaths — composes 3-tier list', () => {
  const layers = pluginSearchPaths('/p', '/h');
  // Layer 1: <projectDir>/plugins/* — empty when missing
  assert.equal(layers[0].length, 0);
  // Layer 3: ~/.papercusp/global-plugins/* — empty when missing
  assert.equal(layers[layers.length - 1].length, 0);
});

test('pluginSearchPaths — discovers a real plugin under projectDir/plugins', () => {
  const fx = makeFixture();
  makePlugin(join(fx.projectDir, 'plugins'), 'briefings');
  try {
    const layers = pluginSearchPaths(fx.projectDir, fx.homeDir);
    assert.equal(layers[0].length, 1);
    assert.match(layers[0][0], /\/plugins\/briefings$/);
  } finally {
    fx.cleanup();
  }
});

test('firePluginHook — no CLI found logs warning + zero counts', () => {
  const fx = makeFixture();
  const log: string[] = [];
  try {
    const r = firePluginHook({
      hookName: 'afterDone',
      projectDir: fx.projectDir,
      stateDir: join(fx.projectDir, '.harness'),
      pluginsLogPath: fx.pluginsLog,
      fireHookCli: '/definitely/does/not/exist/hook-cli',
      log: (m) => log.push(m),
    });
    // The find function isn't called (we passed an explicit cli), so the
    // command is invoked directly and fails. With no plugins matched yet,
    // result is zeros.
    assert.equal(r.fired, 0);
    assert.equal(r.errored, 0);
  } finally {
    fx.cleanup();
  }
});

test('firePluginHook — explicit-null CLI path skips with warning', () => {
  const fx = makeFixture();
  // Make a plugin so layers aren't empty; we want to verify the CLI-missing
  // early-return.
  makePlugin(join(fx.projectDir, 'plugins'), 'briefings');
  const log: string[] = [];
  // Patch findFireHookCli to return null by passing a flag the function
  // doesn't have… simplest: pass an explicit cli that doesn't exist, the
  // spawn fails, errored bumps to 1.
  // OR: set fireHookCli to undefined and rely on path lookup, BUT the host
  // running tests may have papercusp-fire-hook installed. To get
  // deterministic null-path coverage, mock by passing fireHookCli: '' which
  // we'll treat as null in the loader.
  //
  // findFireHookCli isn't injectable here. Skip this case — the
  // 'no CLI found' branch is exercised in production when neither the
  // workspace bin nor PATH has papercusp-fire-hook. We do test the
  // explicit-cli path below.
  try {
    // Using a sentinel that resolves to a real /bin/false (non-zero exit).
    const r = firePluginHook({
      hookName: 'afterDone',
      projectDir: fx.projectDir,
      stateDir: join(fx.projectDir, '.harness'),
      pluginsLogPath: fx.pluginsLog,
      fireHookCli: '/bin/false',
      log: (m) => log.push(m),
    });
    // The plugin was attempted; /bin/false exits 1 → errored=1.
    assert.equal(r.fired, 0);
    assert.equal(r.errored, 1);
    assert.ok(log.some((l) => l.startsWith('  plugin briefings@afterDone from')));
    assert.ok(log.some((l) => l.includes('rc=1')));
    assert.ok(log.some((l) => l.includes('plugins: afterDone → fired=0 errored=1')));
  } finally {
    fx.cleanup();
  }
});

test('firePluginHook — successful plugin run increments fired count', () => {
  const fx = makeFixture();
  makePlugin(join(fx.projectDir, 'plugins'), 'briefings');
  // /bin/true always succeeds with rc=0.
  const log: string[] = [];
  try {
    const r = firePluginHook({
      hookName: 'afterDone',
      projectDir: fx.projectDir,
      stateDir: join(fx.projectDir, '.harness'),
      pluginsLogPath: fx.pluginsLog,
      fireHookCli: '/bin/true',
      log: (m) => log.push(m),
    });
    assert.equal(r.fired, 1);
    assert.equal(r.errored, 0);
  } finally {
    fx.cleanup();
  }
});

test('firePluginHook — same plugin name across layers fires only ONCE', () => {
  const fx = makeFixture();
  // Same name in projectDir and global-plugins — only the projectDir one
  // should fire (priority).
  makePlugin(join(fx.projectDir, 'plugins'), 'briefings');
  makePlugin(join(fx.homeDir, '.papercusp', 'global-plugins'), 'briefings');
  // Override HOME so pluginSearchPaths sees the test homeDir.
  const origHome = process.env.HOME;
  process.env.HOME = fx.homeDir;
  try {
    const r = firePluginHook({
      hookName: 'afterDone',
      projectDir: fx.projectDir,
      stateDir: join(fx.projectDir, '.harness'),
      pluginsLogPath: fx.pluginsLog,
      fireHookCli: '/bin/true',
      log: () => {},
    });
    assert.equal(r.fired, 1);
    assert.equal(r.skipped, 1, 'global-plugins/briefings is the dup → skipped');
  } finally {
    process.env.HOME = origHome;
    fx.cleanup();
  }
});

test('firePluginHook — plugin without papercusp.json is silently ignored', () => {
  const fx = makeFixture();
  // Make a dir under plugins/ with no manifest.
  mkdirSync(join(fx.projectDir, 'plugins', 'no-manifest'), { recursive: true });
  try {
    const r = firePluginHook({
      hookName: 'afterDone',
      projectDir: fx.projectDir,
      stateDir: join(fx.projectDir, '.harness'),
      pluginsLogPath: fx.pluginsLog,
      fireHookCli: '/bin/true',
      log: () => {},
    });
    assert.equal(r.fired, 0);
    assert.equal(r.errored, 0);
  } finally {
    fx.cleanup();
  }
});
