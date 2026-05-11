import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCompetitionManifest,
  competitionManifestPath,
  createLanePool,
  parallelMaxWorkers,
  parallelWorkersPerFeature,
  readCompetitionManifest,
  writeCompetitionManifest,
} from './lanes.js';

function makeStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-orch-lanes-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parallelMaxWorkers — defaults to 1', () => {
  assert.equal(parallelMaxWorkers({}), 1);
  assert.equal(parallelMaxWorkers({ parallelWorkers: {} }), 1);
});

test('parallelMaxWorkers — honors numeric config', () => {
  assert.equal(parallelMaxWorkers({ parallelWorkers: { max: 4 } }), 4);
  // Floors floats.
  assert.equal(parallelMaxWorkers({ parallelWorkers: { max: 4.7 } }), 4);
});

test('parallelMaxWorkers — rejects non-positive / non-numeric', () => {
  assert.equal(parallelMaxWorkers({ parallelWorkers: { max: 0 } }), 1);
  assert.equal(parallelMaxWorkers({ parallelWorkers: { max: -3 } }), 1);
});

test('createLanePool — acquire/release respects max', async () => {
  const fx = makeStateDir();
  try {
    const pool = createLanePool(fx.dir, 2);
    const id1 = await pool.acquire('F-001');
    const id2 = await pool.acquire('F-002');
    assert.equal(pool.count(), 2);

    // Third acquire should block until release fires.
    let acquired3 = false;
    const acq3 = pool.acquire('F-003').then((id) => {
      acquired3 = true;
      return id;
    });
    // Yield a microtask; should still be blocked.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(acquired3, false);

    pool.release(id1);
    const id3 = await acq3;
    assert.equal(acquired3, true);
    assert.equal(pool.count(), 2); // id2 and id3 alive

    pool.release(id2);
    pool.release(id3);
    assert.equal(pool.count(), 0);
    void id3;
  } finally {
    fx.cleanup();
  }
});

test('createLanePool — waitAll resolves when count drops to 0', async () => {
  const fx = makeStateDir();
  try {
    const pool = createLanePool(fx.dir, 4);
    const ids = await Promise.all([
      pool.acquire('F-001'),
      pool.acquire('F-002'),
    ]);
    let waited = false;
    const wait = pool.waitAll().then(() => (waited = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(waited, false, 'waitAll blocks while lanes active');
    pool.release(ids[0]);
    pool.release(ids[1]);
    await wait;
    assert.equal(waited, true);
  } finally {
    fx.cleanup();
  }
});

test('createLanePool — persists lanes.json snapshot', async () => {
  const fx = makeStateDir();
  try {
    const pool = createLanePool(fx.dir, 2);
    await pool.acquire('F-001');
    const lanesFile = join(fx.dir, 'lanes.json');
    assert.ok(existsSync(lanesFile));
    const data = JSON.parse(readFileSync(lanesFile, 'utf8'));
    assert.equal(data.lanes.length, 1);
    assert.equal(data.lanes[0].feature_id, 'F-001');
    assert.equal(typeof data.lanes[0].started_at, 'number');
  } finally {
    fx.cleanup();
  }
});

test('buildCompetitionManifest — composes N lanes', () => {
  const m = buildCompetitionManifest('/tmp/state', 'F-001', 3);
  assert.equal(m.parentFeatureId, 'F-001');
  assert.equal(m.n, 3);
  assert.equal(m.lanes.length, 3);
  assert.deepEqual(m.lanes[0], {
    lane: 1,
    worktree: '/tmp/state/worktrees/F-001-lane-1',
    branch: 'harness/F-001-lane-1',
  });
  assert.equal(m.lanes[2].branch, 'harness/F-001-lane-3');
});

test('writeCompetitionManifest + readCompetitionManifest roundtrip', () => {
  const fx = makeStateDir();
  try {
    const m1 = writeCompetitionManifest(fx.dir, 'F-X', 2);
    const m2 = readCompetitionManifest(fx.dir, 'F-X');
    assert.deepEqual(m1, m2);
    assert.equal(competitionManifestPath(fx.dir, 'F-X'), join(fx.dir, 'competition-F-X.json'));
  } finally {
    fx.cleanup();
  }
});

test('readCompetitionManifest — absent file returns null', () => {
  const fx = makeStateDir();
  try {
    assert.equal(readCompetitionManifest(fx.dir, 'F-NOPE'), null);
  } finally {
    fx.cleanup();
  }
});

test('readCompetitionManifest — malformed JSON returns null', () => {
  const fx = makeStateDir();
  writeFileSync(join(fx.dir, 'competition-F-X.json'), '{not json}');
  try {
    assert.equal(readCompetitionManifest(fx.dir, 'F-X'), null);
  } finally {
    fx.cleanup();
  }
});


// ─── Hybrid competition (workersPerFeature) ─────────────────────

test('parallelWorkersPerFeature — defaults to 1 (no override)', () => {
  assert.equal(parallelWorkersPerFeature({ parallelWorkers: { max: 10 } }), 1);
});

test('parallelWorkersPerFeature — back-compat: legacy mode=competition + no workersPerFeature → max', () => {
  // Pre-synthesizer harnesses configured competition mode and left
  // workersPerFeature unset, expecting it to default to max. Without
  // this back-compat path they silently degrade to single-worker on
  // first run after upgrade.
  assert.equal(
    parallelWorkersPerFeature({ parallelWorkers: { max: 4, mode: 'competition' } }),
    4,
  );
  // Explicit workersPerFeature still wins.
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 8, mode: 'competition', workersPerFeature: 2 },
    }),
    2,
  );
  // mode=lane (or absent) → no back-compat, default stays 1.
  assert.equal(
    parallelWorkersPerFeature({ parallelWorkers: { max: 4, mode: 'lane' } }),
    1,
  );
});

