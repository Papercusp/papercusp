import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotState } from './snapshot-state.js';
import { stateCtx } from './state.js';
import { seedMemoryStore, _resetMemoryStateForTests } from './state-memory.js';

beforeEach(() => {
  _resetMemoryStateForTests();
});

function makeStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-snap-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('snapshotState — synthesizes features.json from store + copies markdown artifacts', async () => {
  const fx = makeStateDir();
  try {
    // Seed in-memory features (PG-canonical at runtime; memory in tests).
    seedMemoryStore(fx.dir, [
      { id: 'F-001', title: 'one', status: 'passed', attempts: 0 },
    ]);
    // The markdown artifacts still come from disk.
    writeFileSync(join(fx.dir, 'config.json'), '{"phase":"staging"}');
    const r = await snapshotState(fx.dir, 1, {}, stateCtx({ stateDir: fx.dir }));
    assert.ok(r.path);
    assert.equal(r.pruned, 0);
    const contents = readdirSync(r.path!);
    assert.ok(contents.includes('features.json'), 'features.json synthesized from store');
    assert.ok(contents.includes('config.json'), 'config.json copied from disk');
    assert.match(r.path!, /\d+-iter-001$/);
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — returns null path when store empty + no markdown files', async () => {
  const fx = makeStateDir();
  try {
    const r = await snapshotState(fx.dir, 1, {}, stateCtx({ stateDir: fx.dir }));
    assert.equal(r.path, null);
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — prunes oldest beyond retention', async () => {
  const fx = makeStateDir();
  try {
    seedMemoryStore(fx.dir, [{ id: 'F-001', title: '', status: 'passed', attempts: 0 }]);
    const ctx = stateCtx({ stateDir: fx.dir });
    await snapshotState(fx.dir, 1, { snapshotRetention: 2 }, ctx);
    // Pre-create older snapshot dirs with explicit names (sort by ts prefix).
    const snapshotsRoot = join(fx.dir, 'snapshots');
    mkdirSync(join(snapshotsRoot, '1000000000-iter-002'), { recursive: true });
    mkdirSync(join(snapshotsRoot, '1000000001-iter-003'), { recursive: true });
    mkdirSync(join(snapshotsRoot, '1000000002-iter-004'), { recursive: true });
    // Now 4 dirs total. retention=2 → drop 2 oldest after the next snapshot
    // (which adds one more = 5 → 3 pruned).
    const r = await snapshotState(fx.dir, 5, { snapshotRetention: 2 }, ctx);
    assert.equal(r.pruned, 3);
    const remaining = readdirSync(snapshotsRoot);
    assert.equal(remaining.length, 2);
    assert.ok(!remaining.includes('1000000000-iter-002'));
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — respects custom retention', async () => {
  const fx = makeStateDir();
  try {
    seedMemoryStore(fx.dir, [{ id: 'F-001', title: '', status: 'passed', attempts: 0 }]);
    const ctx = stateCtx({ stateDir: fx.dir });
    const r1 = await snapshotState(fx.dir, 1, { snapshotRetention: 50 }, ctx);
    assert.equal(r1.pruned, 0);
  } finally {
    fx.cleanup();
  }
});
