import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  appendChunkPg,
  readChunksAfterPg,
  pruneChunksPg,
} from './run-chunks-pg';
import type { OrchestratorPg } from './invoke';

interface MockState {
  rows: Array<{
    workspace_id: string;
    harness_slug: string;
    run_id: string;
    seq: number;
    chunk_data: string;
    ts: number;
  }>;
  notifies: Array<{ channel: string; payload: string }>;
}

function makeMockPg(): {
  // `OrchestratorPg` is GENERIC (`<T = any[]>(…) => Promise<T>`, mirroring postgres-js's
  // `sql<T>``` so call sites can name their own row type). A concrete non-generic mock can
  // never satisfy that signature, and no implementation can honestly return an arbitrary
  // caller-chosen `T` — postgres-js casts internally for exactly this reason. So the mock is
  // declared as the real seam type and cast once, at the single return below, matching the
  // convention already used at 14 other sites in this package.
  pg: OrchestratorPg;
  state: MockState;
} {
  const state: MockState = { rows: [], notifies: [] };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    if (/SELECT pg_notify/.test(sql)) {
      state.notifies.push({ channel: vals[0] as string, payload: vals[1] as string });
      return [];
    }
    if (/INSERT INTO harness_shared\.harness_run_chunks/.test(sql)) {
      const [workspace_id, harness_slug, run_id, seq, chunk_data, ts] = vals;
      const exists = state.rows.find(
        (r) => r.run_id === run_id && r.seq === seq,
      );
      if (exists) return [];
      state.rows.push({
        workspace_id: workspace_id as string,
        harness_slug: harness_slug as string,
        run_id: run_id as string,
        seq: seq as number,
        chunk_data: chunk_data as string,
        ts: ts as number,
      });
      return [];
    }
    if (/SELECT seq, chunk_data, ts/.test(sql)) {
      const runId = vals[2];
      const fromSeq = vals[3] as number;
      return state.rows
        .filter((r) => r.run_id === runId && r.seq > fromSeq)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({ seq: r.seq, chunk_data: r.chunk_data, ts: r.ts }));
    }
    if (/DELETE FROM harness_shared\.harness_run_chunks/.test(sql)) {
      const runId = vals[2];
      const dropped = state.rows.filter((r) => r.run_id === runId);
      state.rows = state.rows.filter((r) => r.run_id !== runId);
      return dropped.map((r) => ({ seq: r.seq }));
    }
    return [];
  };
  return { pg: pg as unknown as OrchestratorPg, state };
}

const ctx = (mock: ReturnType<typeof makeMockPg>) => ({
  pg: mock.pg,
  workspaceId: 'default',
  harnessSlug: 'sheets',
});

describe('run-chunks-pg', () => {
  test('appendChunkPg — INSERTs row + emits pg_notify on per-run channel', async () => {
    const mock = makeMockPg();
    await appendChunkPg(ctx(mock), 'r1', 0, '{"type":"text_delta","text":"hello"}');
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].seq, 0);
    assert.equal(mock.state.rows[0].chunk_data, '{"type":"text_delta","text":"hello"}');
    assert.equal(mock.state.notifies.length, 1);
    assert.equal(mock.state.notifies[0].channel, 'run:r1');
    assert.equal(mock.state.notifies[0].payload, '0');
  });

  test('appendChunkPg — second call with same seq is a no-op', async () => {
    const mock = makeMockPg();
    await appendChunkPg(ctx(mock), 'r1', 0, 'first');
    await appendChunkPg(ctx(mock), 'r1', 0, 'second');
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].chunk_data, 'first');
  });

  test('readChunksAfterPg — returns chunks after fromSeq in order', async () => {
    const mock = makeMockPg();
    for (let i = 0; i < 5; i++) {
      await appendChunkPg(ctx(mock), 'r1', i, `chunk-${i}`);
    }
    const after2 = await readChunksAfterPg(ctx(mock), 'r1', 2);
    assert.equal(after2.length, 2);
    assert.equal(after2[0].seq, 3);
    assert.equal(after2[1].seq, 4);
    assert.equal(after2[0].chunkData, 'chunk-3');
  });

  test('readChunksAfterPg — returns empty when no new chunks', async () => {
    const mock = makeMockPg();
    await appendChunkPg(ctx(mock), 'r1', 0, 'data');
    const empty = await readChunksAfterPg(ctx(mock), 'r1', 0);
    assert.equal(empty.length, 0);
  });

  test('pruneChunksPg — deletes all chunks for a run; returns count', async () => {
    const mock = makeMockPg();
    for (let i = 0; i < 3; i++) {
      await appendChunkPg(ctx(mock), 'r1', i, `chunk-${i}`);
    }
    await appendChunkPg(ctx(mock), 'other-run', 0, 'unrelated');
    const pruned = await pruneChunksPg(ctx(mock), 'r1');
    assert.equal(pruned, 3);
    assert.equal(mock.state.rows.length, 1);
    assert.equal(mock.state.rows[0].run_id, 'other-run');
  });

  test('appendChunkPg — swallows errors (best-effort streaming)', async () => {
    const failingPg = (async () => {
      throw new Error('pg unreachable');
    }) as unknown as OrchestratorPg;
    // Should not throw — caller relies on this for stream resilience
    await appendChunkPg(
      { pg: failingPg, workspaceId: 'default', harnessSlug: 'sheets' },
      'r1',
      0,
      'data',
    );
  });
});
