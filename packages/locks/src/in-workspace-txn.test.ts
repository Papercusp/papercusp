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

import { inWorkspaceTxn } from './in-workspace-txn';
import type { WorkspaceTxnPhaseTiming } from './in-workspace-txn';

function fakePool(idleTimeoutMs = 0) {
  const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) =>
    strings.join(' ').includes('idle_timeout_ms') ? [{ idle_timeout_ms: idleTimeoutMs }] : []);
  const sql = {
    begin: vi.fn(async (run: (transaction: Sql) => Promise<unknown>) =>
      run(tx as unknown as Sql),
    ),
  };
  return { sql, tx };
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

  it('keeps an active custody callback alive and stops probing after settlement', async () => {
    vi.useFakeTimers();
    const { sql, tx } = fakePool(90);
    mocks.getTxPool.mockReturnValue(sql);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const result = inWorkspaceTxn('custody', 'owner', async () => { await work; return 'preserved'; });
    await vi.advanceTimersByTimeAsync(120);
    const probes = () => tx.mock.calls.filter(([strings]) => strings.join(' ').includes('transaction liveness'));
    expect(probes().length).toBeGreaterThanOrEqual(3);
    finish();
    await expect(result).resolves.toBe('preserved');
    const count = probes().length;
    await vi.advanceTimersByTimeAsync(180);
    expect(probes()).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains an in-flight probe before the transaction can settle', async () => {
    vi.useFakeTimers();
    const { sql, tx } = fakePool(90);
    let finishProbe!: () => void;
    let finishWork!: () => void;
    const probe = new Promise<void>((resolve) => { finishProbe = resolve; });
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    tx.mockImplementation(async (strings) => {
      const query = strings.join(' ');
      if (query.includes('idle_timeout_ms')) return [{ idle_timeout_ms: 90 }];
      if (query.includes('transaction liveness')) await probe;
      return [];
    });
    mocks.getTxPool.mockReturnValue(sql);
    let settled = false;
    const result = inWorkspaceTxn('custody', 'owner', async () => { await work; return 'done'; })
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(30);
    finishWork();
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    expect(tx.mock.calls.filter(([s]) => s.join(' ').includes('transaction liveness'))).toHaveLength(1);
    finishProbe();
    await expect(result).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed on a probe error and stops after a failed capture', async () => {
    vi.useFakeTimers();
    const { sql, tx } = fakePool(90);
    const lostConnection = new Error('connection lost');
    tx.mockImplementation(async (strings) => {
      if (strings.join(' ').includes('idle_timeout_ms')) return [{ idle_timeout_ms: 90 }];
      if (strings.join(' ').includes('transaction liveness')) throw lostConnection;
      return [];
    });
    mocks.getTxPool.mockReturnValue(sql);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const result = inWorkspaceTxn('custody', 'owner', async () => { await work; return 'must not commit'; });
    const rejected = expect(result).rejects.toBe(lostConnection);
    await vi.advanceTimersByTimeAsync(120);
    finish();
    await rejected;
    expect(tx.mock.calls.filter(([s]) => s.join(' ').includes('transaction liveness'))).toHaveLength(1);
    const captureFailure = new Error('capture failed');
    await expect(inWorkspaceTxn('custody', 'owner', async () => { throw captureFailure; })).rejects.toBe(captureFailure);
    await vi.advanceTimersByTimeAsync(180);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not probe when the effective idle timeout is disabled', async () => {
    vi.useFakeTimers();
    const { sql, tx } = fakePool(0);
    mocks.getTxPool.mockReturnValue(sql);
    await inWorkspaceTxn('custody', 'owner', async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(tx.mock.calls.some(([s]) => s.join(' ').includes('transaction liveness'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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

  it('uses only the shared domain gate for a targeted lease renewal', async () => {
    const { sql, tx } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);

    await inWorkspaceTxn('renewal-domain', 'owner', async () => 'renewed', {
      leaseRenewal: true,
    });

    const advisory = tx.mock.calls.map(([strings]) => strings.join(' '))
      .filter((query) => query.includes('pg_advisory'));
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toContain('pg_advisory_xact_lock_shared');
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
