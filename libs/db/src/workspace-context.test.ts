/**
 * workspace-context — unit tests for the EI-9279 connect-retry wiring, with a
 * fully mocked `sql` (no DB needed). Mirrors postgres-js's real `sql.begin()`
 * contract: a failure BEFORE the passed callback is invoked (a `BEGIN` round-trip
 * failure) never calls the callback at all; a failure the callback itself throws
 * is a mid-transaction failure. See workspace-context.integration.test.ts for the
 * real-Postgres proof of the GUC/RLS behavior this file does not re-test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  begin: vi.fn(),
  pgbouncerEnabled: vi.fn(() => false),
}));

// Override ONLY the pool accessors; keep every other real export via
// importOriginal. That is deliberate, not incidental: the acquisition-deadline
// guard (P-022 / D-020) lives in this module, and stubbing it out would leave
// the tests below green while never exercising it — a false pass of exactly the
// kind this file exists to prevent. The pools stay mocked so no real PG is touched.
vi.mock('./connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connection')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: { begin: h.begin, options: {} } }),
    getOrgPgApp: () => ({ sql: { begin: h.begin, options: {} } }),
    getHarnessPg: () => ({ sql: { begin: h.begin, options: {} } }),
    pgbouncerEnabled: h.pgbouncerEnabled,
  };
});

import { withHarnessSchema, withWorkspace } from './workspace-context';
import { DEFAULT_TX_ACQUIRE_DEADLINE_MS } from './connection';
import { beginAcquire, recordPoolMax, resetAcquireRegistryForTest } from './acquire-registry';

const CONNECTION_CLOSED = { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };

// A fake tx: callable as a tagged-template ( txSql`...` compiles to txSql(strings, ...vals) ).
function fakeTxSql(): Sql {
  return (async () => []) as unknown as Sql;
}

describe('withWorkspace — EI-9279 connect-retry wiring', () => {
  it('reports BEGIN and workspace setup separately before caller work', async () => {
    const phases: string[] = [];
    const tx = vi.fn(async () => []);
    h.begin.mockImplementation(async (cb: (sql: Sql) => Promise<unknown>) => {
      phases.push('begin-called');
      return cb(tx as unknown as Sql);
    });

    await withWorkspace('ws-1', async () => {
      phases.push('caller');
      return 'ok';
    }, { onAcquisitionPhase: (phase) => phases.push(phase) });

    expect(phases).toEqual(['begin-called', 'begin', 'ready', 'caller']);
    expect(tx).toHaveBeenCalledTimes(1); // workspace GUC remains inside the transaction
  });

  it('applies read-only mode and per-call query bounds before workspace setup', async () => {
    // Typed parameters so `tx.mock.calls` is `unknown[][]`, not the empty tuple `[]`.
    const tx = vi.fn(async (..._args: unknown[]) => []);
    h.begin.mockImplementation(async (cb: (sql: Sql) => Promise<unknown>) => cb(tx as unknown as Sql));

    await withWorkspace('ws-bounded', async () => 'ok', {
      readOnly: true,
      lockTimeoutMs: 1_000,
      statementTimeoutMs: 2_000,
    });

    const statements = tx.mock.calls.map(([template]) => Array.isArray(template) ? template.join(' ') : '');
    expect(statements[0]).toBe('SET TRANSACTION READ ONLY');
    expect(statements[1]).toContain("set_config('lock_timeout'");
    expect(statements[1]).toContain("set_config('statement_timeout'");
    expect(tx.mock.calls[1]?.slice(1)).toEqual(['1000ms', '2000ms']);
    expect(statements[2]).toContain("set_config('app.workspace_id'");
  });

  it('sets pooled search path and workspace scope in one transaction query', async () => {
    h.pgbouncerEnabled.mockReturnValue(true);
    try {
      const tx = vi.fn(async (_query: TemplateStringsArray, _workspace?: string) => []);
      h.begin.mockImplementation(async (cb: (sql: Sql) => Promise<unknown>) => cb(tx as unknown as Sql));
      await withWorkspace('ws-pooled', async () => 'ok');

      expect(tx).toHaveBeenCalledTimes(1);
      const [query, scope] = tx.mock.calls[0]!;
      expect(query.join('?')).toContain("set_config('search_path'");
      expect(query.join('?')).toContain("set_config('app.workspace_id'");
      expect(scope).toBe('ws-pooled');
    } finally {
      h.pgbouncerEnabled.mockReturnValue(false);
    }
  });

  it.each([
    { pooled: false, admin: false, bounds: {}, count: 1, values: [['ws-scalars']] },
    { pooled: false, admin: true, bounds: {}, count: 0, values: [] },
    { pooled: true, admin: false, bounds: {}, count: 1, values: [['ws-scalars']] },
    { pooled: true, admin: true, bounds: {}, count: 1, values: [[]] },
    { pooled: false, admin: false, bounds: { lockTimeoutMs: 1000 }, count: 2, values: [['1000ms'], ['ws-scalars']] },
    { pooled: false, admin: false, bounds: { statementTimeoutMs: 2000 }, count: 2, values: [['2000ms'], ['ws-scalars']] },
    { pooled: true, admin: false, bounds: { lockTimeoutMs: 1000, statementTimeoutMs: 2000 }, count: 2, values: [['1000ms', '2000ms'], ['ws-scalars']] },
  ])('keeps exact setup count/parameters with server scalars: %j', async ({ pooled, admin, bounds, count, values }) => {
    h.pgbouncerEnabled.mockReturnValue(pooled);
    try {
      const tx = vi.fn(async (..._args: unknown[]) => []);
      h.begin.mockImplementation(async (cb: (sql: Sql) => Promise<unknown>) => cb(tx as unknown as Sql));
      await withWorkspace('ws-scalars', async () => 'ok', { ...bounds, bypassRlsForAdmin: admin });
      expect(tx).toHaveBeenCalledTimes(count);
      expect(tx.mock.calls.map(call => call.slice(1))).toEqual(values);
      for (const [template] of tx.mock.calls) {
        const statement = (template as TemplateStringsArray).join('?');
        expect(statement).toMatch(/^SELECT set_config\(/);
        expect(statement.match(/pg_backend_pid\(\)/g)).toHaveLength(1);
        expect(statement).toMatch(/statement_timestamp\(\)::text AS diagnostic_statement_at$/);
      }
    } finally {
      h.pgbouncerEnabled.mockReturnValue(false);
    }
  });

  it('keeps harness search-path setup in its existing single SELECT with server scalars', async () => {
    const tx = vi.fn(async (..._args: unknown[]) => []);
    h.begin.mockImplementation(async (cb: (sql: Sql) => Promise<unknown>) => cb(tx as unknown as Sql));
    await withHarnessSchema('scalar-harness', async () => 'ok');
    expect(tx).toHaveBeenCalledTimes(1);
    const [template, searchPath] = tx.mock.calls[0]!;
    expect((template as TemplateStringsArray).join('?')).toMatch(/^SELECT set_config\('search_path'.*true\),\s*pg_backend_pid\(\) AS diagnostic_pg_pid,/);
    expect(searchPath).toContain('harness_shared');
  });

  it('retries a BEGIN-phase CONNECTION_CLOSED (callback never invoked) and eventually succeeds', async () => {
    let beginAttempts = 0;
    h.begin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => {
      beginAttempts++;
      if (beginAttempts < 3) {
        // Mirrors postgres-js: BEGIN's own round trip failed — cb is NEVER called.
        throw CONNECTION_CLOSED;
      }
      return cb(fakeTxSql());
    });

    let callerFnInvocations = 0;
    const out = await withWorkspace('ws-1', async () => {
      callerFnInvocations++;
      return 'ok';
    });

    expect(out).toBe('ok');
    expect(beginAttempts).toBe(3);
    // The caller's own callback ran exactly once — the two failed BEGINs never touched it.
    expect(callerFnInvocations).toBe(1);
  });

  it('does NOT retry once the caller callback has started (mid-transaction failure propagates)', async () => {
    let beginAttempts = 0;
    h.begin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => {
      beginAttempts++;
      return cb(fakeTxSql());
    });

    let callerFnInvocations = 0;
    await expect(
      withWorkspace('ws-1', async () => {
        callerFnInvocations++;
        throw CONNECTION_CLOSED; // a blip AFTER the caller's own work began
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });

    expect(beginAttempts).toBe(1);
    expect(callerFnInvocations).toBe(1); // never re-invoked — no double-apply risk
  });

  it('propagates a non-connection error immediately, no retry', async () => {
    let beginAttempts = 0;
    h.begin.mockImplementation(async () => {
      beginAttempts++;
      throw new Error('some unrelated failure');
    });

    await expect(withWorkspace('ws-1', async () => 'unreached')).rejects.toThrow(
      'some unrelated failure',
    );
    expect(beginAttempts).toBe(1);
  });

  it('gives up after the default retry budget on a persistent BEGIN-phase failure', async () => {
    let beginAttempts = 0;
    h.begin.mockImplementation(async () => {
      beginAttempts++;
      throw CONNECTION_CLOSED;
    });

    await expect(withWorkspace('ws-1', async () => 'unreached')).rejects.toMatchObject({
      code: 'CONNECTION_CLOSED',
    });
    expect(beginAttempts).toBe(3); // initial + 2 retries (connect-retry.ts default)
  });
});

/**
 * P-022 / D-020 — the acquisition deadline.
 *
 * The failure being guarded: against a DEAD endpoint, postgres-js's `closed()`
 * special-cases a pool's FIRST connect attempt and calls `reconnect()` with
 * exponential backoff FOREVER without ever invoking `error()`/`queryError()`.
 * The caller's query is therefore never rejected and the call blocks inside
 * `sql.begin()` BEFORE its callback runs. On 2026-08-03 that wedged 100% of MCP
 * dispatch (`coord:whoami` included) until an operator restart, while
 * `/api/health` stayed at 2ms on the unaffected ADMIN pool.
 *
 * `begin: () => new Promise(() => {})` below is a faithful model of that: a
 * promise that neither resolves NOR rejects.
 */
