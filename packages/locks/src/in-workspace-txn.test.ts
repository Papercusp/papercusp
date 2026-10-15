import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const mocks = vi.hoisted(() => ({
  ensureBootstrap: vi.fn(),
  getTxPool: vi.fn(),
  startBackgroundJanitor: vi.fn(),
  txnTimeouts: vi.fn(),
}));

vi.mock('./su-lock-store', () => ({
  ensureBootstrap: mocks.ensureBootstrap,
  getTxPool: mocks.getTxPool,
  SU_LOCKS_FEATURE_KEY: 1,
}));

vi.mock('./workspace-listener', () => ({
  startBackgroundJanitor: mocks.startBackgroundJanitor,
}));

vi.mock('./config', () => ({
  txnTimeouts: mocks.txnTimeouts,
}));

import { inWorkspaceTxn } from './in-workspace-txn';
import type { WorkspaceTxnPhaseTiming } from './in-workspace-txn';

function fakePool() {
  const tx = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []);
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
    mocks.txnTimeouts.mockReset().mockReturnValue({
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('keeps the transaction result when the diagnostic observer throws', async () => {
    const { sql } = fakePool();
    mocks.getTxPool.mockReturnValue(sql);

    await expect(
      inWorkspaceTxn('diagnostic-test', 'owner', async () => 'still-commits', {
        onPhase: () => { throw new Error('diagnostic observer failed'); },
      }),
    ).resolves.toBe('still-commits');
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
