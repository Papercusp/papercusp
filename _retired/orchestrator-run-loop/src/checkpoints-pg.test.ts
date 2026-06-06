import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  fireCheckpointPg,
  listCheckpointsPg,
  clearGrantedCheckpointsPg,
  grantCheckpointPg,
} from './checkpoints-pg';

interface MockState {
  rows: Array<{
    harness_slug: string;
    name: string;
    content: string;
    waiting_since_ms: number;
    granted: boolean;
    consumed: boolean;
    workspace_id: string;
  }>;
  queries: string[];
  notifies: Array<{ channel: string; payload: string }>;
}

function makeMockPg(initialRows: Partial<MockState['rows'][number]>[] = []): {
  pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  state: MockState;
} {
  const state: MockState = {
    rows: initialRows.map((r) => ({
      harness_slug: r.harness_slug ?? 'sheets',
      name: r.name ?? '',
      content: r.content ?? '',
      waiting_since_ms: r.waiting_since_ms ?? 0,
      granted: r.granted ?? false,
      consumed: r.consumed ?? false,
      workspace_id: r.workspace_id ?? 'default',
    })),
    queries: [],
    notifies: [],
  };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    state.queries.push(sql);
    if (/SELECT pg_notify\('sync_invalidate'/.test(sql)) {
      state.notifies.push({ channel: 'sync_invalidate', payload: vals[0] as string });
      return [];
    }
    if (/INSERT INTO harness_shared\.harness_checkpoints/.test(sql)) {
      // (harness_slug, name, content, waiting_since_ms, granted, consumed, workspace_id)
      const [harness_slug, name, content, waiting_since_ms, , , workspace_id] = vals;
      const exists = state.rows.find(
        (r) => r.harness_slug === harness_slug && r.name === name,
      );
      if (exists) return [];
      state.rows.push({
        harness_slug: harness_slug as string,
        name: name as string,
        content: content as string,
        waiting_since_ms: waiting_since_ms as number,
        granted: false,
        consumed: false,
        workspace_id: workspace_id as string,
      });
      return [{ inserted: true }];
    }
    if (/UPDATE harness_shared\.harness_checkpoints[\s\S]*SET consumed = true/.test(sql)) {
      const cleared: { name: string }[] = [];
      for (const r of state.rows) {
        if (r.granted && !r.consumed) {
          r.consumed = true;
          cleared.push({ name: r.name });
        }
      }
      return cleared;
    }
    if (/UPDATE harness_shared\.harness_checkpoints[\s\S]*SET granted = true/.test(sql)) {
      const name = vals[2] as string;
      const r = state.rows.find(
        (x) => x.name === name && !x.granted && !x.consumed,
      );
      if (!r) return [];
      r.granted = true;
      return [{ updated: true }];
    }
    if (/SELECT name, granted FROM harness_shared\.harness_checkpoints/.test(sql)) {
      return state.rows
        .filter((r) => !r.consumed)
        .sort((a, b) => a.waiting_since_ms - b.waiting_since_ms)
        .map((r) => ({ name: r.name, granted: r.granted }));
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

describe('checkpoints-pg', () => {
  test('fireCheckpointPg — inserts pending row + emits notify', async () => {
    const mock = makeMockPg();
    const inserted = await fireCheckpointPg(ctx(mock), 'plan-review', '# body');
    assert.equal(inserted, true);
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].name, 'plan-review');
    assert.equal(mock.state.rows[0].granted, false);
    assert.equal(mock.state.rows[0].consumed, false);
    assert.equal(mock.state.notifies.length, 1);
    assert.equal(mock.state.notifies[0].channel, 'sync_invalidate');
    const payload = JSON.parse(mock.state.notifies[0].payload);
    assert.equal(payload.name, 'harnessCheckpoints.byHarness');
    assert.equal(payload.args.harnessSlug, 'sheets');
  });

  test('fireCheckpointPg — second fire is a no-op (row exists, even if consumed)', async () => {
    const mock = makeMockPg([{ name: 'plan-review', granted: true, consumed: true }]);
    const inserted = await fireCheckpointPg(ctx(mock), 'plan-review', '# body');
    assert.equal(inserted, false);
    assert.equal(mock.state.notifies.length, 0);
  });

  test('listCheckpointsPg — returns pending and granted, ignores consumed', async () => {
    const mock = makeMockPg([
      { name: 'a', granted: false, consumed: false, waiting_since_ms: 1 },
      { name: 'b', granted: true, consumed: false, waiting_since_ms: 2 },
      { name: 'c', granted: true, consumed: true, waiting_since_ms: 3 },
    ]);
    const status = await listCheckpointsPg(ctx(mock));
    assert.deepEqual(status.pending, ['a']);
    assert.deepEqual(status.granted, ['b']);
  });

  test('clearGrantedCheckpointsPg — flips granted-not-consumed to consumed', async () => {
    const mock = makeMockPg([
      { name: 'a', granted: false, consumed: false },
      { name: 'b', granted: true, consumed: false },
      { name: 'c', granted: true, consumed: false },
    ]);
    const cleared = await clearGrantedCheckpointsPg(ctx(mock));
    assert.deepEqual(cleared.sort(), ['b', 'c']);
    assert.equal(mock.state.rows.find((r) => r.name === 'b')!.consumed, true);
    assert.equal(mock.state.rows.find((r) => r.name === 'a')!.consumed, false);
  });

  test('grantCheckpointPg — flips pending to granted, emits sync_invalidate notify', async () => {
    const mock = makeMockPg([{ name: 'plan', granted: false, consumed: false }]);
    const updated = await grantCheckpointPg(ctx(mock), 'plan');
    assert.equal(updated, true);
    assert.equal(mock.state.rows[0].granted, true);
    assert.equal(mock.state.notifies.length, 1);
    assert.equal(mock.state.notifies[0].channel, 'sync_invalidate');
    const payload = JSON.parse(mock.state.notifies[0].payload);
    assert.equal(payload.name, 'harnessCheckpoints.byHarness');
    assert.equal(payload.args.harnessSlug, 'sheets');
  });

  test('grantCheckpointPg — returns false if already granted', async () => {
    const mock = makeMockPg([{ name: 'plan', granted: true, consumed: false }]);
    const updated = await grantCheckpointPg(ctx(mock), 'plan');
    assert.equal(updated, false);
    assert.equal(mock.state.notifies.length, 0);
  });

  test('grantCheckpointPg — returns false if already consumed', async () => {
    const mock = makeMockPg([{ name: 'plan', granted: true, consumed: true }]);
    const updated = await grantCheckpointPg(ctx(mock), 'plan');
    assert.equal(updated, false);
  });
});
