/**
 * acquire-registry — unit tests (no DB; pure in-memory counters).
 * EI-19485014132257783 / EI-19448641861408544.
 *
 * The property under test is not "the counters increment". It is that the
 * SENTENCE the counters produce is only ever as strong as the measurement
 * behind it — which is the failure this module exists to end. Two rewrites of
 * the deadline errors (EI-19448665862739845, WI-8848) were needed because each
 * one asserted more than it had measured, so the verdict branches are pinned
 * here in both directions: what the numbers RULE OUT, and what they explicitly
 * do not cover.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { resetBuildStampResolver, setBuildStampResolver } from './build-stamp';
import {
  ACQUIRE_RECENT_SUCCESS_MS,
  acquireSnapshot,
  acquireTicketSnapshot,
  beginAcquire,
  describeAcquirePressure,
  PG_RESULT_DIAGNOSTIC_LIMIT,
  pgAcquireTimingSnapshot,
  PG_ACQUIRE_TIMING_LIMIT,
  pgQueryFamily,
  pgResultDiagnosticSnapshot,
  capturePgDiagnosticContext,
  createPgDiagnosticHooks,
  resetPgDiagnosticContextResolver,
  recordPgResult,
  recordPoolMax,
  resetAcquireRegistryForTest,
  setPgDiagnosticContextResolver,
  withPgAcquireDiagnostics,
} from './acquire-registry';
import {
  withAcquisitionDeadline,
  DbCallDeadlineError,
  VITEST_ORG_POOL_MAX,
  processConnectionCeiling,
} from './connection';

beforeEach(() => {
  resetAcquireRegistryForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetPgDiagnosticContextResolver();
  resetAcquireRegistryForTest();
});

describe('acquireSnapshot', () => {
  it('reports an unmeasured pool as max:null, NOT as an idle pool', () => {
    const s = acquireSnapshot('never-built');
    expect(s.max).toBeNull();
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(0);
    expect(s.totalAcquired).toBe(0);
    expect(s.lastAcquiredAgoMs).toBeNull();
  });

  it('counts a waiter from the moment the ticket opens', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(1);
    expect(s.held).toBe(0);
    expect(s.oldestWaitMs).toBeGreaterThanOrEqual(0);
    expect(s.max).toBe(20);
    t.release();
  });

  it('moves waiting -> held on acquired(), and records the success', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(1);
    expect(s.totalAcquired).toBe(1);
    expect(s.lastAcquiredAgoMs).toBeGreaterThanOrEqual(0);
    t.release();
    expect(acquireSnapshot('org-app').held).toBe(0);
  });

  it('release() is idempotent and never drives a count negative', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    t.release();
    t.release();
    t.acquired(); // after release, a late acquired() must not resurrect the ticket
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(0);
    expect(s.totalAcquired).toBe(1);
  });

  it('releasing a ticket that never acquired drops the waiter (no leak)', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    expect(acquireSnapshot('org-app').waiting).toBe(1);
    t.release();
    expect(acquireSnapshot('org-app').waiting).toBe(0);
    expect(acquireSnapshot('org-app').totalAcquired).toBe(0);
  });

  it('keeps pools independent — one saturated pool never reads onto another', () => {
    recordPoolMax('org-app', 2);
    recordPoolMax('org-admin', 8);
    const a = beginAcquire('org-app');
    a.acquired();
    expect(acquireSnapshot('org-app').held).toBe(1);
    expect(acquireSnapshot('org-admin').held).toBe(0);
    a.release();
  });
});

describe('bounded acquisition ticket diagnostics', () => {
  it('captures sanitized labels for the oldest active tickets within the fixed bound', () => {
    let sequence = 0;
    setPgDiagnosticContextResolver(() => {
      const id = String(++sequence).padStart(12, '0');
      return {
        processInstanceId: '11111111-1111-4111-8111-111111111111',
        buildSha: 'abcdef0',
        rowId: null,
        attemptId: '22222222-2222-4222-8222-222222222222',
        hopId: null,
        stage: null,
        boundary: null,
        requestId: `33333333-3333-4333-8333-${id}`,
        operation: 'mcp.nativeSessionVerifier',
      };
    });

    const tickets = Array.from({ length: 10 }, (_, index) => {
      const ticket = beginAcquire('org-admin');
      if (index % 2 === 1) ticket.acquired();
      return ticket;
    });
    const snapshot = acquireTicketSnapshot('org-admin');

    expect(snapshot).toMatchObject({ pool: 'org-admin', capacity: 8, active: 10, omitted: 2 });
    expect(snapshot.tickets).toHaveLength(8);
    expect(snapshot.tickets.map(ticket => ticket.requestId)).toEqual(
      Array.from({ length: 8 }, (_, index) =>
        `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`),
    );
    expect(snapshot.tickets.map(ticket => ticket.state)).toEqual([
      'waiting', 'held', 'waiting', 'held', 'waiting', 'held', 'waiting', 'held',
    ]);
    expect(snapshot.tickets.every(ticket => Number.isFinite(ticket.ageMs) && ticket.ageMs >= 0)).toBe(true);
    expect(snapshot.tickets.every(ticket => ticket.operation === 'mcp.nativeSessionVerifier')).toBe(true);
    tickets.forEach(ticket => ticket.release());
  });

  it('does not retain malformed request or operation labels', () => {
    const unsafeOperation = 'postgresql://secret:credential@host/db';
    setPgDiagnosticContextResolver(() => ({
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: 'abcdef0',
      rowId: null,
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: null,
      stage: null,
      boundary: null,
      requestId: 'not-a-validated-request-id',
      operation: unsafeOperation,
    }));
    const ticket = beginAcquire('org-admin');

    const snapshot = acquireTicketSnapshot('org-admin');
    expect(snapshot.tickets[0]).toMatchObject({ requestId: null, operation: null });
    expect(JSON.stringify(snapshot)).not.toContain('not-a-validated-request-id');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    ticket.release();
  });
});

describe('request-scoped pool acquisition timings', () => {
  it('records successful waits and releases before acquisition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const snapshot = await withPgAcquireDiagnostics('spawner.process.exec', () => {
      const acquired = beginAcquire('org-app');
      vi.setSystemTime(new Date(Date.now() + 17));
      acquired.acquired();
      acquired.release();

      const released = beginAcquire('org-admin');
      vi.setSystemTime(new Date(Date.now() + 9));
      released.release();
      return pgAcquireTimingSnapshot();
    });

    expect(snapshot).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      operation: 'spawner.process.exec',
      capacity: PG_ACQUIRE_TIMING_LIMIT,
      omitted: 0,
      acquisitions: [
        { pool: 'org-app', elapsedMs: 17, outcome: 'acquired' },
        { pool: 'org-admin', elapsedMs: 9, outcome: 'released-before-acquire' },
      ],
    });
  });

  it('caps each async request independently', async () => {
    const snapshots = await Promise.all(['org-app', 'org-admin'].map((pool) =>
      withPgAcquireDiagnostics('spawner.process.exec', async () => {
        const tickets = Array.from({ length: PG_ACQUIRE_TIMING_LIMIT + 2 }, () => beginAcquire(pool));
        await Promise.resolve();
        tickets.forEach((ticket) => ticket.release());
        return pgAcquireTimingSnapshot();
      }),
    ));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.requestId).not.toBe(snapshots[1]?.requestId);
    expect(snapshots.map((snapshot) => snapshot?.acquisitions)).toMatchObject([
      Array.from({ length: PG_ACQUIRE_TIMING_LIMIT }, () => ({ pool: 'org-app', outcome: 'released-before-acquire' })),
      Array.from({ length: PG_ACQUIRE_TIMING_LIMIT }, () => ({ pool: 'org-admin', outcome: 'released-before-acquire' })),
    ]);
    expect(snapshots.map((snapshot) => snapshot?.omitted)).toEqual([2, 2]);
  });
});

describe('bounded PostgreSQL result diagnostics', () => {
  it('classifies an operation/relation without retaining literals, comments, or parameters', () => {
    const family = pgQueryFamily(`
      /* token=do-not-retain */ SELECT payload
      FROM harness_shared.substrate_outbox
      WHERE workspace_id = 'secret-workspace' AND id = $1
    `);
    expect(family).toBe('select:harness_shared.substrate_outbox');
    expect(family).not.toContain('secret');
    expect(family).not.toContain('$1');
  });

  it('retains source identity and result volume but no raw SQL or rows', () => {
    vi.setSystemTime(new Date('2026-09-06T22:00:00.000Z'));
    recordPgResult('org-app', {
      connectionId: 7,
      queryId: 19,
      backendPid: 4123,
      query: `SELECT payload FROM harness_shared.substrate_outbox WHERE token = 'private'`,
      command: 'SELECT',
      rowCount: 200,
      wireBytes: 1_048_576,
      elapsedMs: 83.9,
      status: 'ok',
    });

    const snapshot = pgResultDiagnosticSnapshot('org-app');
    expect(snapshot).toMatchObject({
      pool: 'org-app',
      totalRecorded: 1,
      dropped: 0,
      capacity: PG_RESULT_DIAGNOSTIC_LIMIT,
    });
    expect(snapshot.results).toEqual([
      expect.objectContaining({
        pool: 'org-app',
        source: expect.objectContaining({
          processInstanceId: expect.stringMatching(/^[a-f0-9-]{36}$/i),
          buildSha: null,
          poolInstanceId: null,
        }),
        connectionId: 7,
        queryId: 19,
        backendPid: 4123,
        queryFamily: 'select:harness_shared.substrate_outbox',
        command: 'select',
        rowCount: 200,
        wireBytes: 1_048_576,
        elapsedMs: 83,
        status: 'ok',
        errorCode: null,
        errorClass: null,
        serverRoutine: null,
        correlationState: 'unobserved',
        recordedAt: Date.now(),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('private');
    expect(JSON.stringify(snapshot)).not.toContain('SELECT payload');
  });

  it('preserves finite pre-build durations and keeps unmeasured values unknown', () => {
    for (const preBuildMs of [31.9, 0, -5, NaN, Infinity, undefined, null]) {
      recordPgResult('pre-build-test', {
        connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 10, status: 'ok', elapsedMs: 12, preBuildMs,
      } as Parameters<typeof recordPgResult>[1]);
    }
    expect(pgResultDiagnosticSnapshot('pre-build-test').results.map(row =>
      (row as typeof row & { preBuildMs?: number | null }).preBuildMs,
    )).toEqual([31, 0, 0, null, null, null, null]);
  });
  it('binds a bootstrap pool to the first available loaded build without rewriting historical diagnostics', () => {
    setBuildStampResolver(() => null);
    try {
      const hooks = createPgDiagnosticHooks('bootstrap-build');
      const input = { connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 10, status: 'ok' as const };
      hooks.onresult(input);
      const first = pgResultDiagnosticSnapshot('bootstrap-build').results[0].source;
      expect(first.buildSha).toBeNull();
      setBuildStampResolver(() => 'abcdef1234');
      hooks.onresult({ ...input, queryId: 2 });
      const rows = pgResultDiagnosticSnapshot('bootstrap-build').results;
      expect(rows.map(row => row.source.buildSha)).toEqual([null, 'abcdef1234']);
      expect(rows[1].source.poolInstanceId).toBe(first.poolInstanceId);
      expect(rows[1].source.processInstanceId).toBe(first.processInstanceId);
      // A measured source identity stays pinned; a later resolver cannot relabel it.
      setBuildStampResolver(() => 'ffffffff');
      hooks.onresult({ ...input, queryId: 3 });
      expect(pgResultDiagnosticSnapshot('bootstrap-build').results.map(row => row.source.buildSha))
        .toEqual([null, 'abcdef1234', 'abcdef1234']);
    } finally { resetBuildStampResolver(); }
  });

  it('bounds the FIFO and reports how much older evidence was dropped', () => {
    for (let i = 0; i < PG_RESULT_DIAGNOSTIC_LIMIT + 5; i++) {
      recordPgResult('org-admin', {
        connectionId: i,
        queryId: i + 100,
        backendPid: null,
        query: 'select 1',
        rowCount: i,
        wireBytes: i * 10,
        status: 'ok',
      });
    }

    const snapshot = pgResultDiagnosticSnapshot('org-admin', 3);
    expect(snapshot.totalRecorded).toBe(PG_RESULT_DIAGNOSTIC_LIMIT + 5);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.results.map((r) => r.connectionId)).toEqual([
      PG_RESULT_DIAGNOSTIC_LIMIT + 2,
      PG_RESULT_DIAGNOSTIC_LIMIT + 3,
      PG_RESULT_DIAGNOSTIC_LIMIT + 4,
    ]);
  });

  it('keeps failure-path evidence bounded and normalizes malformed counters', () => {
    recordPgResult('org-app', {
      connectionId: -4,
      queryId: -9,
      backendPid: Number.NaN,
      query: 'vacuum',
      command: 'VACUUM (ANALYZE); DROP TABLE should_not_survive',
      rowCount: -1,
      wireBytes: Number.POSITIVE_INFINITY,
      elapsedMs: -10,
      status: 'error',
      errorCode: '42P01 leaked detail',
    });

    expect(pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
      connectionId: 0,
      queryId: 0,
      backendPid: null,
      queryFamily: 'other',
      command: 'vacuumanalyzedroptableshould_not',
      rowCount: 0,
      wireBytes: 0,
      elapsedMs: 0,
      status: 'error',
      errorCode: '42p01leakeddetai',
    });
  });

  it('retains captured scalar context without consulting a later resolver', () => {
    const correlation = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: 'abcdef1234567',
      rowId: '42',
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: 3,
      stage: 'epoch-query',
      boundary: 'await' as const,
    };
    setPgDiagnosticContextResolver(() => correlation);

    const captured = capturePgDiagnosticContext();
    recordPgResult('org-app', {
      connectionId: 7,
      queryId: 19,
      backendPid: 8123,
      query: 'select 1',
      rowCount: 1,
      wireBytes: 10,
      status: 'ok',
      context: captured,
    });

    expect(pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
      correlationState: 'linked',
      correlation,
    });
    // Same numeric IDs without captured context must not inherit a prior result.
    recordPgResult('org-app', {
      connectionId: 7,
      queryId: 19,
      backendPid: 8123,
      query: 'select 1',
      rowCount: 1,
      wireBytes: 10,
      status: 'ok',
    });
    expect(pgResultDiagnosticSnapshot('org-app').results[1]).not.toHaveProperty('correlation');
  });

  it('preserves explicit unobserved/unknown linkage states without crossing pools', () => {
    setPgDiagnosticContextResolver(() => null);
    const unobserved = capturePgDiagnosticContext();
    recordPgResult('org-app', {
      connectionId: 1,
      queryId: 1,
      backendPid: null,
      query: 'select 1',
      rowCount: 0,
      wireBytes: 0,
      status: 'ok',
      context: unobserved,
    });
    expect(pgResultDiagnosticSnapshot('org-app').results[0].correlationState).toBe('unobserved');

    setPgDiagnosticContextResolver(() => {
      throw new Error('observer unavailable');
    });
    const unknown = capturePgDiagnosticContext();
    recordPgResult('org-app', {
      connectionId: 2,
      queryId: 1,
      backendPid: null,
      query: 'select 1',
      rowCount: 0,
      wireBytes: 0,
      status: 'ok',
      context: unknown,
    });
    expect(pgResultDiagnosticSnapshot('org-app').results[1].correlationState).toBe('unknown');
    expect(
      pgResultDiagnosticSnapshot('org-admin').results,
    ).toEqual([]);
  });

  it('keeps separately captured attempts distinct', () => {
    const first = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: '10',
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: 1,
      stage: 'epoch-query',
      boundary: 'await' as const,
    };
    const retry = { ...first, attemptId: '33333333-3333-4333-8333-333333333333', hopId: 2 };
    setPgDiagnosticContextResolver(() => first);
    const firstCaptured = capturePgDiagnosticContext();
    setPgDiagnosticContextResolver(() => retry);
    const retryCaptured = capturePgDiagnosticContext();
    recordPgResult('org-app', {
      connectionId: 4,
      queryId: 9,
      backendPid: null,
      query: 'select 1',
      rowCount: 1,
      wireBytes: 1,
      status: 'ok',
      context: firstCaptured,
    });
    expect(pgResultDiagnosticSnapshot('org-app').results[0].correlation).toEqual(first);
    expect(retryCaptured.correlation).toEqual(retry);
  });

  it('keeps equal numeric query IDs isolated by process and physical pool identity', () => {
    const input = { connectionId: 1, queryId: 1, backendPid: null, query: 'select 1', rowCount: 1, wireBytes: 10, status: 'ok' as const };
    const a = createPgDiagnosticHooks('org-app');
    const b = createPgDiagnosticHooks('org-app');
    a.onresult(input);
    b.onresult(input);
    const [one, two] = pgResultDiagnosticSnapshot('org-app').results;
    expect(one.source.poolInstanceId).not.toBe(two.source.poolInstanceId);
    expect(one.source.processInstanceId).toBe(two.source.processInstanceId);
    recordPgResult('org-app', input, { ...one.source, processInstanceId: '11111111-1111-4111-8111-111111111111' });
    expect(pgResultDiagnosticSnapshot('org-app').results[2].source).not.toEqual(one.source);
    createPgDiagnosticHooks('org-admin').onresult(input);
    expect(pgResultDiagnosticSnapshot('org-admin').results).toHaveLength(1);
    expect(pgResultDiagnosticSnapshot('org-app').results).toHaveLength(3);
  });

  it('copies and bounds correlation fields rather than retaining secret-shaped values or extra properties', () => {
    const raw = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      buildSha: 'secret-build', rowId: 'secret-row', hopId: 2,
      stage: 'secret-token', boundary: 'await' as const, parameters: ['secret-value'],
    };
    setPgDiagnosticContextResolver(() => raw);
    const context = capturePgDiagnosticContext();
    expect(context.correlation).toMatchObject({ buildSha: null, rowId: null, stage: null });
    expect(JSON.stringify(context)).not.toContain('secret');
    expect(Object.isFrozen(context.correlation)).toBe(true);
    raw.hopId = 4;
    expect(context.correlation?.hopId).toBe(2);
  });
});

describe('describeAcquirePressure — the verdict is bounded by the measurement', () => {
  it('returns null when nothing was measured, so the caller falls back instead of printing zeroes', () => {
    expect(describeAcquirePressure('never-built')).toBeNull();
  });

  it('NEVER-acquired reads as consistent-with-dead-endpoint, not as proof of one', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/NEVER obtained a connection in this process/i);
    // The pooler-queue alternative must survive: this is the branch where an
    // over-confident "the endpoint is dead" would send the reader to a dead end.
    expect(msg).toMatch(/pooler queue/i);
    expect(msg).not.toMatch(/RULED OUT/);
    t.release();
  });

  it('a RECENT success RULES OUT the dead-endpoint cause', () => {
    recordPoolMax('org-app', 20);
    const held = beginAcquire('org-app');
    held.acquired();
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/RULED OUT/);
    expect(msg).toMatch(/queued, not disconnected/i);
    held.release();
    waiter.release();
  });

  it('held >= max CONFIRMS client saturation and says the server is irrelevant', () => {
    recordPoolMax('org-app', 2);
    const a = beginAcquire('org-app');
    const b = beginAcquire('org-app');
    a.acquired();
    b.acquired();
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/CONFIRMED/);
    expect(msg).toMatch(/PAPERCUSP_DB_POOL_MAX/);
    // WI-8848's lesson, kept measurable: a healthy server is the EXPECTED reading here.
    expect(msg).toMatch(/server's spare capacity is irrelevant/i);
    a.release();
    b.release();
    waiter.release();
  });

  it('held < max must NOT be reported as free slots — the count is a LOWER BOUND', () => {
    recordPoolMax('org-app', 20);
    const a = beginAcquire('org-app');
    a.acquired();
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/LOWER BOUND/);
    expect(msg).toMatch(/does NOT\s+mean free slots/i);
    expect(msg).not.toMatch(/CONFIRMED/);
    a.release();
  });

  it('always states that a sibling process has its own pool (the measured mechanism)', () => {
    // EI-19448641861408544: ~15 vitest workers each open their own
    // pcusp:org-app:p<pid> pool. A per-process registry that read as fleet-wide
    // would recreate exactly the over-claim this module exists to prevent.
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/THIS process/);
    expect(msg).toMatch(/vitest worker/i);
    t.release();
  });

  it('a STALE success stops ruling the endpoint out', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const first = beginAcquire('org-app');
    first.acquired();
    first.release();
    vi.advanceTimersByTime(ACQUIRE_RECENT_SUCCESS_MS + 1_000);
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).not.toMatch(/RULED OUT/);
    expect(msg).toMatch(/DID work earlier/i);
    expect(msg).toMatch(/memoized for the process lifetime/i);
    waiter.release();
  });

  it('reports the oldest waiter, not the newest', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const old = beginAcquire('org-app');
    vi.advanceTimersByTime(30_000);
    const fresh = beginAcquire('org-app');
    expect(acquireSnapshot('org-app').oldestWaitMs).toBe(30_000);
    expect(describeAcquirePressure('org-app')!.text).toContain('oldest 30.0s');
    old.release();
    fresh.release();
  });
});

/**
 * The verdict decides how much PROCEDURE the error still needs to print.
 *
 * This is the actual deliverable: the old message handed the reader a 3-step
 * manual probe. Measuring is only half the fix — if the answer is then buried
 * under the same procedure it replaces, the reader is no better off. So a
 * DECISIVE verdict must swap the cause-fork for the short residual, and a
 * non-decisive one must keep the full fork intact.
 */
describe('verdict → how much procedure survives', () => {
  it('marks a ruled-out-endpoint verdict decisive', () => {
    recordPoolMax('org-app', 20);
    const held = beginAcquire('org-app');
    held.acquired();
    const r = describeAcquirePressure('org-app')!;
    expect(r.verdict).toBe('queued');
    expect(r.decisive).toBe(true);
    held.release();
  });

  it('marks saturation decisive and distinguishes it from a plain queue', () => {
    recordPoolMax('org-app', 1);
    const a = beginAcquire('org-app');
    a.acquired();
    const r = describeAcquirePressure('org-app')!;
    expect(r.verdict).toBe('client-saturation');
    expect(r.decisive).toBe(true);
    a.release();
  });

  it('leaves never-acquired and stale-success NON-decisive — the fork is still open', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const never = describeAcquirePressure('org-app')!;
    expect(never.verdict).toBe('never-acquired');
    expect(never.decisive).toBe(false);

    t.acquired();
    t.release();
    vi.advanceTimersByTime(ACQUIRE_RECENT_SUCCESS_MS + 1);
    const stale = describeAcquirePressure('org-app')!;
    expect(stale.verdict).toBe('stale-success');
    expect(stale.decisive).toBe(false);
  });
});

/**
 * The seam integration: `withAcquisitionDeadline` is the ONE place an
 * acquisition is registered, so a breach must carry the numbers and every exit
 * path must release. A leaked waiter would inflate every later snapshot, making
 * this diagnostic worse than none.
 */
describe('withAcquisitionDeadline — registry wiring', () => {
  it('a breach reports the waiter that breached, counting ITSELF', async () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'withWorkspace:acquire(app)',
      pool: 'org-app',
      ms: 45_000,
    });
    const caught = p.then(
      () => {
        throw new Error('expected a deadline rejection');
      },
      (e: unknown) => e as DbCallDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(45_001);
    const err = await caught;
    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect(err.pool).toBe('org-app');
    expect(err.measured).toMatch(/1 acquisition\(s\) WAITING/);
    expect(err.message).toMatch(/MEASURED IN THIS PROCESS/);
    // The numbers must LEAD — the whole complaint was that the prose came first.
    expect(err.message.indexOf('MEASURED IN THIS PROCESS')).toBeLessThan(
      err.message.indexOf('Two causes present identically'),
    );
  });

  it('releases the ticket on the breach path', async () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'withWorkspace:acquire(app)',
      pool: 'org-app',
      ms: 1_000,
    });
    const caught = p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_001);
    await caught;
    expect(acquireSnapshot('org-app').waiting).toBe(0);
    expect(acquireSnapshot('org-app').held).toBe(0);
  });

  it('disarm() moves the ticket to held, and the finally releases it on success', async () => {
    recordPoolMax('org-app', 20);
    let heldDuringWork = -1;
    const out = await withAcquisitionDeadline<string>(
      async ({ disarm }) => {
        disarm();
        heldDuringWork = acquireSnapshot('org-app').held;
        return 'ok';
      },
      { label: 'withWorkspace:acquire(app)', pool: 'org-app' },
    );
    expect(out).toBe('ok');
    expect(heldDuringWork).toBe(1);
    expect(acquireSnapshot('org-app').held).toBe(0);
    expect(acquireSnapshot('org-app').totalAcquired).toBe(1);
  });

  it('releases the ticket when the caller’s own work THROWS', async () => {
    recordPoolMax('org-app', 20);
    await expect(
      withAcquisitionDeadline<string>(
        async ({ disarm }) => {
          disarm();
          throw new Error('caller blew up');
        },
        { label: 'withWorkspace:acquire(app)', pool: 'org-app' },
      ),
    ).rejects.toThrow('caller blew up');
    expect(acquireSnapshot('org-app').held).toBe(0);
    expect(acquireSnapshot('org-app').waiting).toBe(0);
  });

  it('cleans up when the acquisition runner THROWS synchronously', async () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const error = new Error('runner blew up synchronously');
    await expect(
      withAcquisitionDeadline<string>(
        () => {
          throw error;
        },
        { label: 'withWorkspace:acquire(app)', pool: 'org-app', ms: 1_000 },
      ),
    ).rejects.toBe(error);
    expect(acquireSnapshot('org-app').waiting).toBe(0);
    expect(acquireSnapshot('org-app').held).toBe(0);
    await vi.advanceTimersByTimeAsync(1_001);
  });

  it('omitting `pool` keeps the guard working and registers nothing', async () => {
    // (see the vitest pool-budget block below — same defect, opposite end: this
    // file measures the SYMPTOM, that one bounds the CAUSE.)
    vi.useFakeTimers();
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'unlabelled',
      ms: 1_000,
    });
    const caught = p.then(
      () => {
        throw new Error('expected a deadline rejection');
      },
      (e: unknown) => e as DbCallDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = await caught;
    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect(err.pool).toBeNull();
    expect(err.measured).toBeNull();
    expect(err.message).toMatch(/No acquire measurements were available/);
  });
});

/**
 * EI-19448641861408544 — the CAUSE, not the symptom. Lives beside the registry
 * because they are one defect: the registry MEASURES client-pool saturation, and
 * this bounds the biggest producer of it on this box.
 *
 * Under vitest every worker is its own process with its own admin + app org
 * pools, while `resolveOrgPoolMax`'s budget math assumes ~2 operator processes.
 * Measured 2026-08-08: a worker resolved max=52 PER POOL, so ~15 workers of one
 * `npm run test:affected` could demand ~1,560 connections against a 512-slot
 * server. Measured 2026-08-03: they held 90 idle checked-out connections and
 * starved the LIVE operator's write path fleet-wide while every read-side probe
 * reported a healthy database.
 *
 * These run INSIDE vitest, so they observe the real resolved value rather than a
 * re-implementation of it.
 */
describe('org pool budget under vitest (EI-19448641861408544)', () => {
  const prev = process.env.PAPERCUSP_DB_POOL_MAX;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_DB_POOL_MAX;
    else process.env.PAPERCUSP_DB_POOL_MAX = prev;
  });

  it('clamps a test worker to a small pool instead of the operator-sized one', () => {
    delete process.env.PAPERCUSP_DB_POOL_MAX;
    expect(processConnectionCeiling().poolMax).toBe(VITEST_ORG_POOL_MAX);
  });

  it('is small enough that a full worker fan-out cannot exhaust the server', () => {
    delete process.env.PAPERCUSP_DB_POOL_MAX;
    const perWorker = processConnectionCeiling().orgPools; // admin + app
    // The measured fan-out (15 workers) against the measured server ceiling (512).
    expect(perWorker * 15).toBeLessThan(512);
    // …and the pre-fix value provably could not make that claim.
    expect(52 * 2 * 15).toBeGreaterThan(512);
  });

  it('an explicit PAPERCUSP_DB_POOL_MAX is an upper bound, subject to the host safety cap', () => {
    process.env.PAPERCUSP_DB_POOL_MAX = '11';
    const poolMax = processConnectionCeiling().poolMax;
    // The explicit value skips the Vitest worker default, but it must still
    // pass through boundedOrgPoolMax: opting into more test concurrency cannot
    // overrun the host's max_connections budget. Do not hard-code the capped
    // value; the resource profile is intentionally host-dependent.
    expect(poolMax).toBeGreaterThanOrEqual(1);
    expect(poolMax).toBeLessThanOrEqual(11);
  });

  it('leaves room for a nested acquisition rather than deadlocking at 1', () => {
    // max:1 would turn a flow that nests one acquisition inside another from a
    // QUEUE into a DEADLOCK — a worse failure than the starvation being fixed.
    expect(VITEST_ORG_POOL_MAX).toBeGreaterThan(1);
  });
});
