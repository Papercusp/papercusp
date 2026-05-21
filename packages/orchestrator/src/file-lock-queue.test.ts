import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FileLockQueue } from './file-lock-queue.js';

// Drain pending microtasks. `await Promise.resolve()` only pumps one
// microtask hop; .then callbacks attached to already-resolved promises
// can run in subsequent hops, so use a setTimeout(0) bounce to force a
// full event-loop turn instead.
const yieldEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

test('acquire on empty queue is immediate', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['src/a.ts', 'src/b.ts']);
  assert.deepEqual([...h.paths], ['src/a.ts', 'src/b.ts']);
  assert.equal(h.released, false);
  assert.equal(q.snapshot().queueLength, 0);
});

test('acquire normalizes: trims, dedupes, sorts', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['  src/b.ts ', 'src/a.ts', 'src/a.ts', '']);
  // Empty-string entries dropped, dups removed, sorted alphabetically.
  assert.deepEqual([...h.paths], ['src/a.ts', 'src/b.ts']);
});

test('empty path set is a no-op (not an error)', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', []);
  assert.deepEqual([...h.paths], []);
  // Releasing it is also a no-op.
  q.release(h);
  assert.equal(q.snapshot().queueLength, 0);
});

test('overlapping acquires queue, FIFO grant on release', async () => {
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a', 'b']);

  // w2 wants `b` (held by w1) — should queue.
  let w2Resolved = false;
  const h2Promise = q.acquire('w2', ['b', 'c']).then((h) => {
    w2Resolved = true;
    return h;
  });
  // Yield once so any synchronous resolution would land.
  await yieldEventLoop();
  assert.equal(w2Resolved, false, 'w2 must not have resolved while w1 holds b');
  assert.equal(q.snapshot().queueLength, 1);

  q.release(h1);
  const h2 = await h2Promise;
  assert.deepEqual([...h2.paths], ['b', 'c']);
  q.release(h2);
});

test('non-conflicting waiters proceed concurrently with a blocked head', async () => {
  // w1 holds `a`. w2 wants `a, b` (blocked by w1's hold on `a`). w3
  // wants `c, d` (entirely free). Fairness: w3 must NOT wait for w2,
  // because their path sets are disjoint AND disjoint from w2's wants.
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a']);

  let w2Done = false;
  let w3Done = false;
  const w2 = q.acquire('w2', ['a', 'b']).then((h) => {
    w2Done = true;
    q.release(h);
  });
  const w3 = q.acquire('w3', ['c', 'd']).then((h) => {
    w3Done = true;
    q.release(h);
  });
  await yieldEventLoop();
  await yieldEventLoop();
  assert.equal(w2Done, false, 'w2 must wait for w1');
  assert.equal(w3Done, true, 'w3 must NOT wait for w2 — their files are disjoint');

  q.release(h1);
  await Promise.all([w2, w3]);
});

test('head waiter reserves its path set — later overlapping waiters wait', async () => {
  // w1 holds `a`. w2 (head waiter) wants `a, b`. w3 wants just `b`.
  // Strict FIFO would grant w3 immediately (b is free). Our compromise:
  // w3 must wait because granting it would let w3 starve w2 — w2 needs
  // `b` to proceed, and we can't take `b` from under it later.
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a']);

  let w2Done = false;
  let w3Done = false;
  const w2 = q.acquire('w2', ['a', 'b']).then((h) => {
    w2Done = true;
    q.release(h);
  });
  const w3 = q.acquire('w3', ['b']).then((h) => {
    w3Done = true;
    q.release(h);
  });
  await yieldEventLoop();
  assert.equal(w3Done, false, 'w3 must wait — head waiter w2 needs b');

  q.release(h1);
  await Promise.all([w2, w3]);
  assert.equal(w2Done, true);
  assert.equal(w3Done, true);
});

test('release is idempotent', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a']);
  q.release(h);
  q.release(h); // must not throw
  assert.equal(h.released, true);
  assert.equal(q.snapshot().queueLength, 0);
});

