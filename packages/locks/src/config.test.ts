/**
 * config.test.ts — the @papercusp/locks host seam (configureLocks / locksHost).
 * The contract: locksHost() must THROW a clear, actionable error when the host
 * was never wired (a misconfigured embedding would otherwise fail deep inside the
 * locks substrate with an opaque null deref), and return the configured host once
 * wired (re-configure replaces it). Tests run in definition order so the
 * unconfigured case is asserted before any configure mutates the module singleton.
 *
 * Submodule unit test (locks) — tab-neutral, genuine coverage.
 * Run: cd libs/papercusp/packages/locks && npx vitest run src/config.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  beginAcquireDiagnostic,
  configureLocks,
  locksHost,
  recordPoolMaxDiagnostic,
  txnTimeouts,
  DEFAULT_TXN_TIMEOUTS,
  type LocksHost,
} from './config';

describe('@papercusp/locks host seam', () => {
  it('throws a clear error when locksHost() is read before configuration', () => {
    // Runs first: the module singleton is still null here.
    expect(() => locksHost()).toThrowError(/configureLocks\(\) must be called/);
  });

  it('returns the wired host after configureLocks()', () => {
    const host: LocksHost = { getAdminBaseUrl: () => 'postgres://main' };
    configureLocks(host);
    expect(locksHost()).toBe(host);
    expect(locksHost().getAdminBaseUrl()).toBe('postgres://main');
  });

  it('re-configuring replaces the previously wired host', () => {
    const host2: LocksHost = { getAdminBaseUrl: () => 'postgres://other' };
    configureLocks(host2);
    expect(locksHost()).toBe(host2);
    expect(locksHost().getAdminBaseUrl()).toBe('postgres://other');
  });
});

describe('@papercusp/locks txnTimeouts() — P-020 db:txn-timeouts seam', () => {
  it('the baked default is 5s/5s', () => {
    expect(DEFAULT_TXN_TIMEOUTS).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 5000 });
  });

  it('falls back to DEFAULT_TXN_TIMEOUTS when the host wires no getTxnTimeouts', () => {
    configureLocks({ getAdminBaseUrl: () => 'postgres://main' });
    expect(txnTimeouts()).toEqual(DEFAULT_TXN_TIMEOUTS);
  });

  it('returns the host getTxnTimeouts() value when wired', () => {
    configureLocks({
      getAdminBaseUrl: () => 'postgres://main',
      getTxnTimeouts: () => ({ lockTimeoutMs: 15000, statementTimeoutMs: 30000 }),
    });
    expect(txnTimeouts()).toEqual({ lockTimeoutMs: 15000, statementTimeoutMs: 30000 });
  });

  it('fail-safes to defaults when getTxnTimeouts throws', () => {
    configureLocks({
      getAdminBaseUrl: () => 'postgres://main',
      getTxnTimeouts: () => {
        throw new Error('boom');
      },
    });
    expect(txnTimeouts()).toEqual(DEFAULT_TXN_TIMEOUTS);
  });

  it('replaces a non-finite field with its default, keeping the valid field', () => {
    configureLocks({
      getAdminBaseUrl: () => 'postgres://main',
      getTxnTimeouts: () => ({ lockTimeoutMs: Number.NaN, statementTimeoutMs: 30000 }),
    });
    expect(txnTimeouts()).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 30000 });
  });

  it('bridges acquire diagnostics through the host seam and keeps callbacks fail-soft', () => {
    const ticket = {
      acquired: vi.fn(() => { throw new Error('observer failure'); }),
      release: vi.fn(),
    };
    const beginAcquire = vi.fn(() => ticket);
    const recordPoolMax = vi.fn(() => { throw new Error('observer failure'); });
    const host: LocksHost = {
      getAdminBaseUrl: () => 'postgres://main',
      acquireDiagnostics: { beginAcquire, recordPoolMax },
    };

    configureLocks(host);
    recordPoolMaxDiagnostic('su-lock-tx', 10);
    const guarded = beginAcquireDiagnostic('su-lock-tx');

    expect(recordPoolMax).toHaveBeenCalledWith('su-lock-tx', 10);
    expect(beginAcquire).toHaveBeenCalledWith('su-lock-tx');
    expect(() => guarded?.acquired()).not.toThrow();
    expect(() => guarded?.release()).not.toThrow();
    expect(ticket.release).toHaveBeenCalledTimes(1);
  });
});
