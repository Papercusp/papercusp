import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  promptCandidates,
  resolveBlueprintChain,
  resolveBlueprintChainRoots,
  resolvePromptFile,
  resolvePromptFiles,
  resolveReplacementSystemPrompt,
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

/** Write blueprints/<id>/prompts/<file>. */
function writeBlueprintPrompt(root: string, id: string, file: string, body: string): void {
  mkdirSync(join(root, 'blueprints', id, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'blueprints', id, 'prompts', file), body);
}

// ── domain-generic-agent-personas-2026-06-17 P-009/P-010/P-013 ───────────────
// resolveReplacementSystemPrompt composes the REPLACE_CLAUDE_BASE system prompt:
// the neutral base preamble + the most-specific blueprint overlay (coding's SWE framing).

test('resolveReplacementSystemPrompt — null when the base preamble is absent (no-op → Claude default stands)', () => {
  const { harnessDir, cleanup } = withHarness(() => {
    /* no agent-base-preamble.md */
  });
  try {
    assert.equal(
      resolveReplacementSystemPrompt({ harnessDir, phase: '', dept: '', blueprintId: 'coding' }),
      null,
    );
  } finally {
    cleanup();
  }
});

test('resolveReplacementSystemPrompt — neutral preamble only when the blueprint has no coding overlay', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintPrompt(root, 'base', 'agent-base-preamble.md', '# NEUTRAL BASE');
    // a generic/research blueprint provides NO agent-base-overlay.md
    writeBlueprintYaml(root, 'research', 'base');
    writeBlueprintYaml(root, 'base');
  });
  try {
    const out = resolveReplacementSystemPrompt({
      harnessDir,
      phase: '',
      dept: '',
      blueprintId: 'research',
    });
    assert.equal(out, '# NEUTRAL BASE\n');
  } finally {
    cleanup();
  }
});

test('resolveReplacementSystemPrompt — coding blueprint appends its overlay AFTER the neutral base', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintPrompt(root, 'base', 'agent-base-preamble.md', '# NEUTRAL BASE');
    writeBlueprintPrompt(root, 'coding', 'agent-base-overlay.md', '# CODING OVERLAY');
    writeBlueprintYaml(root, 'coding', 'base');
    writeBlueprintYaml(root, 'base');
  });
  try {
    const out = resolveReplacementSystemPrompt({
      harnessDir,
      phase: '',
      dept: '',
      blueprintId: 'coding',
    });
    assert.equal(out, '# NEUTRAL BASE\n\n# CODING OVERLAY\n');
  } finally {
    cleanup();
  }
});

test('resolveReplacementSystemPrompt — no blueprintId → neutral preamble only (base chain, no overlay)', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintPrompt(root, 'base', 'agent-base-preamble.md', '# NEUTRAL BASE');
    // even though a coding overlay exists in the tree, no blueprintId ⇒ base-only chain.
    writeBlueprintPrompt(root, 'coding', 'agent-base-overlay.md', '# CODING OVERLAY');
  });
  try {
    const out = resolveReplacementSystemPrompt({ harnessDir, phase: '', dept: '' });
    assert.equal(out, '# NEUTRAL BASE\n');
  } finally {
    cleanup();
  }
});

test('resolveReplacementSystemPrompt — picks the MOST-SPECIFIC overlay walking the extends-chain', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintPrompt(root, 'base', 'agent-base-preamble.md', '# NEUTRAL BASE');
    // implement → coding → base; both coding and implement carry an overlay → leaf (implement) wins.
    writeBlueprintYaml(root, 'implement', 'coding');
    writeBlueprintYaml(root, 'coding', 'base');
    writeBlueprintYaml(root, 'base');
    writeBlueprintPrompt(root, 'coding', 'agent-base-overlay.md', '# CODING OVERLAY');
    writeBlueprintPrompt(root, 'implement', 'agent-base-overlay.md', '# IMPLEMENT OVERLAY');
  });
  try {
    const out = resolveReplacementSystemPrompt({
      harnessDir,
      phase: '',
      dept: '',
      blueprintId: 'implement',
    });
    assert.equal(out, '# NEUTRAL BASE\n\n# IMPLEMENT OVERLAY\n');
  } finally {
    cleanup();
  }
});

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

// ── domain-generic-hive-architecture-2026-06-18 P-014/D-006 — tier-aware resolution ──
// blueprintRoots (local → installed) are searched BEFORE harnessDir (built-in). Blueprint
// SPECIFICITY stays primary (leaf-first); TIER is the tiebreaker within one id. An empty
// blueprintRoots is byte-identical to the pre-tier behavior.

/** A second temp root (the per-hive LOCAL tier) alongside a harnessDir. */
function withTiers(setup: (local: string, builtin: string) => void): {
  local: string;
  builtin: string;
  cleanup: () => void;
} {
  const local = mkdtempSync(join(tmpdir(), 'papercusp-orch-local-'));
  const builtin = mkdtempSync(join(tmpdir(), 'papercusp-orch-builtin-'));
  setup(local, builtin);
  return {
    local,
    builtin,
    cleanup: () => {
      rmSync(local, { recursive: true, force: true });
      rmSync(builtin, { recursive: true, force: true });
    },
  };
}