test('tryExtend succeeds when new paths are free', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a', 'b']);
  const ok = q.tryExtend(h, ['c', 'd']);
  assert.equal(ok, true);
  assert.deepEqual([...h.paths], ['a', 'b', 'c', 'd']);
  q.release(h);
});

test('tryExtend ignores paths already held', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a', 'b']);
  const ok = q.tryExtend(h, ['a']); // already held — must succeed as no-op
  assert.equal(ok, true);
  assert.deepEqual([...h.paths], ['a', 'b']);
  q.release(h);
});

test('tryExtend fails when a new path is held by someone else', async () => {
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a']);
  const h2 = await q.acquire('w2', ['b']);
  const ok = q.tryExtend(h1, ['b']);
  assert.equal(ok, false);
  // h1 still holds only its original set.
  assert.deepEqual([...h1.paths], ['a']);
  q.release(h1);
  q.release(h2);
});

test('tryExtend refuses to leapfrog a fair earlier waiter', async () => {
  // w1 holds `a`. w2 is queued for `b` (earlier-arriving waiter on b).
  // w3 holds `c` and tries to extend with `b` — even though `b` is
  // technically free, granting would starve w2.
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a']);
  // Block: simulate w2 joining the queue. It wants `b`, but b is free
  // — how do we get it queued? We need contention. Simplest: have it
  // also want `a`.
  let w2Done = false;
  const w2 = q.acquire('w2', ['a', 'b']).then((h) => {
    w2Done = true;
    q.release(h);
  });
  await yieldEventLoop();

  const h3 = await q.acquire('w3', ['c']);
  const ok = q.tryExtend(h3, ['b']);
  assert.equal(ok, false, 'tryExtend must refuse — w2 (earlier) wants b');

  q.release(h3);
  q.release(h1);
  await w2;
  assert.equal(w2Done, true);
});

test('release after tryExtend frees all extended paths', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a']);
  q.tryExtend(h, ['b', 'c']);

  let othersDone = false;
  const others = q.acquire('w2', ['a', 'b', 'c']).then((h2) => {
    othersDone = true;
    q.release(h2);
  });
  await yieldEventLoop();
  assert.equal(othersDone, false);

  q.release(h);
  await others;
  assert.equal(othersDone, true);
});

test('reap force-releases all paths owned by a worker and unblocks waiters', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a', 'b']);

  let w2Done = false;
  const w2 = q.acquire('w2', ['b']).then((h2) => {
    w2Done = true;
    q.release(h2);
  });
  await yieldEventLoop();
  assert.equal(w2Done, false);

  const reaped = q.reap('w1');
  assert.equal(reaped, 2);
  await w2;
  assert.equal(w2Done, true);

  // Subsequent release on the reaped handle is a no-op (won't take
  // back paths from the new owner). The reaped handle still has its
  // path list but the locks have moved.
  // Calling release on it shouldn't blow up:
  q.release(h);
});

test('destroy rejects pending waiters', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a']);

  const w2 = q.acquire('w2', ['a']);
  q.destroy();
  await assert.rejects(w2, /destroyed/);
  // Held handle is not affected.
  q.release(h);
  // Subsequent acquires on a destroyed queue throw.
  await assert.rejects(q.acquire('w3', ['b']), /destroyed/);
});

test('snapshot reflects current holdings + queue length', async () => {
  const q = new FileLockQueue();
  const h = await q.acquire('w1', ['a', 'b']);

  q.acquire('w2', ['b']); // queued
  q.acquire('w3', ['a']); // queued
  await yieldEventLoop();

  const snap = q.snapshot();
  assert.deepEqual(snap.held, { a: 'w1', b: 'w1' });
  assert.equal(snap.queueLength, 2);

  q.release(h);
  // Allow the queue to drain.
  await new Promise((r) => setTimeout(r, 0));
});

