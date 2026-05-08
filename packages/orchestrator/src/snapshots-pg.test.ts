import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  snapshotStatePg,
  listSnapshotsPg,
  readSnapshotPg,
} from './snapshots-pg';

interface MockState {
  rows: Array<Record<string, unknown>>;
  queries: string[];
  values: unknown[][];
}

function makeMockPg(initialRows: Array<Record<string, unknown>> = []): {
  pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  state: MockState;
} {
  const state: MockState = { rows: [...initialRows], queries: [], values: [] };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    state.queries.push(sql);
    state.values.push(vals);
    if (/INSERT INTO harness_shared\.harness_snapshots/.test(sql)) {
      const [
        workspace_id, harness_slug, snapshot_id, iteration,
        features_json, validation_md, notes_md, config_json, taken_at,
      ] = vals;
      const exists = state.rows.find((r) => r.snapshot_id === snapshot_id);
      if (exists) return [];
      state.rows.push({
        workspace_id, harness_slug, snapshot_id, iteration,
        features_json, validation_md, notes_md, config_json, taken_at,
      });
      return [];
    }
    if (/DELETE FROM harness_shared\.harness_snapshots/.test(sql)) {
      // The retention cap is the last interpolated value
      const retention = vals[vals.length - 1] as number;
      const sorted = [...state.rows].sort(
        (a, b) => (b.taken_at as number) - (a.taken_at as number),
      );
      const toKeep = sorted.slice(0, retention);
      const toDrop = sorted.slice(retention);
      state.rows = toKeep;
      return toDrop.map((r) => ({ snapshot_id: r.snapshot_id }));
    }
    if (/SELECT snapshot_id, iteration, taken_at/.test(sql)) {
      return [...state.rows]
        .sort((a, b) => (b.taken_at as number) - (a.taken_at as number))
        .map((r) => ({ snapshot_id: r.snapshot_id, iteration: r.iteration, taken_at: r.taken_at }));
    }
    if (/SELECT snapshot_id, iteration, features_json/.test(sql)) {
      const id = vals[2];
      const r = state.rows.find((x) => x.snapshot_id === id);
      return r ? [r] : [];
    }
    return [];
  };
  return { pg, state };
}

const ctx = (mock: ReturnType<typeof makeMockPg>) => ({
  pg: mock.pg,
  workspaceId: 'default',
  harnessSlug: 'sheets',
});

describe('snapshots-pg', () => {
  test('snapshotStatePg — INSERTs row with all artifact bodies', async () => {
    const mock = makeMockPg();
    const { snapshotId, pruned } = await snapshotStatePg(ctx(mock), {
      snapshotId: '1000-iter-001',
      iteration: 1,
      featuresJson: '{"features":[]}',
      validationMd: '## contract',
      notesMd: '# notes',
      configJson: '{"slug":"sheets"}',
      takenAt: 1000,
    }, 50);
    assert.equal(snapshotId, '1000-iter-001');
    assert.equal(pruned, 0);
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].features_json, '{"features":[]}');
    assert.equal(mock.state.rows[0].validation_md, '## contract');
  });

  test('snapshotStatePg — prunes oldest beyond retention', async () => {
    const mock = makeMockPg();
    // Insert 5 snapshots with retention 3 — should prune 2 oldest after the 5th
    for (let i = 1; i <= 5; i++) {
      await snapshotStatePg(ctx(mock), {
        snapshotId: `t${i}-iter-00${i}`,
        iteration: i,
        featuresJson: null, validationMd: null, notesMd: null, configJson: null,
        takenAt: i * 1000,
      }, 3);
    }
    // After 5 inserts with retention 3, only the 3 newest should remain
    assert.equal(mock.state.rows.length, 3);
    const ids = mock.state.rows.map((r) => r.snapshot_id).sort();
    assert.deepEqual(ids, ['t3-iter-003', 't4-iter-004', 't5-iter-005']);
  });

  test('listSnapshotsPg — returns all snapshots in newest-first order', async () => {
    const mock = makeMockPg();
    for (const t of [1000, 3000, 2000]) {
      await snapshotStatePg(ctx(mock), {
        snapshotId: `s${t}`, iteration: 1,
        featuresJson: null, validationMd: null, notesMd: null, configJson: null,
        takenAt: t,
      }, 50);
    }
    const list = await listSnapshotsPg(ctx(mock));
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.snapshotId), ['s3000', 's2000', 's1000']);
  });

  test('readSnapshotPg — round-trips the full payload', async () => {
    const mock = makeMockPg();
    await snapshotStatePg(ctx(mock), {
      snapshotId: 'roundtrip-1',
      iteration: 7,
      featuresJson: '[{"id":"F-001"}]',
      validationMd: '## v',
      notesMd: '# n',
      configJson: '{"k":1}',
      takenAt: 12345,
    }, 50);
    const read = await readSnapshotPg(ctx(mock), 'roundtrip-1');
    assert.ok(read);
    assert.equal(read!.iteration, 7);
    assert.equal(read!.featuresJson, '[{"id":"F-001"}]');
    assert.equal(read!.validationMd, '## v');
    assert.equal(read!.notesMd, '# n');
    assert.equal(read!.configJson, '{"k":1}');
  });

  test('readSnapshotPg — returns null when absent', async () => {
    const mock = makeMockPg();
    const read = await readSnapshotPg(ctx(mock), 'nope');
    assert.equal(read, null);
  });

  test('snapshotStatePg — re-insert with same snapshot_id is a no-op', async () => {
    const mock = makeMockPg();
    await snapshotStatePg(ctx(mock), {
      snapshotId: 'dup', iteration: 1,
      featuresJson: 'first', validationMd: null, notesMd: null, configJson: null,
      takenAt: 1000,
    }, 50);
    await snapshotStatePg(ctx(mock), {
      snapshotId: 'dup', iteration: 2,
      featuresJson: 'second', validationMd: null, notesMd: null, configJson: null,
      takenAt: 2000,
    }, 50);
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].features_json, 'first', 'first insert wins');
  });
});
