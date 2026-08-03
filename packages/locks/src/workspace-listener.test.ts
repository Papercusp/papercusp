/**
 * workspace-listener — unit tests for the LISTEN/UNLISTEN timeout self-heal
 * (EI-19404227117727730). postgres-js provides no query-level timeout: a
 * silently-dead LISTEN connection leaves `sql.listen()`/`unlisten()` awaiting
 * a response that never arrives, hanging the caller forever with zero
 * PG-visible activity — exactly the "db:migrate hangs indefinitely" shape.
 * These tests exercise the pure timeout-race + pool-reset logic against a
 * fake `sql` (mirrors the fakeSql style of rebind-owner.test.ts), never a
 * real PG connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resetListenerPoolAfterTimeout = vi.fn();
const runBackgroundJanitorOnce = vi.fn().mockResolvedValue(undefined);
let listenImpl: (channel: string, cb: (payload: string) => void) => Promise<{ unlisten: () => Promise<void> }>;

vi.mock('./su-lock-store', () => ({
  getListenerPool: () => ({
    listen: (channel: string, cb: (payload: string) => void) => listenImpl(channel, cb),
  }),
  resetListenerPoolAfterTimeout: (...args: unknown[]) => resetListenerPoolAfterTimeout(...args),
  runBackgroundJanitorOnce: (...args: unknown[]) => runBackgroundJanitorOnce(...args),
}));

const {
  subscribeWorkspace,
  withListenTimeout,
  ListenOpTimeoutError,
  recoverFromDeadListenConnection,
  _activeWorkspaceCount,
} = await import('./workspace-listener');

describe('withListenTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves normally when the raced promise settles before the deadline', async () => {
    const p = withListenTimeout('op', Promise.resolve('ok'));
    await expect(p).resolves.toBe('ok');
  });

  it('propagates a genuine rejection unchanged (not a timeout)', async () => {
    const p = withListenTimeout('op', Promise.reject(new Error('boom')));
    await expect(p).rejects.toThrow('boom');
  });

  it('rejects with ListenOpTimeoutError when the promise never settles', async () => {
    const never = new Promise<string>(() => {});
    const p = withListenTimeout('op', never);
    const assertion = expect(p).rejects.toBeInstanceOf(ListenOpTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('never leaves a dangling timer once the promise resolves (no unhandled rejection later)', async () => {
    const p = withListenTimeout('op', Promise.resolve(1));
    await p;
    // Advancing well past the timeout window must not throw / reject anything
    // further — the timer was cleared on settle.
    await vi.advanceTimersByTimeAsync(60_000);
  });
});

describe('subscribeWorkspace — dead LISTEN connection self-heal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetListenerPoolAfterTimeout.mockClear();
  });
  afterEach(async () => {
    // Drain any workspace state a test left behind so tests don't leak into
    // each other (STATE is module-level).
    vi.useRealTimers();
  });

  it('a listen() call that never resolves times out, and self-heals by resetting the pool', async () => {
    listenImpl = () => new Promise(() => {}); // never settles — simulates a dead LISTEN connection
    const domain = `dead-listen-${Math.random()}`;

    const promise = subscribeWorkspace(domain, () => {});
    const assertion = expect(promise).rejects.toBeInstanceOf(ListenOpTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(resetListenerPoolAfterTimeout).toHaveBeenCalledTimes(1);
    // The failed subscribe must not have registered any workspace state.
    expect(_activeWorkspaceCount()).toBe(0);
  });

  it('a healthy listen() resolves well under the timeout and registers normally', async () => {
    let unlistenCalls = 0;
    listenImpl = async () => ({
      unlisten: async () => {
        unlistenCalls++;
      },
    });
    const domain = `healthy-${Math.random()}`;

    const unsubscribe = await subscribeWorkspace(domain, () => {});
    expect(_activeWorkspaceCount()).toBe(1);

    await unsubscribe();
    expect(unlistenCalls).toBe(1);
    expect(_activeWorkspaceCount()).toBe(0);
    expect(resetListenerPoolAfterTimeout).not.toHaveBeenCalled();
  });

  it('an unlisten() that never resolves times out on unsubscribe, swallows (best-effort), and self-heals', async () => {
    listenImpl = async () => ({
      unlisten: () => new Promise(() => {}), // never settles
    });
    const domain = `dead-unlisten-${Math.random()}`;

    const unsubscribe = await subscribeWorkspace(domain, () => {});
    expect(_activeWorkspaceCount()).toBe(1);

    const done = unsubscribe(); // must resolve (best-effort), never throw
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(done).resolves.toBeUndefined();

    expect(resetListenerPoolAfterTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('recoverFromDeadListenConnection', () => {
  it('clears all tracked workspace state and resets the pool', async () => {
    resetListenerPoolAfterTimeout.mockClear();
    listenImpl = async () => ({ unlisten: async () => {} });
    const domain = `recover-${Math.random()}`;
    await subscribeWorkspace(domain, () => {});
    expect(_activeWorkspaceCount()).toBeGreaterThan(0);

    recoverFromDeadListenConnection();

    expect(_activeWorkspaceCount()).toBe(0);
    expect(resetListenerPoolAfterTimeout).toHaveBeenCalledTimes(1);
  });
});
