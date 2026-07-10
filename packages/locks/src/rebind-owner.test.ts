/**
 * rebind-owner — unit tests (fleet-reliability-verification-2026-07-10
 * P-002). Pure per-call logic over an injected fake `sql`; mirrors the
 * fakeSql style of operator-core's rebind-identity.test.ts so the two
 * modules' tests read the same way despite living in different packages.
 */
import { describe, expect, it, vi } from 'vitest';

interface FakeCall {
  text: string;
  vals: unknown[];
}

interface FakeOpts {
  fileLocksMoved?: number;
  waitersMoved?: number;
}

function fakeSql(opts: FakeOpts = {}) {
  const calls: FakeCall[] = [];
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.raw.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, vals });
    if (text.includes('UPDATE agent_file_locks')) {
      return Promise.resolve(
        Array.from({ length: opts.fileLocksMoved ?? 0 }, () => ({ path: 'p' })),
      );
    }
    if (text.includes('UPDATE agent_lock_waiters')) {
      return Promise.resolve(
        Array.from({ length: opts.waitersMoved ?? 0 }, () => ({ ticket_id: 't' })),
      );
    }
    return Promise.resolve([]);
  };
  return Object.assign(fn, { calls });
}

const ensureBootstrap = vi.fn().mockResolvedValue(undefined);
let currentSql: ReturnType<typeof fakeSql> = fakeSql();
vi.mock('./su-lock-store', () => ({
  ensureBootstrap: (...args: unknown[]) => ensureBootstrap(...args),
  getTxPool: () => currentSql,
}));

const { rebindLockOwner } = await import('./rebind-owner');

const FROM = 'su-old-aaaa';
const TO = 'su-new-bbbb';

describe('rebindLockOwner', () => {
  it('refuses identical / blank identities without touching the DB', async () => {
    currentSql = fakeSql();
    for (const [f, t] of [
      [FROM, FROM],
      ['', TO],
      [FROM, '  '],
    ] as const) {
      const res = await rebindLockOwner(f, t);
      expect(res).toMatchObject({ ok: false, fileLocksMoved: 0, waitersMoved: 0 });
    }
    expect(currentSql.calls).toHaveLength(0);
    expect(ensureBootstrap).not.toHaveBeenCalled();
  });

  it('re-keys agent_file_locks.owner and agent_lock_waiters.owner in one pass', async () => {
    currentSql = fakeSql({ fileLocksMoved: 3, waitersMoved: 2 });
    const res = await rebindLockOwner(FROM, TO);
    expect(res).toMatchObject({ ok: true, from: FROM, to: TO, fileLocksMoved: 3, waitersMoved: 2 });
    expect(ensureBootstrap).toHaveBeenCalled();

    const lockUpdate = currentSql.calls.find((c) => c.text.includes('UPDATE agent_file_locks'));
    expect(lockUpdate!.vals).toEqual([TO, FROM]);
    const waiterUpdate = currentSql.calls.find((c) => c.text.includes('UPDATE agent_lock_waiters'));
    expect(waiterUpdate!.vals).toEqual([TO, FROM]);
  });

  it('reports zero moved when the dead id held nothing', async () => {
    currentSql = fakeSql();
    const res = await rebindLockOwner(FROM, TO);
    expect(res).toMatchObject({ ok: true, fileLocksMoved: 0, waitersMoved: 0 });
  });

  it('trims whitespace-padded ids before comparing/using them', async () => {
    currentSql = fakeSql({ fileLocksMoved: 1 });
    const res = await rebindLockOwner(`  ${FROM}  `, `  ${TO}  `);
    expect(res).toMatchObject({ ok: true, from: FROM, to: TO, fileLocksMoved: 1 });
  });
});
