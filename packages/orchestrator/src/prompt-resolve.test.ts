import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptCandidates, resolvePromptFile } from './prompt-resolve.js';

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