// Stress test: 5000 lock ops (50 workers × 100 acquires) with brief
// 0–2ms holds. The internal `elapsed < 30_000` assertion is the real
// deadlock detector. The vitest `testTimeout: 30_000` ceiling matches
// it so the test isn't killed early under suite-level CPU contention —
// in isolation it runs in ~3s, but during the full vitest run other
// tests starve this one and the default 5s test budget is too tight.
test('stress: 50 workers, 100 acquires each, no deadlock + all complete', async () => {
  const q = new FileLockQueue();
  const FILES = ['a', 'b', 'c', 'd', 'e'];
  const N_WORKERS = 50;
  const N_OPS = 100;

  async function worker(id: string) {
    for (let i = 0; i < N_OPS; i++) {
      // Random subset of 1–3 files.
      const k = 1 + Math.floor(Math.random() * 3);
      const want = [...FILES].sort(() => Math.random() - 0.5).slice(0, k);
      const h = await q.acquire(id, want);
      // Hold briefly.
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      q.release(h);
    }
  }

  const start = Date.now();
  await Promise.all(
    Array.from({ length: N_WORKERS }, (_, i) => worker(`w${i}`)),
  );
  const elapsed = Date.now() - start;
  // Should complete in well under 30s with no deadlocks.
  assert.ok(elapsed < 30_000, `stress took ${elapsed}ms — possible deadlock`);
  assert.equal(q.snapshot().queueLength, 0);
  assert.deepEqual(q.snapshot().held, {});
}, 30_000);

test('#8 acquire timeout: rejects with LockAcquireTimeoutError while held', async () => {
  const { LockAcquireTimeoutError } = await import('./file-lock-queue.js');
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['src/x.ts']);
  // w2 wants the same path; it will block. With a 50ms timeout it must
  // reject rather than wait forever.
  let err: unknown;
  try {
    await q.acquire('w2', ['src/x.ts'], { timeoutMs: 50 });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LockAcquireTimeoutError, 'expected LockAcquireTimeoutError');
  const tErr = err as InstanceType<typeof LockAcquireTimeoutError>;
  assert.equal(tErr.owner, 'w2');
  assert.deepEqual([...tErr.paths], ['src/x.ts']);
  assert.deepEqual([...tErr.contendingOwners], ['w1']);
  // The timed-out waiter is removed from the queue.
  assert.equal(q.snapshot().queueLength, 0);
  // The holder is unaffected; releasing it still works.
  q.release(h1);
});

test('#8 acquire timeout: does NOT fire when the lock is granted in time', async () => {
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['src/y.ts']);
  // w2 blocks with a generous timeout; we release h1 well before it.
  const p = q.acquire('w2', ['src/y.ts'], { timeoutMs: 10_000 });
  q.release(h1);
  const h2 = await p; // must resolve, not reject
  assert.deepEqual([...h2.paths], ['src/y.ts']);
  q.release(h2);
});

test('#8 acquire with no timeout option blocks indefinitely (unchanged default)', async () => {
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['src/z.ts']);
  let settled = false;
  const p = q.acquire('w2', ['src/z.ts']).then((h) => {
    settled = true;
    return h;
  });
  await yieldEventLoop();
  assert.equal(settled, false, 'no-timeout acquire must still be pending');
  q.release(h1);
  const h2 = await p;
  q.release(h2);
});

test('#7 reap also drops a queued waiter, not just held locks', async () => {
  const q = new FileLockQueue();
  const h1 = await q.acquire('w1', ['a']);
  // w2 queues behind w1 for the same path.
  let w2Rejected = false;
  const w2 = q.acquire('w2', ['a']).catch((e: unknown) => {
    w2Rejected = true;
    return e;
  });
  await yieldEventLoop();
  assert.equal(q.snapshot().queueLength, 1);
  // Reaping w2 must drop + reject its queued waiter.
  const reaped = q.reap('w2');
  assert.equal(reaped, 1);
  const err = await w2;
  assert.equal(w2Rejected, true);
  assert.match((err as Error).message, /reaped/);
  assert.equal(q.snapshot().queueLength, 0);
  // w1 is unaffected.
  q.release(h1);
});
