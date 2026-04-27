import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointGate } from './checkpoints.js';

function makeStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-checkpoints-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('checkpointGate — no-checkpoints when state dir empty', () => {
  const { dir, cleanup } = makeStateDir();
  try {
    assert.deepEqual(checkpointGate(dir), { kind: 'no-checkpoints' });
  } finally {
    cleanup();
  }
});

test('checkpointGate — pending when ungranted file present', () => {
  const { dir, cleanup } = makeStateDir();
  writeFileSync(join(dir, 'checkpoint-foo.md'), '## Need approval');
  try {
    const out = checkpointGate(dir);
    assert.equal(out.kind, 'pending');
    if (out.kind === 'pending') {
      assert.deepEqual(out.pending, ['checkpoint-foo.md']);
    }
    // File NOT removed when pending.
    assert.ok(readdirSync(dir).includes('checkpoint-foo.md'));
  } finally {
    cleanup();
  }
});

test('checkpointGate — granted-cleared removes both files', () => {
  const { dir, cleanup } = makeStateDir();
  writeFileSync(join(dir, 'checkpoint-foo.md'), '## body');
  writeFileSync(join(dir, 'checkpoint-foo.md.granted'), '');
  try {
    const out = checkpointGate(dir);
    assert.equal(out.kind, 'granted-cleared');
    if (out.kind === 'granted-cleared') {
      assert.deepEqual(out.cleared, ['checkpoint-foo.md']);
    }
    // Both files removed.
    const remaining = readdirSync(dir);
    assert.ok(!remaining.includes('checkpoint-foo.md'));
    assert.ok(!remaining.includes('checkpoint-foo.md.granted'));
  } finally {
    cleanup();
  }
});

test('checkpointGate — mixed: pending wins (refuse to start)', () => {
  const { dir, cleanup } = makeStateDir();
  writeFileSync(join(dir, 'checkpoint-a.md'), '');
  writeFileSync(join(dir, 'checkpoint-a.md.granted'), '');
  writeFileSync(join(dir, 'checkpoint-b.md'), '');
  // No granted for b → should be pending.
  try {
    const out = checkpointGate(dir);
    assert.equal(out.kind, 'pending');
    if (out.kind === 'pending') {
      assert.deepEqual(out.pending, ['checkpoint-b.md']);
    }
    // a still gets cleared though — bash drops grants as it walks.
    const remaining = readdirSync(dir);
    assert.ok(!remaining.includes('checkpoint-a.md'));
    assert.ok(!remaining.includes('checkpoint-a.md.granted'));
    assert.ok(remaining.includes('checkpoint-b.md'));
  } finally {
    cleanup();
  }
});

test('checkpointGate — ignores non-checkpoint files', () => {
  const { dir, cleanup } = makeStateDir();
  writeFileSync(join(dir, 'some-other.md'), '');
  writeFileSync(join(dir, 'checkpoint.md'), ''); // missing dash suffix
  try {
    assert.deepEqual(checkpointGate(dir), { kind: 'no-checkpoints' });
  } finally {
    cleanup();
  }
});
