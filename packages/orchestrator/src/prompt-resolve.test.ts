import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  promptCandidates,
  resolveBlueprintChain,
  resolvePromptFile,
  resolvePromptFiles,
} from './prompt-resolve.js';

/** Write a blueprints/<id>/blueprint.yaml with an optional `extends`. */
function writeBlueprintYaml(root: string, id: string, ext?: string): void {
  mkdirSync(join(root, 'blueprints', id), { recursive: true });
  const body = ext ? `id: ${id}\nextends: ${ext}\n` : `id: ${id}\n`;
  writeFileSync(join(root, 'blueprints', id, 'blueprint.yaml'), body);
}

/** Write a blueprints/<id>/prompts/<role>.md. */
function writeBlueprintRole(root: string, id: string, role: string, body = '# x'): void {
  mkdirSync(join(root, 'blueprints', id, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'blueprints', id, 'prompts', `${role}.md`), body);
}

function withHarness(setup: (root: string) => void): {
  harnessDir: string;
  cleanup: () => void;
} {
  const harnessDir = mkdtempSync(join(tmpdir(), 'papercusp-orch-prompt-'));
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });
  setup(harnessDir);
  return { harnessDir, cleanup: () => rmSync(harnessDir, { recursive: true, force: true }) };
}

test('promptCandidates — bare role resolves to base only (the universal library; no global tiers)', () => {
  // K-1 + Phase 5 (D-012): with no blueprintId, base is the ONLY candidate — the global
  // phase/dept tiers + the bare global default were deleted; `phase` is no longer consulted.
  const list = promptCandidates({ harnessDir: '/h', phase: 'staging', dept: '' }, 'worker');
  assert.deepEqual(list, ['/h/blueprints/base/prompts/worker.md']);
});

// Audit P-019: base/<role>.md is the universal first section; the concrete
// resolved prompt stays the authoritative last. The base layer was documented
// in the prompts README but NEVER loaded before resolvePromptFiles existed.
test('resolvePromptFiles — base prefix layer composes BEFORE the concrete prompt', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintRole(root, 'base', 'worker.base', '# base');
    writeBlueprintRole(root, 'base', 'worker', '# worker');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: 'staging', dept: '' }, 'worker');
    assert.deepEqual(files, [
      join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.base.md'),
      join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'),
    ]);
  } finally {
    cleanup();
  }
});

test('resolvePromptFiles — no prefix layer → just the concrete prompt', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintRole(root, 'base', 'worker', '# worker');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: '', dept: '' }, 'worker');
    assert.deepEqual(files, [join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md')]);
  } finally {
    cleanup();
  }
});

test('resolvePromptFiles — base-only role still resolves (the role HAS a prompt)', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintRole(root, 'base', 'summarizer', '# base summarizer');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: '', dept: '' }, 'summarizer');
    assert.deepEqual(files, [join(harnessDir, 'blueprints', 'base', 'prompts', 'summarizer.md')]);
  } finally {
    cleanup();
  }
});

test('resolvePromptFiles — unknown role → []', () => {
  const { harnessDir, cleanup } = withHarness(() => {});
  try {
    assert.deepEqual(resolvePromptFiles({ harnessDir, phase: '', dept: '' }, 'nope'), []);
  } finally {
    cleanup();
  }
});

// (phase-override + dept-override tests removed — Phase 5 D-012: the global phase/dept
//  override tiers were deleted; `staging` was collapsed into base as canonical.)

test('promptCandidates — blueprintId adds the blueprint-local prompt FIRST, then base', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: '', blueprintId: 'vote' },
    'voter',
  );
  assert.deepEqual(list, [
    '/h/blueprints/vote/prompts/voter.md',
    '/h/blueprints/base/prompts/voter.md',
  ]);
});

test('promptCandidates — explicit extendsChain walks each ancestor before base + global', () => {
  // The multi-level case (implement → single-agent → base): the resolve
  // functions populate extendsChain from blueprint.yaml; here it is passed
  // directly to keep promptCandidates pure.
  const list = promptCandidates(
    { harnessDir: '/h', phase: '', dept: '', blueprintId: 'implement', extendsChain: ['implement', 'single-agent', 'base'] },
    'worker',
  );
  assert.deepEqual(list, [
    '/h/blueprints/implement/prompts/worker.md',
    '/h/blueprints/single-agent/prompts/worker.md',
    '/h/blueprints/base/prompts/worker.md',
  ]);
});

test('resolvePromptFile — program-blueprint role resolves to blueprints/<id>/prompts/<role>.md', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    // The voter prompt lives ONLY in the blueprint dir, not the global prompts/.
    mkdirSync(join(root, 'blueprints', 'vote', 'prompts'), { recursive: true });
    writeFileSync(join(root, 'blueprints', 'vote', 'prompts', 'voter.md'), '# voter');
  });
  try {
    // Without blueprintId it is unresolvable (the live-spawn gap this fixes).
    assert.equal(resolvePromptFile({ harnessDir, phase: 'staging', dept: '' }, 'voter'), null);
    // With blueprintId it resolves the blueprint-local prompt.
    const found = resolvePromptFile(
      { harnessDir, phase: 'staging', dept: '', blueprintId: 'vote' },
      'voter',
    );
    assert.equal(found, join(harnessDir, 'blueprints', 'vote', 'prompts', 'voter.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — blueprint-local prompt wins over a global prompts/<role>.md', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'advocate.md'), '# global');
    mkdirSync(join(root, 'blueprints', 'vote', 'prompts'), { recursive: true });
    writeFileSync(join(root, 'blueprints', 'vote', 'prompts', 'advocate.md'), '# blueprint');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'vote' },
      'advocate',
    );
    assert.equal(found, join(harnessDir, 'blueprints', 'vote', 'prompts', 'advocate.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — blueprintId falls through to base when the blueprint lacks the role', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintRole(root, 'base', 'worker', '# base worker');
    mkdirSync(join(root, 'blueprints', 'vote', 'prompts'), { recursive: true });
    // no worker.md in the vote blueprint dir → falls through to base (no global tier).
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'vote' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — returns null when nothing exists', () => {
  const { harnessDir, cleanup } = withHarness(() => {
    /* empty prompts/ */
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: 'staging', dept: '' },
      'nonexistent-role',
    );
    assert.equal(found, null);
  } finally {
    cleanup();
  }
});

