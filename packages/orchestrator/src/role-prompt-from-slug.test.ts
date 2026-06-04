/**
 * Smoke tests for assembleRolePrompt(). The full prompt-build path is
 * already covered by prompt-build.test.ts; here we just verify the
 * slug-resolution + config-lookup wiring.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleRolePrompt, lookupProjectDir } from './role-prompt-from-slug.js';

function setupRegistry(): { home: string; projectDir: string; harnessDir: string; cleanup: () => void } {
  // Pin the operator-API base to a guaranteed-refused port so
  // lookupProjectDir's HTTP-first branch fails instantly and the test
  // exercises the legacy-file fallback it was written for. Without this,
  // a running dev operator at :3055 will respond too slowly and blow
  // vitest's 5s default timeout.
  process.env.PAPERCUSP_OPERATOR_BASE = 'http://127.0.0.1:1';
  const home = mkdtempSync(join(tmpdir(), 'role-prompt-'));
  const projectDir = join(home, 'project');
  const stateDir = join(projectDir, '.papercusp');
  const harnessDir = join(home, 'harness');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });

  // Minimal worker prompt.
  writeFileSync(
    join(harnessDir, 'prompts', 'worker.md'),
    '# WORKER\n\nDo your job.\n',
  );

  // Registry pointing the slug at the project dir.
  writeFileSync(
    join(home, '.restart-harness-projects.json'),
    JSON.stringify({ projects: [{ slug: 'demo', path: projectDir }] }),
  );

  return {
    home,
    projectDir,
    harnessDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('lookupProjectDir resolves a registered slug', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  process.env.HOME = setup.home;
  try {
    assert.equal(lookupProjectDir('demo'), setup.projectDir);
    assert.equal(lookupProjectDir('no-such'), null);
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    setup.cleanup();
  }
});

test('assembleRolePrompt produces a prompt that contains the role file + runtime context', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  const prevHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  process.env.HOME = setup.home;
  process.env.PAPERCUSP_HARNESS_DIR = setup.harnessDir;
  try {
    const result = assembleRolePrompt({
      slug: 'demo',
      role: 'worker',
      featureId: 'F-001',
      mode: 'chat',
    });
    assert.match(result.text, /Do your job\./);
    assert.match(result.text, /MODE=chat/);
    assert.match(result.text, /FEATURE_ID=F-001/);
    assert.match(result.text, /Runtime context/);
    assert.equal(result.meta.role, 'worker');
    assert.equal(result.meta.projectDir, setup.projectDir);
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevHarnessDir !== undefined) {
      process.env.PAPERCUSP_HARNESS_DIR = prevHarnessDir;
    } else {
      delete process.env.PAPERCUSP_HARNESS_DIR;
    }
    setup.cleanup();
  }
});

test('assembleRolePrompt throws on unknown slug', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  process.env.HOME = setup.home;
  try {
    assert.throws(
      () => assembleRolePrompt({ slug: 'no-such', role: 'worker' }),
      /not registered/,
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    setup.cleanup();
  }
});

test('assembleRolePrompt throws on unknown role', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  const prevHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  process.env.HOME = setup.home;
  process.env.PAPERCUSP_HARNESS_DIR = setup.harnessDir;
  try {
    assert.throws(
      () => assembleRolePrompt({ slug: 'demo', role: 'no-such-role' }),
      /no prompt file found/,
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevHarnessDir !== undefined) {
      process.env.PAPERCUSP_HARNESS_DIR = prevHarnessDir;
    } else {
      delete process.env.PAPERCUSP_HARNESS_DIR;
    }
    setup.cleanup();
  }
});
