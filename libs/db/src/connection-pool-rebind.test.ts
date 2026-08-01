/**
 * Recurrence guard for EI-19285027465993737 — a cached pool must never outlive
 * the URL that justified it.
 *
 * THE INCIDENT this pins (2026-08-01, fleet-wide): a desktop registered an
 * embedded PG in `~/.papercusp/embedded-pg.json` on port 19715 and died. The
 * shared operator had lazily pooled against it, and every DB-backed MCP tool on
 * the box failed with `ECONNREFUSED 127.0.0.1:19715` until a manual restart.
 *
 * The subtle part — and the reason three existing guards all missed it — is that
 * RESOLUTION was correct the entire time. `adminUrl()` began returning the
 * native URL as soon as the discovery pid died; only the live pool was still
 * bound to the dead endpoint. Every prior guard answers "what SHOULD we connect
 * to?"; none answered "what is the pool ACTUALLY bound to?".
 *
 * So the assertion that matters here is the discovery→ABSENT transition. The
 * pre-existing teardown inside `adminUrl()` already handled
 * discovery→DIFFERENT-discovery, which is why the bug survived: the covered case
 * and the fatal case look almost identical, and only one of them was tested.
 *
 * No Postgres needed — same as connection-helpers.test.ts, importing ./connection
 * opens no connection (all pools are lazy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endStalePool } from './connection';

// The rebind deliberately warns (this incident was invisible for 14 minutes —
// hundreds of ECONNREFUSED lines to a port in no config file, and nothing
// alarmed). The repo runs vitest-fail-on-console, so it is captured here rather
// than removed, and the last test in this file asserts it actually fires.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** Minimal stand-in for a postgres-js `Sql` — only `.end()` is exercised. */
const fakePool = (end = vi.fn(async () => {})) => ({ end }) as never;

const DISCOVERY = 'postgresql://harness_admin:pw@localhost:19715/papercusp';
const NATIVE = 'postgresql://harness_admin:pw@127.0.0.1:5432/papercusp';

describe('endStalePool — the rebind decision', () => {
  it('REBINDS when the discovery target disappears (THE incident: discovery→native)', () => {
    const end = vi.fn(async () => {});
    expect(endStalePool(fakePool(end), DISCOVERY, NATIVE, 'org-admin')).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('does NOT rebind when the URL is unchanged — the steady state must stay free', () => {
    const end = vi.fn(async () => {});
    expect(endStalePool(fakePool(end), NATIVE, NATIVE, 'org-admin')).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });

  it('does nothing when there is no pool yet — first build is not a rebind', () => {
    expect(endStalePool(null, null, NATIVE, 'org-admin')).toBe(false);
  });

  it('rebinds on discovery→DIFFERENT-discovery too, so it fully subsumes the old teardown', () => {
    const other = 'postgresql://harness_admin:pw@localhost:29999/papercusp';
    expect(endStalePool(fakePool(), DISCOVERY, other, 'org-admin')).toBe(true);
  });

  it('rebinds on native→discovery — the reverse direction was never covered either', () => {
    expect(endStalePool(fakePool(), NATIVE, DISCOVERY, 'org-admin')).toBe(true);
  });

  it('rebinds when only the pgbouncer routing changes, same logical database', () => {
    const direct = 'postgresql://harness_admin:pw@127.0.0.1:5432/papercusp';
    const pooled = 'postgresql://harness_admin:pw@127.0.0.1:6432/papercusp';
    expect(endStalePool(fakePool(), direct, pooled, 'org-admin')).toBe(true);
  });
});

describe('the teardown must never be able to block the caller escaping a dead pool', () => {
  it('still rebinds when .end() THROWS synchronously', () => {
    const pool = {
      end: () => {
        throw new Error('socket already destroyed');
      },
    } as never;
    expect(() => endStalePool(pool, DISCOVERY, NATIVE, 'org-admin')).not.toThrow();
    expect(endStalePool(pool, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
  });

  it('still rebinds when .end() REJECTS — a pool pointed at a dead port cannot drain', () => {
    // This is the realistic shape of the incident: the endpoint is refusing
    // connections, so the drain cannot succeed. If an unhandled rejection or an
    // await could stall here, recovery would deadlock on the very failure it is
    // recovering from.
    const end = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(endStalePool({ end } as never, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('returns synchronously — it must not await the drain', () => {
    // A dead endpoint's drain only resolves on timeout; awaiting it would add
    // that timeout to every rebind on the recovery path.
    const end = vi.fn(() => new Promise<void>(() => {})); // never settles
    expect(endStalePool({ end } as never, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
  });
});

describe('observability — the silence was half the incident', () => {
  it('WARNS, naming the pool, when a live pool is rebound', () => {
    // 14 minutes of fleet-wide failure produced no signal that the DB endpoint
    // had moved. A rebind is rare and load-bearing; it must leave a trace.
    endStalePool(fakePool(), DISCOVERY, NATIVE, 'org-admin-lossless-bigint');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org-admin-lossless-bigint'));
  });

  it('stays SILENT on the steady-state path, so the warning keeps its meaning', () => {
    endStalePool(fakePool(), NATIVE, NATIVE, 'org-admin');
    expect(warn).not.toHaveBeenCalled();
  });
});
