import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  persistPlan,
  setChunkStatus,
  updateChunkPlan,
  readPlan,
  dropPlan,
  normalizeStoredFiles,
  type ChunkPlanPgCtx,
} from './chunk-plan-pg.js';
import type { OrchestratorPg } from './invoke.js';

// Legacy chunk_plans rows (pre-pgJson fix) stored `files` double-encoded: a
// JSON-stringified array landed in the jsonb column as a STRING, not an array.
// readPlan must tolerate those so resuming an old plan doesn't crash the chunk
// loop with `paths.map is not a function`. Current writes store a proper array.
test('normalizeStoredFiles: arrays pass through; legacy jsonb-string parses; junk → []', () => {
  assert.deepEqual(normalizeStoredFiles(['a.ts', 'b.ts']), ['a.ts', 'b.ts']);
  assert.deepEqual(normalizeStoredFiles('["a.ts","b.ts"]'), ['a.ts', 'b.ts']);
  assert.deepEqual(normalizeStoredFiles(null), []);
  assert.deepEqual(normalizeStoredFiles(undefined), []);
  assert.deepEqual(normalizeStoredFiles(['a.ts', 5, null]), ['a.ts']);
});

/**
 * Mock postgres-js client. Records every call, plus stores rows for
 * INSERT and lets us drive what SELECT returns. The actual SQL strings
 * are joined from the tagged-template parts so we can assert on them.
 */
function makeMockPg(): {
  pg: OrchestratorPg;
  calls: Array<{ sql: string; params: unknown[] }>;
  rows: Array<Record<string, unknown>>;
  selectResult: Record<string, unknown>[];
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const state = { selectResult: [] as Record<string, unknown>[] };

  const pg = ((template: TemplateStringsArray, ...values: unknown[]) => {
    const sql = template.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, params: values });
    if (/^select\b/i.test(sql)) {
      return Promise.resolve(state.selectResult);
    }
    return Promise.resolve(rows);
  }) as OrchestratorPg;

  return {
    pg,
    calls,
    rows,
    get selectResult() {
      return state.selectResult;
    },
    set selectResult(rows: Record<string, unknown>[]) {
      state.selectResult = rows;
    },
  };
}

const ctx = (pg: OrchestratorPg): ChunkPlanPgCtx => ({
  pg,
  workspaceId: 'ws-default',
  harnessSlug: 'sheets',
});

test('persistPlan deletes any existing rows then inserts new chunks', async () => {
  const m = makeMockPg();
  await persistPlan(ctx(m.pg), {
    featureId: 'F-X',
    chunks: [
      { id: 'F-X-1', files: ['a.ts'], description: 'add foo()' },
      { id: 'F-X-2', files: ['a.ts', 'b.ts'], description: 'wire bar' },
    ],
  });
  // First call: DELETE WHERE feature_id = F-X
  assert.match(m.calls[0].sql, /^delete from harness_shared\.harness_chunk_plans/i);
  assert.deepEqual(m.calls[0].params, ['ws-default', 'sheets', 'F-X']);
  // 2nd + 3rd: INSERT one row per chunk.
  assert.equal(m.calls.length, 3);
  assert.match(m.calls[1].sql, /^insert into harness_shared\.harness_chunk_plans/i);
  // Each insert includes (workspaceId, harnessSlug, featureId, chunkId, index, files, description, status)
  assert.equal(m.calls[1].params[3], 'F-X-1');
  assert.equal(m.calls[1].params[4], 1);
  assert.equal(m.calls[2].params[3], 'F-X-2');
  assert.equal(m.calls[2].params[4], 2);
});

test('persistPlan with empty chunks just deletes', async () => {
  const m = makeMockPg();
  await persistPlan(ctx(m.pg), { featureId: 'F-X', chunks: [] });
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].sql, /^delete from/i);
});

// Audit P-020: when the client supports transactions (postgres-js `.begin` —
// every production caller), the DELETE + INSERTs must all run inside it; the
// non-begin path above is the test-double fallback only.
test('persistPlan runs delete+inserts inside sql.begin when the client supports it', async () => {
  const outerCalls: Array<{ sql: string }> = [];
  const txCalls: Array<{ sql: string; params: unknown[] }> = [];
  let began = false;
  const tx = ((template: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ sql: template.join('?').replace(/\s+/g, ' ').trim(), params: values });
    return Promise.resolve([]);
  }) as OrchestratorPg;
  const pgWithBegin = Object.assign(
    ((template: TemplateStringsArray) => {
      outerCalls.push({ sql: template.join('?') });
      return Promise.resolve([]);
    }) as OrchestratorPg,
    {
      begin: async <T,>(fn: (t: OrchestratorPg) => Promise<T>): Promise<T> => {
        began = true;
        return fn(tx);
      },
    },
  );
  await persistPlan(
    { pg: pgWithBegin, workspaceId: 'ws-default', harnessSlug: 'sheets' },
    {
      featureId: 'F-X',
      chunks: [
        { id: 'F-X-1', files: ['a.ts'], description: 'add foo()' },
        { id: 'F-X-2', files: ['b.ts'], description: 'wire bar' },
      ],
    },
  );
  assert.equal(began, true);
  assert.equal(outerCalls.length, 0); // nothing bypasses the transaction
  assert.equal(txCalls.length, 3); // DELETE + one INSERT per chunk, all on the tx
  assert.match(txCalls[0].sql, /^delete from harness_shared\.harness_chunk_plans/i);
  assert.match(txCalls[1].sql, /^insert into harness_shared\.harness_chunk_plans/i);
  assert.match(txCalls[2].sql, /^insert into harness_shared\.harness_chunk_plans/i);
});