test('parallelWorkersPerFeature — explicit value wins', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 10, workersPerFeature: 2 },
    }),
    2,
    'hybrid: 2 workers per feature, 10 max → 5 simultaneous competitions',
  );
});

test('parallelWorkersPerFeature — invalid (0/neg/NaN) falls back to 1', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 8, workersPerFeature: 0 },
    }),
    1,
  );
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 4, workersPerFeature: -2 },
    }),
    1,
  );
});

test('parallelWorkersPerFeature — floors fractional values', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 10, workersPerFeature: 2.7 },
    }),
    2,
  );
});

test('createLanePool — countForFeature reports per-feature lane counts', async () => {
  const { dir, cleanup } = makeStateDir();
  try {
    const pool = createLanePool(dir, 4);
    await pool.acquire('F-A');
    await pool.acquire('F-A');
    await pool.acquire('F-B');
    assert.equal(pool.count(), 3, 'total = 3');
    assert.equal(pool.countForFeature('F-A'), 2, 'F-A has 2 lanes');
    assert.equal(pool.countForFeature('F-B'), 1, 'F-B has 1 lane');
    assert.equal(pool.countForFeature('F-Z'), 0, 'F-Z has none');
  } finally {
    cleanup();
  }
});

test('createLanePool — waitForFeature resolves only when feature lanes drain', async () => {
  const { dir, cleanup } = makeStateDir();
  try {
    const pool = createLanePool(dir, 4);
    // Capture the actual ids — nextId() is module-global so we can't
    // hardcode 1/2/3 (other tests' acquires bumped the counter).
    const a1 = await pool.acquire('F-A');
    const a2 = await pool.acquire('F-A');
    const b1 = await pool.acquire('F-B'); // unrelated; should NOT block waitForFeature('F-A')

    let drained = false;
    const drainPromise = pool.waitForFeature('F-A').then(() => { drained = true; });

    // Releasing F-B should not resolve waitForFeature('F-A').
    pool.release(b1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(drained, false, 'F-B drain alone does not satisfy waitForFeature(F-A)');

    // Release one of F-A's lanes — still 1 left, should not resolve.
    pool.release(a1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(drained, false, '1 of 2 F-A lanes drained does not resolve waitForFeature(F-A)');

    // Release the second F-A lane — now should resolve.
    pool.release(a2);
    await drainPromise;
    assert.equal(drained, true, 'all F-A lanes drained → waitForFeature(F-A) resolves');
  } finally {
    cleanup();
  }
});

import { workerCountTiers, DEFAULT_WORKER_COUNT_TIERS } from './lanes';

test('workerCountTiers — defaults', () => {
  const out = workerCountTiers({});
  assert.deepEqual(out.tiers, DEFAULT_WORKER_COUNT_TIERS.tiers);
  assert.deepEqual(out.labels, DEFAULT_WORKER_COUNT_TIERS.labels);
  assert.equal(out.rubric, '');
});

test('workerCountTiers — explicit override', () => {
  const out = workerCountTiers({
    parallelWorkers: {
      adaptive: { tiers: [1, 3, 6], labels: ['s', 'm', 'l'], rubric: 'foo' },
    },
  } as any);
  assert.deepEqual(out.tiers, [1, 3, 6]);
  assert.deepEqual(out.labels, ['s', 'm', 'l']);
  assert.equal(out.rubric, 'foo');
});

test('workerCountTiers — falls back when shapes mismatch', () => {
  const out = workerCountTiers({
    parallelWorkers: {
      adaptive: { tiers: [1, 2], labels: ['only-one'], rubric: 'kept' },
    },
  } as any);
  assert.deepEqual(out.tiers, DEFAULT_WORKER_COUNT_TIERS.tiers);
  assert.equal(out.rubric, 'kept');
});

import { resolveWorkerCount } from './lanes';

test('resolveWorkerCount — max=1 always returns 1', () => {
  assert.equal(resolveWorkerCount({} as any, undefined, 10), 1);
  assert.equal(resolveWorkerCount({} as any, 4, 10), 1);
  assert.equal(
    resolveWorkerCount({ parallelWorkers: { max: 1 } } as any, 4, 10),
    1,
  );
});

test('resolveWorkerCount — fixed perFeature path (no tiers)', () => {
  const cfg = {
    parallelWorkers: { max: 8, workersPerFeature: 3 },
  } as any;
  assert.equal(resolveWorkerCount(cfg, undefined, 10), 3);
  // ignored requestedN when no tiers configured
  assert.equal(resolveWorkerCount(cfg, 5, 10), 3);
});

test('resolveWorkerCount — fixed perFeature clamps to availableSlots', () => {
  const cfg = {
    parallelWorkers: { max: 8, workersPerFeature: 4 },
  } as any;
  assert.equal(resolveWorkerCount(cfg, undefined, 2), 2);
  assert.equal(resolveWorkerCount(cfg, undefined, 0), 1);
});

test('resolveWorkerCount — tiers path picks requestedN when in set', () => {
  const cfg = {
    parallelWorkers: {
      max: 8,
      adaptive: { tiers: [1, 2, 4], labels: ['t', 'n', 'h'], rubric: '' },
    },
  } as any;
  assert.equal(resolveWorkerCount(cfg, 4, 10), 4);
  assert.equal(resolveWorkerCount(cfg, 2, 10), 2);
  assert.equal(resolveWorkerCount(cfg, 1, 10), 1);
});

test('resolveWorkerCount — tiers path clamps requestedN to closest ≤ tier', () => {
  const cfg = {
    parallelWorkers: {
      max: 8,
      adaptive: { tiers: [1, 2, 4], labels: ['t', 'n', 'h'], rubric: '' },
    },
  } as any;
  // requested 3 → clamps to 2 (closest ≤)
  assert.equal(resolveWorkerCount(cfg, 3, 10), 2);
  // requested 7 → clamps to 4
  assert.equal(resolveWorkerCount(cfg, 7, 10), 4);
  // requested 0 → falls back to smallest (1)
  assert.equal(resolveWorkerCount(cfg, 0, 10), 1);
});

test('resolveWorkerCount — tiers path clamps to availableSlots', () => {
  const cfg = {
    parallelWorkers: {
      max: 8,
      adaptive: { tiers: [1, 2, 4], labels: ['t', 'n', 'h'], rubric: '' },
    },
  } as any;
  assert.equal(resolveWorkerCount(cfg, 4, 2), 2);
  assert.equal(resolveWorkerCount(cfg, 4, 1), 1);
});

test('resolveWorkerCount — tiers configured but no requestedN → falls back to perFeature', () => {
  const cfg = {
    parallelWorkers: {
      max: 8,
      workersPerFeature: 2,
      adaptive: { tiers: [1, 4], labels: ['t', 'h'], rubric: '' },
    },
  } as any;
  assert.equal(resolveWorkerCount(cfg, undefined, 10), 2);
});

import { hasWorkerCountTiers } from './lanes';

test('hasWorkerCountTiers — explicit adaptive block', () => {
  assert.equal(
    hasWorkerCountTiers({ parallelWorkers: { adaptive: { tiers: [1, 4], labels: ['t', 'h'] } } } as any),
    true,
  );
});

test('hasWorkerCountTiers — back-compat: legacy mode=adaptive with no block', () => {
  // Pre-synthesizer harnesses configured adaptive mode and relied on
  // the default tier set [1,2,4]. Without back-compat they silently
  // degrade to single-worker on first run after upgrade.
  assert.equal(
    hasWorkerCountTiers({ parallelWorkers: { mode: 'adaptive', max: 4 } } as any),
    true,
  );
});

test('hasWorkerCountTiers — mode=competition or lane → no tiers', () => {
  assert.equal(hasWorkerCountTiers({ parallelWorkers: { mode: 'competition' } } as any), false);
  assert.equal(hasWorkerCountTiers({ parallelWorkers: { mode: 'lane' } } as any), false);
  assert.equal(hasWorkerCountTiers({} as any), false);
});

test('resolveWorkerCount — back-compat: legacy mode=adaptive + requestedN picks from default tiers', () => {
  // No explicit adaptive block; legacy mode='adaptive' should still
  // pick from DEFAULT_WORKER_COUNT_TIERS [1, 2, 4].
  const cfg = { parallelWorkers: { max: 8, mode: 'adaptive' } } as any;
  assert.equal(resolveWorkerCount(cfg, 4, 10), 4);
  assert.equal(resolveWorkerCount(cfg, 2, 10), 2);
  // out-of-set requestedN clamps to nearest ≤
  assert.equal(resolveWorkerCount(cfg, 3, 10), 2);
});
