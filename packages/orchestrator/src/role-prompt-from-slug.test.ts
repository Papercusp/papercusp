/**
 * Smoke tests for assembleRolePrompt(). The full prompt-build path is
 * already covered by prompt-build.test.ts; here we just verify the
 * slug-resolution + config-lookup wiring.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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
  const priorPromptRoot = process.env.PAPERCUSP_PROMPT_ROOT;
  // The running su environment points PAPERCUSP_INTEGRATION_ROOT at the real
  // repo. Pin the fixture above that fallback so these tests exercise it.
  process.env.PAPERCUSP_PROMPT_ROOT = harnessDir;
  mkdirSync(stateDir, { recursive: true });
  // Minimal worker prompt in the base role library (Phase 5: the resolver reads base,
  // not the deleted global prompts/ tier).
  mkdirSync(join(harnessDir, 'blueprints', 'base', 'prompts'), { recursive: true });
  writeFileSync(
    join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'),
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
    cleanup: () => {
      if (priorPromptRoot === undefined) delete process.env.PAPERCUSP_PROMPT_ROOT;
      else process.env.PAPERCUSP_PROMPT_ROOT = priorPromptRoot;
      rmSync(home, { recursive: true, force: true });
    },
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

test('assembleRolePrompt swaps TESTING→VERIFICATION standard from the harness blueprint acceptance (P-008)', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  const prevHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  process.env.HOME = setup.home;
  process.env.PAPERCUSP_HARNESS_DIR = setup.harnessDir;
  try {
    // Default (no .papercusp/blueprint.yaml ⇒ acceptance undefined) → the coding
    // TESTING_STANDARD ("write tests the project's way").
    const coding = assembleRolePrompt({ slug: 'demo', role: 'worker', mode: 'chat' });
    assert.match(coding.text, /Tests follow the project standard/);
    assert.doesNotMatch(coding.text, /Verify your work before calling it done/);

    // A generic-hive-style blueprint (acceptance.kind: judge) → the domain-agnostic
    // VERIFICATION_STANDARD, so a deliverable-producing role isn't told to write tests.
    writeFileSync(
      join(setup.projectDir, '.papercusp', 'blueprint.yaml'),
      [
        'id: generic-hive',
        'workItem: { kind: feature, idPrefix: F }',
        'spine: { decider: director, edges: { DONE: { to: done } }, default: { to: idle } }',
        'acceptance: { kind: judge }',
        '',
      ].join('\n'),
    );
    const generic = assembleRolePrompt({ slug: 'demo', role: 'worker', mode: 'chat' });
    assert.match(generic.text, /Verify your work before calling it done/);
    assert.doesNotMatch(generic.text, /Tests follow the project standard/);
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevHarnessDir !== undefined) process.env.PAPERCUSP_HARNESS_DIR = prevHarnessDir;
    else delete process.env.PAPERCUSP_HARNESS_DIR;
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

test('assembleRolePrompt resolves blueprint-aware, riding the harness\'s OWN blueprint.yaml id (work-item-chat-context-modernize P-002)', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  const prevHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  process.env.HOME = setup.home;
  process.env.PAPERCUSP_HARNESS_DIR = setup.harnessDir;
  try {
    // No .papercusp/blueprint.yaml ⇒ blueprintId undefined ⇒ unchanged [base]
    // resolution — byte-identical to a harness with no blueprint at all.
    const noBlueprint = assembleRolePrompt({ slug: 'demo', role: 'worker', mode: 'chat' });
    assert.match(noBlueprint.text, /Do your job\./);
    assert.equal(noBlueprint.meta.blueprintId, undefined);

    // A harness that DECLARES a blueprint (id: custom-hive) but whose blueprint
    // does not override `worker.md` still falls through to base/prompts/worker.md
    // — the chain is walked, base is just the final candidate — while meta now
    // correctly reports the resolved blueprintId (previously always undefined).
    writeFileSync(
      join(setup.projectDir, '.papercusp', 'blueprint.yaml'),
      ['id: custom-hive', 'workItem: { kind: feature, idPrefix: F }',
        'spine: { decider: director, edges: { DONE: { to: done } }, default: { to: idle } }',
        ''].join('\n'),
    );
    const fallenThrough = assembleRolePrompt({ slug: 'demo', role: 'worker', mode: 'chat' });
    assert.match(fallenThrough.text, /Do your job\./);
    assert.equal(fallenThrough.meta.blueprintId, 'custom-hive');

    // A harness whose blueprint OVERRIDES `worker.md` (a non-legacy-coding-spine
    // persona a harness without the coding spine would actually want) now gets
    // THAT file, never the legacy base/prompts/worker.md — this is the P-002 fix:
    // previously this override was silently ignored because no blueprintId was
    // ever threaded through, so every chat resolved through the bare [base] chain
    // no matter what the harness's own blueprint declared.
    mkdirSync(join(setup.harnessDir, 'blueprints', 'custom-hive', 'prompts'), { recursive: true });
    writeFileSync(
      join(setup.harnessDir, 'blueprints', 'custom-hive', 'blueprint.yaml'),
      'id: custom-hive\nextends: base\n',
    );
    writeFileSync(
      join(setup.harnessDir, 'blueprints', 'custom-hive', 'prompts', 'worker.md'),
      '# CUSTOM-HIVE WORKER\n\nNo SPEC.md ritual here.\n',
    );
    const overridden = assembleRolePrompt({ slug: 'demo', role: 'worker', mode: 'chat' });
    assert.match(overridden.text, /No SPEC\.md ritual here\./);
    assert.doesNotMatch(overridden.text, /Do your job\./);
    assert.equal(overridden.meta.blueprintId, 'custom-hive');
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevHarnessDir !== undefined) process.env.PAPERCUSP_HARNESS_DIR = prevHarnessDir;
    else delete process.env.PAPERCUSP_HARNESS_DIR;
    setup.cleanup();
  }
});

test('Papercusp operator role resolves the shared execution persona and declared write ceiling', () => {
  const harnessDir = fileURLToPath(new URL('../../harness/', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const priorHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  const priorPromptRoot = process.env.PAPERCUSP_PROMPT_ROOT;
  process.env.PAPERCUSP_HARNESS_DIR = harnessDir;
  process.env.PAPERCUSP_PROMPT_ROOT = harnessDir;
  try {
    const blueprint = parseYaml(readFileSync(join(repoRoot, '.papercusp/blueprint.yaml'), 'utf8')) as {
      roles: Array<{ id: string }>;
      fleet: { workerRoles: Array<{ id: string; capabilities: string[] }> };
    };
    assert.ok(blueprint.roles.some((role) => role.id === 'operator'));
    assert.ok(blueprint.fleet.workerRoles.some(
      (role) => role.id === 'operator' && role.capabilities.includes('operator:write'),
    ));

    const result = assembleRolePrompt({
      slug: 'papercusp',
      projectDir: repoRoot,
      role: 'operator',
      mode: 'chat',
    });
    assert.equal(result.meta.blueprintId, 'papercusp');
    assert.match(result.meta.promptFile, /blueprints\/base\/prompts\/operator\.md$/);
    assert.match(result.text, /Operator — bounded control-plane execution/);
    assert.doesNotMatch(result.text, /The Mug — the Pot operator/);
  } finally {
    if (priorHarnessDir === undefined) delete process.env.PAPERCUSP_HARNESS_DIR;
    else process.env.PAPERCUSP_HARNESS_DIR = priorHarnessDir;
    if (priorPromptRoot === undefined) delete process.env.PAPERCUSP_PROMPT_ROOT;
    else process.env.PAPERCUSP_PROMPT_ROOT = priorPromptRoot;
  }
});

test('assembleRolePrompt includes Queen brief when supplied (P-060)', () => {
  const setup = setupRegistry();
  const prevHome = process.env.HOME;
  const prevHarnessDir = process.env.PAPERCUSP_HARNESS_DIR;
  process.env.HOME = setup.home;
  process.env.PAPERCUSP_HARNESS_DIR = setup.harnessDir;
  try {
    const queenBrief = 'Two bees are fixing schema migrations. Watch for conflicts when this runs. Priority: unblock CI.';
    const result = assembleRolePrompt({
      slug: 'demo',
      role: 'worker',
      featureId: 'F-001',
      mode: 'chat',
      brief: queenBrief,
    });
    assert.match(result.text, /## Queen brief/, 'brief should appear as a section heading');
    assert.match(
      result.text,
      /Two bees are fixing schema migrations/,
      'brief content should appear verbatim in the assembled prompt',
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