test('tier-aware — a local-tier override of a blueprint role beats the built-in copy', () => {
  const { local, builtin, cleanup } = withTiers((loc, bi) => {
    writeBlueprintYaml(bi, 'coding', 'base');
    writeBlueprintRole(bi, 'coding', 'bee', '# builtin bee');
    // local tier overrides ONLY the coding bee
    writeBlueprintRole(loc, 'coding', 'bee', '# local bee');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir: builtin, phase: '', dept: '', blueprintId: 'coding', blueprintRoots: [local] },
      'bee',
    );
    assert.equal(found, join(local, 'blueprints', 'coding', 'prompts', 'bee.md'));
  } finally {
    cleanup();
  }
});

test('tier-aware — blueprint specificity dominates tier: a LEAF built-in beats an ANCESTOR local', () => {
  const { local, builtin, cleanup } = withTiers((loc, bi) => {
    writeBlueprintYaml(bi, 'base');
    writeBlueprintYaml(bi, 'coding', 'base');
    writeBlueprintRole(bi, 'coding', 'queen', '# builtin coding queen (leaf)');
    // local tier supplies only an ANCESTOR (base) queen — must NOT win over the leaf
    writeBlueprintRole(loc, 'base', 'queen', '# local base queen (ancestor)');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir: builtin, phase: '', dept: '', blueprintId: 'coding', blueprintRoots: [local] },
      'queen',
    );
    assert.equal(found, join(builtin, 'blueprints', 'coding', 'prompts', 'queen.md'));
  } finally {
    cleanup();
  }
});

test('tier-aware — extends-chain reads a LOCAL blueprint.yaml (local delta blueprint extends a built-in)', () => {
  const { local, builtin, cleanup } = withTiers((loc, bi) => {
    writeBlueprintYaml(bi, 'base');
    writeBlueprintYaml(bi, 'coding', 'base');
    writeBlueprintRole(bi, 'coding', 'bee', '# builtin coding bee');
    // a per-hive LOCAL delta blueprint that extends the built-in coding blueprint,
    // overriding the bee — its blueprint.yaml lives only in the local tier.
    writeBlueprintYaml(loc, 'acme-local', 'coding');
    writeBlueprintRole(loc, 'acme-local', 'bee', '# acme-local bee');
  });
  try {
    const chain = resolveBlueprintChainRoots([local, builtin], 'acme-local');
    assert.deepEqual(chain, ['acme-local', 'coding', 'base']);
    const found = resolvePromptFile(
      { harnessDir: builtin, phase: '', dept: '', blueprintId: 'acme-local', blueprintRoots: [local] },
      'bee',
    );
    assert.equal(found, join(local, 'blueprints', 'acme-local', 'prompts', 'bee.md'));
  } finally {
    cleanup();
  }
});

test('tier-aware — falls through the local tier to the built-in when the local lacks the role', () => {
  const { local, builtin, cleanup } = withTiers((loc, bi) => {
    writeBlueprintYaml(bi, 'coding', 'base');
    writeBlueprintRole(bi, 'coding', 'scoper', '# builtin scoper');
    // local delta exists but only overrides the bee — scoper must fall through to built-in
    writeBlueprintYaml(loc, 'acme-local', 'coding');
    writeBlueprintRole(loc, 'acme-local', 'bee', '# acme-local bee');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir: builtin, phase: '', dept: '', blueprintId: 'acme-local', blueprintRoots: [local] },
      'scoper',
    );
    assert.equal(found, join(builtin, 'blueprints', 'coding', 'prompts', 'scoper.md'));
  } finally {
    cleanup();
  }
});

test('tier-aware — resolveReplacementSystemPrompt prefers a local overlay over the built-in', () => {
  const { local, builtin, cleanup } = withTiers((loc, bi) => {
    writeBlueprintYaml(bi, 'base');
    writeBlueprintYaml(bi, 'coding', 'base');
    writeBlueprintPrompt(bi, 'base', 'agent-base-preamble.md', 'NEUTRAL BASE');
    writeBlueprintPrompt(bi, 'coding', 'agent-base-overlay.md', 'BUILTIN SWE OVERLAY');
    writeBlueprintPrompt(loc, 'coding', 'agent-base-overlay.md', 'LOCAL SWE OVERLAY');
  });
  try {
    const out = resolveReplacementSystemPrompt({
      harnessDir: builtin,
      phase: '',
      dept: '',
      blueprintId: 'coding',
      blueprintRoots: [local],
    });
    assert.equal(out, 'NEUTRAL BASE\n\nLOCAL SWE OVERLAY\n');
  } finally {
    cleanup();
  }
});

