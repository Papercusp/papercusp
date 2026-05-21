/**
 * Conformance + adapter-specific tests for FileLockQueueCoordinator
 * (file-locking #11). Delegates the contract assertions to the
 * generic suite in @papercusp/file-claim/conformance — every
 * FileClaimCoordinator implementation in the repo runs the same set.
 */
import { describe, expect, it } from 'vitest';
import { describeConformance } from '@papercusp/file-claim/conformance';
import { FileLockQueueCoordinator } from './file-lock-queue-coordinator.js';

describeConformance('FileLockQueueCoordinator', async () => {
  const coordinator = new FileLockQueueCoordinator();
  return {
    coordinator,
    cleanup: async () => {
      coordinator.underlying.destroy();
    },
  };
});

describe('FileLockQueueCoordinator — adapter-specific', () => {
  it('issues distinct claimIds for repeated acquires by the same owner', async () => {
    const c = new FileLockQueueCoordinator();
    try {
      const a = await c.acquire('w1', ['a.ts'], { waitMs: 0 });
      const b = await c.acquire('w1', ['b.ts'], { waitMs: 0 });
      if (!a.ok || !b.ok) throw new Error('setup');
      expect(a.claim.claimId).not.toBe(b.claim.claimId);
    } finally {
      c.underlying.destroy();
    }
  });

  it('waitMs > 0 still resolves when the lock frees in time', async () => {
    const c = new FileLockQueueCoordinator();
    try {
      const a = await c.acquire('w1', ['p.ts'], { waitMs: 0 });
      if (!a.ok) throw new Error('setup');
      const racer = c.acquire('w2', ['p.ts'], { waitMs: 200 });
      // Release on the next macrotask so w2 has a chance to queue first.
      setTimeout(() => void c.release(a.claim), 10);
      const r = await racer;
      expect(r.ok).toBe(true);
    } finally {
      c.underlying.destroy();
    }
  });

  it('extend({ addPaths: [] }) is a no-op and returns the same path set', async () => {
    const c = new FileLockQueueCoordinator();
    try {
      const a = await c.acquire('w1', ['only.ts'], { waitMs: 0 });
      if (!a.ok) throw new Error('setup');
      const r = await c.extend(a.claim, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.claim.paths]).toEqual(['only.ts']);
    } finally {
      c.underlying.destroy();
    }
  });

  it('heartbeat after release reports {expired:true}', async () => {
    const c = new FileLockQueueCoordinator();
    try {
      const a = await c.acquire('w1', ['hb.ts'], { waitMs: 0 });
      if (!a.ok) throw new Error('setup');
      await c.release(a.claim);
      const hb = await c.heartbeat(a.claim);
      expect(hb).toEqual({ ok: false, expired: true });
    } finally {
      c.underlying.destroy();
    }
  });
});
