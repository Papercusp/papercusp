import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLogs } from './prune-logs.js';

function makeLogDir(files: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-prune-'));
  for (const f of files) {
    writeFileSync(join(dir, f), 'data');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('pruneLogs — under retention is no-op', () => {
  const fx = makeLogDir(['1700000000-a.out', '1700000000-a.err', '1700000000-a.jsonl']);
  try {
    const r = pruneLogs(fx.dir, { logRetention: 500 });
    assert.equal(r.dropped, 0);
    assert.equal(r.kept, 1);
  } finally {
    fx.cleanup();
  }
});

test('pruneLogs — drops oldest sets when over retention', () => {
  const files: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ts = `170000000${i}`;
    files.push(`${ts}-role.out`, `${ts}-role.err`, `${ts}-role.jsonl`);
  }
  const fx = makeLogDir(files);
  try {
    const r = pruneLogs(fx.dir, { logRetention: 3 });
    assert.equal(r.kept, 3);
    assert.equal(r.dropped, 7);
    const remaining = readdirSync(fx.dir);
    // Oldest 7 sets gone; newest 3 sets (each 3 files) = 9 files remain.
    assert.equal(remaining.length, 9);
    // The 3 most recent ts prefixes (7, 8, 9) survived.
    assert.ok(remaining.some((n) => n.startsWith('1700000007-')));
    assert.ok(remaining.some((n) => n.startsWith('1700000008-')));
    assert.ok(remaining.some((n) => n.startsWith('1700000009-')));
    assert.ok(!remaining.some((n) => n.startsWith('1700000000-')));
  } finally {
    fx.cleanup();
  }
});

test('pruneLogs — default retention is 500', () => {
  // Only verify the option-coercion: 500 .out files should not be pruned.
  const files: string[] = [];
  for (let i = 0; i < 50; i++) {
    files.push(`${1700000000 + i}-r.out`);
  }
  const fx = makeLogDir(files);
  try {
    const r = pruneLogs(fx.dir, {});
    assert.equal(r.dropped, 0);
  } finally {
    fx.cleanup();
  }
});

test('pruneLogs — missing logDir is a no-op', () => {
  const r = pruneLogs('/tmp/nonexistent-papercusp-orch-prune-' + Math.random(), {});
  assert.deepEqual(r, { kept: 0, dropped: 0 });
});

test('pruneLogs — missing siblings (only .out present) handled gracefully', () => {
  const files = ['1700000001-a.out', '1700000002-b.out', '1700000003-c.out'];
  const fx = makeLogDir(files);
  try {
    const r = pruneLogs(fx.dir, { logRetention: 1 });
    assert.equal(r.dropped, 2);
    const remaining = readdirSync(fx.dir);
    assert.deepEqual(remaining, ['1700000003-c.out']);
  } finally {
    fx.cleanup();
  }
});