// ── K-1: the resolver walks the blueprint extends-chain ────────────────────

test('resolveBlueprintChain — reads multi-level extends from blueprint.yaml, base-terminated', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintYaml(root, 'implement', 'single-agent');
    writeBlueprintYaml(root, 'single-agent', 'base');
    writeBlueprintYaml(root, 'base');
  });
  try {
    assert.deepEqual(resolveBlueprintChain(harnessDir, 'implement'), [
      'implement',
      'single-agent',
      'base',
    ]);
    assert.deepEqual(resolveBlueprintChain(harnessDir, 'single-agent'), ['single-agent', 'base']);
    assert.deepEqual(resolveBlueprintChain(harnessDir, 'base'), ['base']);
  } finally {
    cleanup();
  }
});

test('resolveBlueprintChain — appends base even when a blueprint.yaml is absent/undeclared', () => {
  const { harnessDir, cleanup } = withHarness(() => {
    /* no blueprints/ at all */
  });
  try {
    // Missing blueprint.yaml → no parents found → base still appended.
    assert.deepEqual(resolveBlueprintChain(harnessDir, 'coding'), ['coding', 'base']);
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — base resolves a role with NO blueprintId (the universal library)', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    // The role lives ONLY in the base blueprint — no global prompts/<role>.md.
    writeBlueprintRole(root, 'base', 'curator', '# base curator');
  });
  try {
    const found = resolvePromptFile({ harnessDir, phase: 'staging', dept: '' }, 'curator');
    assert.equal(found, join(harnessDir, 'blueprints', 'base', 'prompts', 'curator.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — an extends ANCESTOR override wins over base (multi-level chain read from yaml)', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintYaml(root, 'implement', 'single-agent');
    writeBlueprintYaml(root, 'single-agent', 'base');
    writeBlueprintYaml(root, 'base');
    // base + single-agent both define worker; the ancestor (single-agent) wins.
    writeBlueprintRole(root, 'base', 'worker', '# base worker');
    writeBlueprintRole(root, 'single-agent', 'worker', '# single-agent worker');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'implement' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'blueprints', 'single-agent', 'prompts', 'worker.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — blueprint own override wins over its ancestors + base', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintYaml(root, 'implement', 'single-agent');
    writeBlueprintYaml(root, 'single-agent', 'base');
    writeBlueprintYaml(root, 'base');
    writeBlueprintRole(root, 'base', 'worker', '# base worker');
    writeBlueprintRole(root, 'single-agent', 'worker', '# single-agent worker');
    writeBlueprintRole(root, 'implement', 'worker', '# implement worker');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'implement' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'blueprints', 'implement', 'prompts', 'worker.md'));
  } finally {
    cleanup();
  }
});

// ── Phase 5/6 structural invariant (blueprint-role-bundling D-012, option A) ──────
// The legacy global prompts/ dir was DELETED and `staging` collapsed into the base
// role library as canonical. These guard against a regression that resurrects the
// global dir (or the phase/dept override tiers) — the failure modes the resolver
// rewrite + the persona migration were designed to make impossible.

/** The real shipped harness package dir (…/orchestrator/src → …/harness). */
const HARNESS_PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness');

test('Phase 5 invariant — the legacy global prompts/ dir stays DELETED', () => {
  assert.equal(
    existsSync(join(HARNESS_PKG, 'prompts')),
    false,
    'libs/papercusp/packages/harness/prompts/ was deleted in blueprint-role-bundling Phase 5 ' +
      '(option A — staging collapsed into the base role library). Do NOT recreate it: role ' +
      'personas live in blueprints/base/prompts/ (universal) or blueprints/<id>/prompts/ (per-blueprint).',
  );
});

test('Phase 6 invariant — the base role library is the canonical home for the core roles', () => {
  const baseDir = join(HARNESS_PKG, 'blueprints', 'base', 'prompts');
  assert.equal(existsSync(baseDir), true, 'blueprints/base/prompts/ is the canonical role library');
  // The core pipeline roles + the migrated specialists must resolve from base with NO
  // blueprintId (the universal-library guarantee `assembleRolePrompt` relies on).
  for (const role of ['worker', 'validator', 'scoper', 'orchestrator', 'reviewer', 'documenter', 'tester', 'monitor']) {
    const found = resolvePromptFile({ harnessDir: HARNESS_PKG, phase: '', dept: '' }, role);
    assert.equal(
      found,
      join(baseDir, `${role}.md`),
      `core role "${role}" must resolve from the base library (blueprints/base/prompts/${role}.md)`,
    );
  }
  // The 2 built-in role MANIFESTS moved global→base in Phase 5 (role-registry scans base).
  for (const manifest of ['security-reviewer.role.json', 'infra-reviewer.role.json']) {
    assert.equal(existsSync(join(baseDir, manifest)), true, `${manifest} must live in the base library`);
  }
});
