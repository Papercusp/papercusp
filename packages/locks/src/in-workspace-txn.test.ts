import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const mocks = vi.hoisted(() => ({
  ensureBootstrap: vi.fn(),
  getTxPool: vi.fn(),
  startBackgroundJanitor: vi.fn(),
  txnTimeouts: vi.fn(),
  beginAcquireDiagnostic: vi.fn(),
}));

vi.mock('./su-lock-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./su-lock-store')>();
  return {
    ...actual,
    ensureBootstrap: mocks.ensureBootstrap,
    getTxPool: mocks.getTxPool,
    SU_LOCKS_FEATURE_KEY: 1,
  };
});

vi.mock('./workspace-listener', () => ({
  startBackgroundJanitor: mocks.startBackgroundJanitor,
}));

vi.mock('./config', async (importOriginal) => ({
  ...await importOriginal<typeof import('./config')>(),
  txnTimeouts: mocks.txnTimeouts,
  beginAcquireDiagnostic: mocks.beginAcquireDiagnostic,
}));

import { inWorkspaceTxn, preserveOutsideWorkspaceTxn, protectPreservationAlias } from './in-workspace-txn';
import type { WorkspaceTxnPhaseTiming } from './in-workspace-txn';

function fakePool() {
  let active = false;
  const commands: string[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) =>
    strings.join(' ').includes("current_setting('application_name') AS application_name")
      ? [{ application_name: 'original-pool-label' }]
      : []);
  const release = vi.fn();
  const unsafe = vi.fn(async (command: string) => {
    commands.push(command);
    active = command === 'BEGIN';
    return [];
  });
  Object.assign(tx, { unsafe, release });
  const sql = { reserve: vi.fn(async () => tx) };
  return { sql, tx, commands, release, active: () => active };
}