describe('withWorkspace — P-022/D-020 acquisition deadline', () => {
  beforeEach(() => {
    // The retry wrapper keys off process-local successful acquisitions. Keep
    // each deadline case independent from the connection-setup cases above.
    resetAcquireRegistryForTest();
  });

  it('fails fast with DbCallDeadlineError when the pool never connects (instead of hanging forever)', async () => {
    vi.useFakeTimers();
    try {
      h.begin.mockImplementation(() => new Promise(() => {}));

      const p = withWorkspace('ws-1', async () => 'unreached');
      const assertion = expect(p).rejects.toMatchObject({ name: 'DbCallDeadlineError' });
      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS + 50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a shorter per-call acquisition deadline and does not retry a measured queue timeout', async () => {
    vi.useFakeTimers();
    resetAcquireRegistryForTest();
    recordPoolMax('org-app', 1);
    const held = beginAcquire('org-app');
    held.acquired();
    try {
      let beginAttempts = 0;
      h.begin.mockImplementation(() => {
        beginAttempts++;
        return new Promise(() => {});
      });

      const pending = withWorkspace('ws-bounded', async () => 'unreached', {
        acquireTimeoutMs: 250,
        acquireRetries: 0,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'DbCallDeadlineError',
        deadlineMs: 250,
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
      expect(beginAttempts).toBe(1);
    } finally {
      held.release();
      resetAcquireRegistryForTest();
      vi.useRealTimers();
    }
  });

  /**
   * THE REGRESSION TEST. A deadline around the whole `sql.begin(...)` would also
   * bound the caller's handler and kill legitimately long tools — which is why
   * the existing `withDbCallDeadline` could not simply be reused here. The guard
   * must disarm at `markStarted()`.
   */
  it('does NOT bound the caller handler — a handler far slower than the deadline still completes', async () => {
    vi.useFakeTimers();
    try {
      h.begin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => cb(fakeTxSql()));

      const p = withWorkspace('ws-1', async () => {
        await new Promise((r) => setTimeout(r, DEFAULT_TX_ACQUIRE_DEADLINE_MS * 3));
        return 'slow-but-ok';
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS * 3 + 100);
      await expect(p).resolves.toBe('slow-but-ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs the caller handler when the deadline already fired (rolls back instead)', async () => {
    vi.useFakeTimers();
    try {
      // Connect completes, but only AFTER the deadline has already elapsed.
      h.begin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => {
        await new Promise((r) => setTimeout(r, DEFAULT_TX_ACQUIRE_DEADLINE_MS * 2));
        return cb(fakeTxSql());
      });

      let handlerRuns = 0;
      const p = withWorkspace('ws-1', async () => {
        handlerRuns++;
        return 'must-not-run';
      });
      const assertion = expect(p).rejects.toMatchObject({ name: 'DbCallDeadlineError' });
      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS * 2 + 100);
      await assertion;

      // Promise.race does not cancel the loser, so the transaction DID proceed —
      // the expired() check is what stops the handler running unawaited.
      expect(handlerRuns).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a pre-handler deadline when the local registry proves pool pressure', async () => {
    vi.useFakeTimers();
    resetAcquireRegistryForTest();
    recordPoolMax('org-app', 1);
    const held = beginAcquire('org-app');
    held.acquired();
    try {
      let beginAttempts = 0;
      h.begin.mockImplementation(async (cb: (tx: Sql) => Promise<unknown>) => {
        beginAttempts++;
        if (beginAttempts === 1) return new Promise<never>(() => {});
        return cb(fakeTxSql());
      });

      let handlerRuns = 0;
      const p = withWorkspace('ws-1', async () => {
        handlerRuns++;
        return 'retry-ok';
      });
      const assertion = expect(p).resolves.toBe('retry-ok');
      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS + 500);
      await assertion;

      expect(beginAttempts).toBe(2);
      expect(handlerRuns).toBe(1);
    } finally {
      held.release();
      resetAcquireRegistryForTest();
      vi.useRealTimers();
    }
  });

  /**
   * CONTROL (falsifiability). A deliberately-wrong reference implementation kept
   * HERE, in the test file, per the repo rule against mutating the shared tree to
   * prove a guard has teeth. This models the pre-fix shape — `sql.begin` awaited
   * with no acquisition deadline — and asserts it never settles. If this control
   * ever settles, the model is wrong and the tests above prove nothing.
   */
  it('CONTROL: the unguarded shape never settles — proves these tests can tell the difference', async () => {
    vi.useFakeTimers();
    try {
      const unguarded = (begin: () => Promise<unknown>) => begin();
      let settled = false;
      void unguarded(() => new Promise(() => {})).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(DEFAULT_TX_ACQUIRE_DEADLINE_MS * 5);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
