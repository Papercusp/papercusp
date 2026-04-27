import { test } from 'node:test';
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