test('tier-aware — empty blueprintRoots is byte-identical to a single-root ctx', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeBlueprintYaml(root, 'coding', 'base');
    writeBlueprintRole(root, 'coding', 'bee', '# builtin bee');
  });
  try {
    const withEmpty = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'coding', blueprintRoots: [] },
      'bee',
    );
    const without = resolvePromptFile({ harnessDir, phase: '', dept: '', blueprintId: 'coding' }, 'bee');
    assert.equal(withEmpty, without);
    assert.equal(without, join(harnessDir, 'blueprints', 'coding', 'prompts', 'bee.md'));
  } finally {
    cleanup();
  }
});

// ── domain-generic-hive-architecture-2026-06-18 P-005 — per-blueprint bees over a shared base bee ──
// The generic bee persona is the shared `base/prompts/bee.base.md` PREFIX; each hive blueprint
// supplies a thin domain `bee.md` MAIN (coding ships code+tests; work produces a judged
// deliverable). Asserts the REAL built-in blueprints compose as [base prefix, domain main],
// and that the work hive (generic-hive) no longer inherits the coding bee (audit Finding B).
test('P-005 — coding-hive bee composes [base/bee.base.md, hive/bee.md] (real blueprints)', () => {
  const files = resolvePromptFiles({ harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'coding' }, 'bee');
  assert.deepEqual(files, [
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'bee.base.md'),
    join(HARNESS_PKG, 'blueprints', 'coding', 'prompts', 'bee.md'),
  ]);
});

test('P-005 — work-hive (generic-hive) bee composes [base/bee.base.md, generic-hive/bee.md] — NOT the coding bee', () => {
  const files = resolvePromptFiles(
    { harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'work' },
    'bee',
  );
  assert.deepEqual(files, [
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'bee.base.md'),
    join(HARNESS_PKG, 'blueprints', 'work', 'prompts', 'bee.md'),
  ]);
  // Finding B closed: the work bee main is the generic-hive one, never hive/bee.md (coding).
  assert.notEqual(files[files.length - 1], join(HARNESS_PKG, 'blueprints', 'coding', 'prompts', 'bee.md'));
});

// ── domain-generic-hive-architecture-2026-06-18 P-007/P-008 — Queen neutral base + per-domain delta ──
// The generic Queen orchestration method (triage / survey / place / propose-dispose / completion /
// grading / reflect) is the shared `base/prompts/queen.base.md` PREFIX; each hive blueprint supplies
// a thin domain `queen.md` MAIN (coding decomposes by file-scope + contract seams and verifies by
// tests; work decomposes by topic / subject and accepts by a judge rubric). Mirrors the P-005 bee
// split: asserts the REAL built-in blueprints compose as [base prefix, domain main], that the work
// hive (generic-hive) does NOT inherit the coding queen, and that the bare fallback is method + a
// no-domain note (NOT the method twice).
test('P-007/P-008 — coding-hive queen composes [base/queen.base.md, hive/queen.md] (real blueprints)', () => {
  const files = resolvePromptFiles({ harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'coding' }, 'queen');
  assert.deepEqual(files, [
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'queen.base.md'),
    join(HARNESS_PKG, 'blueprints', 'coding', 'prompts', 'queen.md'),
  ]);
});

test('P-007/P-008 — work-hive (generic-hive) queen composes [base/queen.base.md, generic-hive/queen.md] — NOT the coding queen', () => {
  const files = resolvePromptFiles(
    { harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'work' },
    'queen',
  );
  assert.deepEqual(files, [
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'queen.base.md'),
    join(HARNESS_PKG, 'blueprints', 'work', 'prompts', 'queen.md'),
  ]);
  // The work queen main is the generic-hive one, never hive/queen.md (coding) — even though
  // generic-hive `extends: hive`, its own queen.md override wins the most-specific slot.
  assert.notEqual(files[files.length - 1], join(HARNESS_PKG, 'blueprints', 'coding', 'prompts', 'queen.md'));
});

test('P-007/P-008 — bare queen (no blueprintId) composes [base/queen.base.md, base/queen.md] (method + no-domain note)', () => {
  // The base-only fallback the brain/global-fallback path resolves: the shared method PREFIX +
  // the trimmed no-domain MAIN — method once, not twice. Guards the base-role-library invariant
  // (a no-blueprintId queen resolves ENTIRELY from base).
  const files = resolvePromptFiles({ harnessDir: HARNESS_PKG, phase: '', dept: '' }, 'queen');
  assert.deepEqual(files, [
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'queen.base.md'),
    join(HARNESS_PKG, 'blueprints', 'base', 'prompts', 'queen.md'),
  ]);
});

test('Brief 6 blueprint-id alias — a stale hive/generic-hive id resolves the renamed dir', () => {
  // An un-migrated instance `extends:` or a stale blueprintId naming an OLD id still
  // resolves the renamed blueprint dir during the rename transition (blueprint-aliases.ts).
  assert.equal(
    resolvePromptFile({ harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'hive' }, 'bee'),
    join(HARNESS_PKG, 'blueprints', 'coding', 'prompts', 'bee.md'),
  );
  assert.equal(
    resolvePromptFile({ harnessDir: HARNESS_PKG, phase: '', dept: '', blueprintId: 'generic-hive' }, 'bee'),
    join(HARNESS_PKG, 'blueprints', 'work', 'prompts', 'bee.md'),
  );
});
