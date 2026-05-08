import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  fireCheckpointPg,
  listCheckpointsPg,
  clearGrantedCheckpointsPg,
  grantCheckpointPg,
} from './checkpoints-pg';

interface MockState {
  rows: Array<{ name: string; status: string; body_md: string }>;
  queries: string[];
  notifies: Array<{ channel: string; payload: string }>;
}

function makeMockPg(initialRows: Array<{ name: string; status: string; body_md?: string }> = []): {
  pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  state: MockState;
} {
  const state: MockState = {
    rows: initialRows.map((r) => ({ name: r.name, status: r.status, body_md: r.body_md ?? '' })),
    queries: [],
    notifies: [],
  };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    state.queries.push(sql);
    if (/SELECT pg_notify\('checkpoint:fired'/.test(sql)) {
      state.notifies.push({ channel: 'checkpoint:fired', payload: vals[0] as string });
      return [];
    }
    if (/SELECT pg_notify\('checkpoint:granted'/.test(sql)) {
      state.notifies.push({ channel: 'checkpoint:granted', payload: vals[0] as string });
      return [];
    }
    if (/INSERT INTO harness_shared\.harness_checkpoints/.test(sql)) {
      const name = vals[2] as string;
      const bodyMd = vals[3] as string;
      const exists = state.rows.find((r) => r.name === name);
      if (exists) return [];
      state.rows.push({ name, status: 'pending', body_md: bodyMd });
      return [{ inserted: true }];
    }
    if (/UPDATE harness_shared\.harness_checkpoints[\s\S]*status\s*=\s*'consumed'/.test(sql)) {
      const cleared: { name: string }[] = [];
      for (const r of state.rows) {
        if (r.status === 'granted') {
          r.status = 'consumed';
          cleared.push({ name: r.name });
        }
      }
      return cleared;
    }
    if (/UPDATE harness_shared\.harness_checkpoints[\s\S]*status\s*=\s*'granted'/.test(sql)) {
      const name = vals[3] as string;
      const r = state.rows.find((x) => x.name === name && x.status === 'pending');
      if (!r) return [];
      r.status = 'granted';
      return [{ updated: true }];
    }
    if (/SELECT name, status FROM harness_shared\.harness_checkpoints/.test(sql)) {
      return state.rows
        .filter((r) => r.status === 'pending' || r.status === 'granted')
        .map((r) => ({ name: r.name, status: r.status }));
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
    assert.equal(mock.state.rows[0].status, 'pending');
    assert.equal(mock.state.notifies.length, 1);
    assert.equal(mock.state.notifies[0].channel, 'checkpoint:fired');
    const payload = JSON.parse(mock.state.notifies[0].payload);
    assert.equal(payload.harness, 'sheets');
    assert.equal(payload.name, 'plan-review');
  });

  test('fireCheckpointPg — second fire is a no-op (sentinel-like dedupe)', async () => {
    const mock = makeMockPg([{ name: 'plan-review', status: 'pending' }]);
    const inserted = await fireCheckpointPg(ctx(mock), 'plan-review', '# body');
    assert.equal(inserted, false);
    // Notify should NOT be emitted on the no-op path
    assert.equal(mock.state.notifies.length, 0);
  });

  test('listCheckpointsPg — returns pending and granted, ignores consumed', async () => {
    const mock = makeMockPg([
      { name: 'a', status: 'pending' },
      { name: 'b', status: 'granted' },
      { name: 'c', status: 'consumed' },
    ]);
    const status = await listCheckpointsPg(ctx(mock));
    assert.deepEqual(status.pending, ['a']);
    assert.deepEqual(status.granted, ['b']);
  });

  test('clearGrantedCheckpointsPg — flips granted to consumed and returns names', async () => {
    const mock = makeMockPg([
      { name: 'a', status: 'pending' },
      { name: 'b', status: 'granted' },
      { name: 'c', status: 'granted' },
    ]);
    const cleared = await clearGrantedCheckpointsPg(ctx(mock));
    assert.deepEqual(cleared.sort(), ['b', 'c']);
    assert.equal(mock.state.rows.find((r) => r.name === 'b')!.status, 'consumed');
    assert.equal(mock.state.rows.find((r) => r.name === 'a')!.status, 'pending');
  });

  test('grantCheckpointPg — flips pending to granted, emits notify', async () => {
    const mock = makeMockPg([{ name: 'plan', status: 'pending' }]);
    const updated = await grantCheckpointPg(ctx(mock), 'plan');
    assert.equal(updated, true);
    assert.equal(mock.state.rows[0].status, 'granted');
    assert.equal(mock.state.notifies.length, 1);
    assert.equal(mock.state.notifies[0].channel, 'checkpoint:granted');
  });

  test('grantCheckpointPg — returns false if no pending row', async () => {
    const mock = makeMockPg([{ name: 'plan', status: 'granted' }]);
    const updated = await grantCheckpointPg(ctx(mock), 'plan');
    assert.equal(updated, false);
    assert.equal(mock.state.notifies.length, 0);
  });
});
