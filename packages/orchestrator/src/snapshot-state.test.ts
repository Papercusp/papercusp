import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotState } from './snapshot-state.js';

function makeStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-snap-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('snapshotState — creates dir + copies state files', () => {
  const fx = makeStateDir();
  writeFileSync(join(fx.dir, 'features.json'), '{"features":[]}');
  writeFileSync(join(fx.dir, 'config.json'), '{"phase":"staging"}');
  try {
    const r = snapshotState(fx.dir, 1, {});
    assert.ok(r.path);
    assert.equal(r.pruned, 0);
    const contents = readdirSync(r.path!);
    assert.ok(contents.includes('features.json'));
    assert.ok(contents.includes('config.json'));
    // Dir name: <ts>-iter-001
    assert.match(r.path!, /\d+-iter-001$/);
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — returns null path when no state files exist', () => {
  const fx = makeStateDir();
  try {
    const r = snapshotState(fx.dir, 1, {});
    assert.equal(r.path, null);
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — prunes oldest beyond retention', async () => {
  const fx = makeStateDir();
  writeFileSync(join(fx.dir, 'features.json'), '{}');
  try {
    // Snapshot 5 times; retention=2 → expect 3 pruned on the last call.
    snapshotState(fx.dir, 1, { snapshotRetention: 2 });
    // Sleep enough that the second snapshot's name (ts-prefix) > the first.
    // Math.floor(Date.now()/1000) is per-second granularity, so just call
    // them in a loop with manual ts adjustments via mkdir bypass.
    // Easier: pre-create older snapshot dirs with explicit names.
    const snapshotsRoot = join(fx.dir, 'snapshots');
    mkdirSync(join(snapshotsRoot, '1000000000-iter-002'), { recursive: true });
    mkdirSync(join(snapshotsRoot, '1000000001-iter-003'), { recursive: true });
    mkdirSync(join(snapshotsRoot, '1000000002-iter-004'), { recursive: true });
    // Now 4 dirs total (the just-created one with current ts + 3 older).
    // retention=2 → drop 2 oldest.
    const r = snapshotState(fx.dir, 5, { snapshotRetention: 2 });
    assert.equal(r.pruned, 3); // 4 → 5 (just made) → 3 dropped.
    const remaining = readdirSync(snapshotsRoot);
    // Only 2 left, both newest.
    assert.equal(remaining.length, 2);
    assert.ok(!remaining.includes('1000000000-iter-002'));
  } finally {
    fx.cleanup();
  }
});

test('snapshotState — respects custom retention', () => {
  const fx = makeStateDir();
  writeFileSync(join(fx.dir, 'features.json'), '{}');
  try {
    const r1 = snapshotState(fx.dir, 1, { snapshotRetention: 50 });
    assert.equal(r1.pruned, 0);
  } finally {
    fx.cleanup();
  }
});
