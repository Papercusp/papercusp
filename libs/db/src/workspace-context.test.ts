/**
 * workspace-context — unit tests for the EI-9279 connect-retry wiring, with a
 * fully mocked `sql` (no DB needed). Mirrors postgres-js's real `sql.begin()`
 * contract: a failure BEFORE the passed callback is invoked (a `BEGIN` round-trip
 * failure) never calls the callback at all; a failure the callback itself throws
 * is a mid-transaction failure. See workspace-context.integration.test.ts for the
 * real-Postgres proof of the GUC/RLS behavior this file does not re-test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  begin: vi.fn(),
  pgbouncerEnabled: vi.fn(() => false),
}));

vi.mock('./connection', () => ({
  getOrgPg: () => ({ sql: { begin: h.begin, options: {} } }),
  getOrgPgApp: () => ({ sql: { begin: h.begin, options: {} } }),
  getHarnessPg: () => ({ sql: { begin: h.begin, options: {} } }),
  pgbouncerEnabled: h.pgbouncerEnabled,
}));

import { withWorkspace } from './workspace-context';

const CONNECTION_CLOSED = { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };

// A fake tx: callable as a tagged-template ( txSql`...` compiles to txSql(strings, ...vals) ).
function fakeTxSql(): Sql {
  return (async () => []) as unknown as Sql;
}

describe('withWorkspace — EI-9279 connect-retry wiring', () => {
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
