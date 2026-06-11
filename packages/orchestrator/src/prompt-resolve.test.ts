import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptCandidates, resolvePromptFile, resolvePromptFiles } from './prompt-resolve.js';

function withHarness(setup: (root: string) => void): {
  harnessDir: string;
  cleanup: () => void;
} {
  const harnessDir = mkdtempSync(join(tmpdir(), 'papercusp-orch-prompt-'));
  mkdirSync(join(harnessDir, 'prompts'), { recursive: true });
  setup(harnessDir);
  return { harnessDir, cleanup: () => rmSync(harnessDir, { recursive: true, force: true }) };
}

test('promptCandidates — bare phase + role', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: '' },
    'worker',
  );
  assert.deepEqual(list, [
    '/h/prompts/staging/worker.md',
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

test('promptCandidates — blueprintId adds the blueprint-local prompt FIRST', () => {
  const list = promptCandidates(
    { harnessDir: '/h', phase: 'staging', dept: '', blueprintId: 'vote' },
    'voter',
  );
  assert.deepEqual(list, [
    '/h/blueprints/vote/prompts/voter.md',
    '/h/prompts/staging/voter.md',
    '/h/prompts/voter.md',
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