test('setChunkStatus updates the row and bumps updated_ts', async () => {
  const m = makeMockPg();
  await setChunkStatus(ctx(m.pg), 'F-X', 'F-X-3', 'in_progress');
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].sql, /update harness_shared\.harness_chunk_plans/i);
  // status param then strikes/last_error/commit_sha (null) then updated_ts (number)
  // then the WHERE-clause params (workspace, slug, feature_id, chunk_id).
  const p = m.calls[0].params;
  assert.equal(p[0], 'in_progress');
  assert.equal(p[1], null); // strikes
  assert.equal(p[2], null); // lastError
  assert.equal(p[3], null); // commitSha
  assert.equal(typeof p[4], 'number'); // updated_ts
  assert.equal(p[5], 'ws-default');
  assert.equal(p[6], 'sheets');
  assert.equal(p[7], 'F-X');
  assert.equal(p[8], 'F-X-3');
});

test('setChunkStatus with extras passes through strikes/lastError/commitSha', async () => {
  const m = makeMockPg();
  await setChunkStatus(ctx(m.pg), 'F-X', 'F-X-3', 'failing', {
    strikes: 2,
    lastError: 'TS2345 cannot find name',
    commitSha: 'abc1234',
  });
  const p = m.calls[0].params;
  assert.equal(p[0], 'failing');
  assert.equal(p[1], 2);
  assert.equal(p[2], 'TS2345 cannot find name');
  assert.equal(p[3], 'abc1234');
});

test('updateChunkPlan rewrites files + description and resets status', async () => {
  const m = makeMockPg();
  await updateChunkPlan(ctx(m.pg), 'F-X', {
    id: 'F-X-3',
    files: ['a.ts', 'b.ts', 'c.ts'],
    description: 'extract foo and update callers',
  });
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].sql, /^update harness_shared\.harness_chunk_plans/i);
  // Files passed via sql.json — a mock observes the raw array.
  assert.deepEqual(m.calls[0].params[0], ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(m.calls[0].params[1], 'extract foo and update callers');
});

test('readPlan returns rows in the canonical shape', async () => {
  const m = makeMockPg();
  m.selectResult = [
    {
      chunk_id: 'F-X-1',
      chunk_index: 1,
      files: ['a.ts'],
      description: 'add foo',
      status: 'committed',
      strikes: 0,
      last_error: null,
      commit_sha: 'abc1234',
    },
    {
      chunk_id: 'F-X-2',
      chunk_index: 2,
      files: ['a.ts', 'b.ts'],
      description: 'wire bar',
      status: 'in_progress',
      strikes: 0,
      last_error: null,
      commit_sha: null,
    },
  ];
  const got = await readPlan(ctx(m.pg), 'F-X');
  assert.equal(got.length, 2);
  assert.equal(got[0].chunkId, 'F-X-1');
  assert.equal(got[0].index, 1);
  assert.equal(got[0].status, 'committed');
  assert.equal(got[0].commitSha, 'abc1234');
  assert.equal(got[1].lastError, null);
  assert.equal(got[1].commitSha, null);
});

test('readPlan handles null strikes from DB defensively', async () => {
  const m = makeMockPg();
  m.selectResult = [
    {
      chunk_id: 'F-X-1',
      chunk_index: 1,
      files: ['a.ts'],
      description: 'add foo',
      status: 'pending',
      strikes: null, // DB returns NULL on rare race conditions
      last_error: null,
      commit_sha: null,
    },
  ];
  const got = await readPlan(ctx(m.pg), 'F-X');
  assert.equal(got[0].strikes, 0);
});

test('dropPlan deletes all rows for a feature', async () => {
  const m = makeMockPg();
  await dropPlan(ctx(m.pg), 'F-X');
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].sql, /^delete from harness_shared\.harness_chunk_plans/i);
  assert.deepEqual(m.calls[0].params, ['ws-default', 'sheets', 'F-X']);
});

test('all helpers always scope by workspace_id (RLS belt-and-suspenders)', async () => {
  // Even though the table has RLS enforced at the DB layer, the
  // application-level WHERE clause should include workspace_id so a
  // misconfigured session (no app.workspace_id setting) doesn't
  // accidentally silently see no rows / write to no rows.
  const m = makeMockPg();
  await persistPlan(ctx(m.pg), { featureId: 'F-Y', chunks: [{ id: 'F-Y-1', files: ['x'], description: 'add x' }] });
  await setChunkStatus(ctx(m.pg), 'F-Y', 'F-Y-1', 'committed');
  await updateChunkPlan(ctx(m.pg), 'F-Y', { id: 'F-Y-1', files: ['x'], description: 'add x' });
  await readPlan(ctx(m.pg), 'F-Y');
  await dropPlan(ctx(m.pg), 'F-Y');

  for (const call of m.calls) {
    assert.ok(
      call.params.some((p) => p === 'ws-default'),
      `call should include workspace_id 'ws-default' in params: ${call.sql}`,
    );
  }
});