describe('inWorkspaceTxn diagnostic phase timing', () => {
  beforeEach(() => {
    vi.stubEnv('VITEST', 'true');
    mocks.ensureBootstrap.mockReset().mockResolvedValue(undefined);
    mocks.getTxPool.mockReset();
    mocks.startBackgroundJanitor.mockReset();
    mocks.beginAcquireDiagnostic.mockReset().mockReturnValue(null);
    mocks.txnTimeouts.mockReset().mockReturnValue({
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('settles SQL before a paused capture and revalidates before committing', async () => {
    const { sql, tx, commands, release, active } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    const capture = vi.fn(async () => {
      expect(active()).toBe(false);
      await work;
      expect(active()).toBe(false);
      return { custody: 'original' };
    });
    const result = inWorkspaceTxn('custody', 'owner', async transaction => {
      const receipt = await preserveOutsideWorkspaceTxn(transaction, 'custody', ['a.ts'],
        { lease: 'original' }, capture);
      expect(active()).toBe(true);
      return receipt;
    }, { paths: ['a.ts'] });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(commands).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).not.toHaveBeenCalled();
    expect(tx.mock.calls.some(([s]) => s.join(' ').includes('pg_advisory_lock('))).toBe(true);
    finish();
    await expect(result).resolves.toEqual({ custody: 'original' });
    expect(capture).toHaveBeenCalledOnce();
    expect(commands).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    expect(tx.mock.calls.at(-1)?.[0].join(' ')).toContain('pg_advisory_unlock_all');
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps release rolled back when capture fails and drops the session fence', async () => {
    const { sql, commands, release, active } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    const failure = new Error('capture failed');
    await expect(inWorkspaceTxn('custody', 'owner', transaction =>
      preserveOutsideWorkspaceTxn(transaction, 'custody', ['a.ts'], ['lease'], async () => {
        expect(active()).toBe(false);
        throw failure;
      }), { paths: ['a.ts'] })).rejects.toBe(failure);
    expect(commands).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['changed', 'missing'])('refuses a %s selection instead of recapturing a successor', async mode => {
    const { sql, commands, release } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    let captured = false;
    const capture = vi.fn(async () => { captured = true; return 'receipt'; });
    await expect(inWorkspaceTxn('custody', 'owner', async transaction => {
      if (captured && mode === 'missing') return 'must not commit';
      return preserveOutsideWorkspaceTxn(transaction, 'custody', ['a.ts'],
        [captured ? 'successor' : 'original'], capture);
    }, { paths: ['a.ts'] })).rejects.toThrow('preservation selection changed');
    expect(capture).toHaveBeenCalledOnce();
    expect(commands).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains physical alias protection without an idle SQL transaction', async () => {
    const { sql, commands, active } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    const capture = vi.fn(async (transaction: Sql) => {
      await protectPreservationAlias(transaction, 'physical', ['a.ts'], async () => {
        expect(active()).toBe(false);
      });
      expect(active()).toBe(false);
      return 'alias receipt';
    });
    await expect(inWorkspaceTxn('alias', 'owner', transaction =>
      preserveOutsideWorkspaceTxn(transaction, 'alias', ['a.ts'], ['original'],
        () => capture(transaction)), { paths: ['a.ts'] })).resolves.toBe('alias receipt');
    expect(capture).toHaveBeenCalledOnce();
    expect(commands).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });

  it('reports each named transaction phase and preserves the callback result', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    const observed: WorkspaceTxnPhaseTiming[] = [];

    const result = await inWorkspaceTxn(
      'diagnostic-test',
      'owner',
      async () => 'result',
      { onPhase: (timing) => observed.push(timing) },
    );

    expect(result).toBe('result');
    expect(observed.map((timing) => timing.phase)).toEqual([
      'bootstrap',
      'pool-lookup',
      'pool-acquire-and-begin',
      'transaction-settings',
      'advisory-scope',
      'operation',
      'transaction-settlement',
      'transaction-total',
    ]);
    expect(observed.every((timing) => Number.isFinite(timing.durationMs) && timing.durationMs >= 0)).toBe(true);
  });

  it('does not wait for a domain advisory gate for a targeted lease renewal', async () => {
    const { sql, tx } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);

    await inWorkspaceTxn('renewal-domain', 'owner', async () => 'renewed', {
      leaseRenewal: true,
    });

    const advisory = tx.mock.calls.map(([strings]) => strings.join(' '))
      .filter((query) => query.includes('pg_advisory'));
    expect(advisory).toEqual([]);
  });

  // EI-27114494366587753: resource work must not take the EXCLUSIVE workspace key,
  // which serialized every file-lock operation behind every git-sync lock op.
  it('scopes a resource transaction to the shared gate plus sorted per-resource keys', async () => {
    const { sql, tx } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);

    await inWorkspaceTxn('resource-domain', 'owner', async () => 'ok', {
      resources: ['git-sync:zeta', 'git-sync:alpha', 'git-sync:zeta'],
    });

    const advisory = tx.mock.calls
      .map(([strings, ...values]) => ({ query: strings.join(' '), values }))
      .filter(({ query }) => query.includes('pg_advisory'));
    expect(advisory).toHaveLength(3);
    expect(advisory[0].query).toContain('pg_advisory_xact_lock_shared');
    expect(advisory[0].values).toContain('su:resource-domain');
    // Exclusive per-resource keys, de-duplicated and sorted — the same strings
    // resource_scope_lock (sidecar sql/030) hashes, so TS and SQL callers meet.
    expect(advisory.slice(1).map(({ query }) => query.includes('pg_advisory_xact_lock_shared'))).toEqual([false, false]);
    expect(advisory.slice(1).map(({ values }) => values[1])).toEqual([
      'su-resource:resource-domain:git-sync:alpha',
      'su-resource:resource-domain:git-sync:zeta',
    ]);
    // Never the exclusive domain key.
    expect(
      advisory.some(({ query, values }) => !query.includes('_shared') && values.includes('su:resource-domain')),
    ).toBe(false);
  });

  it('refuses a resource scope combined with paths', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    await expect(
      inWorkspaceTxn('resource-domain', 'owner', async () => 'ok', {
        resources: ['git-sync:alpha'],
        paths: ['src/a.ts'],
      }),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('keeps the transaction result when the diagnostic observer throws', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);

    await expect(
      inWorkspaceTxn('diagnostic-test', 'owner', async () => 'still-commits', {
        onPhase: () => { throw new Error('diagnostic observer failed'); },
      }),
    ).resolves.toBe('still-commits');
  });

  it('registers and settles the dedicated SU transaction acquisition', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    const ticket = { acquired: vi.fn(), release: vi.fn() };
    mocks.beginAcquireDiagnostic.mockReturnValue(ticket);

    await expect(
      inWorkspaceTxn('diagnostic-test', 'owner', async () => 'instrumented'),
    ).resolves.toBe('instrumented');

    expect(mocks.beginAcquireDiagnostic).toHaveBeenCalledWith('su-lock-tx');
    expect(ticket.acquired).toHaveBeenCalledTimes(1);
    expect(ticket.release).toHaveBeenCalledTimes(1);
  });

  it('reports settlement and total timing when the callback rejects', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);
    const observed: WorkspaceTxnPhaseTiming[] = [];
    const failure = new Error('callback failed');

    await expect(
      inWorkspaceTxn('diagnostic-test', 'owner', async () => { throw failure; }, {
        onPhase: (timing) => observed.push(timing),
      }),
    ).rejects.toBe(failure);

    expect(observed.map((timing) => timing.phase)).toEqual([
      'bootstrap',
      'pool-lookup',
      'pool-acquire-and-begin',
      'transaction-settings',
      'advisory-scope',
      'operation',
      'transaction-settlement',
      'transaction-total',
    ]);
  });
});
