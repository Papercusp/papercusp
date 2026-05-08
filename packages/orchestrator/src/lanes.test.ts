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
  isCompetitionMode,
  isLaneMode,
  parallelMaxWorkers,
  parallelMode,
  parallelWorkersPerFeature,
  parseCompetitionVerdict,
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

test('parallelMode — defaults to lane', () => {
  assert.equal(parallelMode({}), 'lane');
  assert.equal(parallelMode({ parallelWorkers: { mode: 'unknown' } }), 'lane');
  assert.equal(parallelMode({ parallelWorkers: { mode: 'competition' } }), 'competition');
});

test('isCompetitionMode — requires mode + max + branchIso + worktrees', () => {
  // missing branchIso
  assert.equal(
    isCompetitionMode({ parallelWorkers: { max: 4, mode: 'competition' } }),
    false,
  );
  // branchIso but no worktrees
  assert.equal(
    isCompetitionMode({
      parallelWorkers: { max: 4, mode: 'competition' },
      branchIsolation: { enabled: true },
    }),
    false,
  );
  // all gates satisfied
  assert.equal(
    isCompetitionMode({
      parallelWorkers: { max: 4, mode: 'competition' },
      branchIsolation: { enabled: true, useWorktrees: true },
    }),
    true,
  );
  // max=1 disables even with everything else on
  assert.equal(
    isCompetitionMode({
      parallelWorkers: { max: 1, mode: 'competition' },
      branchIsolation: { enabled: true, useWorktrees: true },
    }),
    false,
  );
});

test('isLaneMode — requires max>1 + branchIso (no worktrees needed)', () => {
  assert.equal(isLaneMode({}), false);
  assert.equal(isLaneMode({ parallelWorkers: { max: 4 } }), false, 'no branchIso');
  assert.equal(
    isLaneMode({ parallelWorkers: { max: 4 }, branchIsolation: { enabled: true } }),
    true,
  );
  // mode=competition is exclusive
  assert.equal(
    isLaneMode({
      parallelWorkers: { max: 4, mode: 'competition' },
      branchIsolation: { enabled: true },
    }),
    false,
  );
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

test('parseCompetitionVerdict — winner lane', () => {
  const out = `Some validator notes
COMPETITION_WINNER lane-2
More notes`;
  assert.deepEqual(parseCompetitionVerdict(out), { kind: 'winner', lane: 2 });
});

test('parseCompetitionVerdict — none', () => {
  assert.deepEqual(
    parseCompetitionVerdict('All lanes failed.\nCOMPETITION_WINNER none'),
    { kind: 'none' },
  );
});

test('parseCompetitionVerdict — absent (no marker)', () => {
  assert.deepEqual(parseCompetitionVerdict('regular validator output'), {
    kind: 'absent',
  });
});

test('parseCompetitionVerdict — case insensitive', () => {
  // Some agents lowercase decision verbs by accident.
  assert.deepEqual(
    parseCompetitionVerdict('competition_winner lane-7'),
    { kind: 'winner', lane: 7 },
  );
});

// ─── Hybrid competition (workersPerFeature) ─────────────────────

test('parallelWorkersPerFeature — defaults to 1 in lane mode (no override)', () => {
  assert.equal(parallelWorkersPerFeature({ parallelWorkers: { max: 10, mode: 'lane' } }), 1);
});

test('parallelWorkersPerFeature — defaults to max in competition mode (back-compat)', () => {
  assert.equal(
    parallelWorkersPerFeature({ parallelWorkers: { max: 10, mode: 'competition' } }),
    10,
    'competition without workersPerFeature preserves legacy "all on one" behavior',
  );
});

test('parallelWorkersPerFeature — explicit value wins', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 10, mode: 'competition', workersPerFeature: 2 },
    }),
    2,
    'hybrid: 2 workers per feature, 10 max → 5 simultaneous competitions',
  );
});

test('parallelWorkersPerFeature — invalid (0/neg/NaN) falls back to mode default', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 8, mode: 'competition', workersPerFeature: 0 },
    }),
    8,
    'fallback to max for competition',
  );
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 4, mode: 'competition', workersPerFeature: -2 },
    }),
    4,
  );
});

test('parallelWorkersPerFeature — floors fractional values', () => {
  assert.equal(
    parallelWorkersPerFeature({
      parallelWorkers: { max: 10, mode: 'competition', workersPerFeature: 2.7 },
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
