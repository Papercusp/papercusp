import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('promptCandidates — bare phase + role (phase override wins, base is the default below it)', () => {
  // K-1: base is ALWAYS a candidate, even with no blueprintId — it is the
  // universal role library. It sits AFTER the (live) phase tiers and just above
  // the legacy global default it replaces.
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: '' },
    'worker',
  );
  assert.deepEqual(list, [
    '/h/prompts/staging/worker.md',
    '/h/blueprints/base/prompts/worker.md',
    '/h/prompts/worker.md',
  ]);
});

test('promptCandidates — phase + dept generates dept-specific path first', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: 'business' },
    'worker',
  );
  assert.deepEqual(list, [
    '/h/prompts/staging/departments/business/worker.md',
    '/h/prompts/staging/worker.md',
    '/h/blueprints/base/prompts/worker.md',
    '/h/prompts/worker.md',
  ]);
});

test('promptCandidates — phase=department adds legacy prompts/department/ path', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'department', dept: '' },
    'worker',
  );
  assert.deepEqual(list, [
    '/h/prompts/department/worker.md',
    '/h/blueprints/base/prompts/worker.md',
    '/h/prompts/worker.md',
  ]);
});

test('resolvePromptFile — falls back to prompts/$role.md when nothing more specific exists', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'worker.md'), '# worker');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: 'staging', dept: 'sales' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'prompts', 'worker.md'));
  } finally {
    cleanup();
  }
});

// Audit P-019: base/<role>.md is the universal first section; the concrete
// resolved prompt stays the authoritative last. The base layer was documented
// in the prompts README but NEVER loaded before resolvePromptFiles existed.
test('resolvePromptFiles — base layer composes BEFORE the concrete prompt', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    mkdirSync(join(root, 'prompts', 'base'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'base', 'worker.md'), '# base');
    writeFileSync(join(root, 'prompts', 'worker.md'), '# worker');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: 'staging', dept: '' }, 'worker');
    assert.deepEqual(files, [
      join(harnessDir, 'prompts', 'base', 'worker.md'),
      join(harnessDir, 'prompts', 'worker.md'),
    ]);
  } finally {
    cleanup();
  }
});

test('resolvePromptFiles — no base layer → just the concrete prompt', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'worker.md'), '# worker');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: '', dept: '' }, 'worker');
    assert.deepEqual(files, [join(harnessDir, 'prompts', 'worker.md')]);
  } finally {
    cleanup();
  }
});

test('resolvePromptFiles — base-only role still resolves (the role HAS a prompt)', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    mkdirSync(join(root, 'prompts', 'base'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'base', 'summarizer.md'), '# base summarizer');
  });
  try {
    const files = resolvePromptFiles({ harnessDir, phase: '', dept: '' }, 'summarizer');
    assert.deepEqual(files, [join(harnessDir, 'prompts', 'base', 'summarizer.md')]);
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

test('resolvePromptFile — phase override wins over default', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'worker.md'), '# default');
    mkdirSync(join(root, 'prompts', 'staging'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'staging', 'worker.md'), '# staging');
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: 'staging', dept: '' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'prompts', 'staging', 'worker.md'));
  } finally {
    cleanup();
  }
});

test('resolvePromptFile — dept override wins over phase override', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'worker.md'), '# default');
    mkdirSync(join(root, 'prompts', 'staging', 'departments', 'sales'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'staging', 'worker.md'), '# staging');
    writeFileSync(
      join(root, 'prompts', 'staging', 'departments', 'sales', 'worker.md'),
      '# sales',
    );
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: 'staging', dept: 'sales' },
      'worker',
    );
    assert.equal(
      found,
      join(harnessDir, 'prompts', 'staging', 'departments', 'sales', 'worker.md'),
    );
  } finally {
    cleanup();
  }
});

test('promptCandidates — blueprintId adds the blueprint-local prompt FIRST, then base', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: '', blueprintId: 'vote' },
    'voter',
  );
  assert.deepEqual(list, [
    '/h/blueprints/vote/prompts/voter.md',
    '/h/prompts/staging/voter.md',
    '/h/blueprints/base/prompts/voter.md',
    '/h/prompts/voter.md',
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
    '/h/prompts/worker.md',
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

test('resolvePromptFile — blueprintId falls through to the global prompt when the blueprint lacks one', () => {
  const { harnessDir, cleanup } = withHarness((root) => {
    writeFileSync(join(root, 'prompts', 'worker.md'), '# global worker');
    mkdirSync(join(root, 'blueprints', 'vote', 'prompts'), { recursive: true });
    // no worker.md in the blueprint dir
  });
  try {
    const found = resolvePromptFile(
      { harnessDir, phase: '', dept: '', blueprintId: 'vote' },
      'worker',
    );
    assert.equal(found, join(harnessDir, 'prompts', 'worker.md'));
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
