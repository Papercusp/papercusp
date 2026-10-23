/**
 * spawn-signing-core.test.ts — pins the ONE shared signing rule both the
 * operator-core signer/verifier and the orchestrator spawn-time signer import
 * (unify-launch-mechanics follow-on, signing dedup). This is the safety net that
 * replaces the old "keep the two copies in lockstep or signatures mismatch"
 * comment: there is now ONE copy, and these tests pin its contract.
 */
import { describe, expect, it } from 'vitest';
import {
  SIGNED_PARAM_ALLOWLIST,
  canonicalizeSpawnParams,
  hmacSpawnBytes,
} from './spawn-signing-core';

describe('spawn-signing-core', () => {
  it('the allowlist is the exact signed-envelope set', () => {
    expect([...SIGNED_PARAM_ALLOWLIST].sort()).toEqual(
      ['chat', 'chunk', 'client', 'detector', 'exp', 'feature', 'harness', 'parent_spawn', 'role', 'run', 'spawn', 'workspace'],
    );
  });

  it('canonicalizes deterministically: sorted by key, value-encoded, & -joined', () => {
    const a = new URLSearchParams('role=worker&harness=p&workspace=w');
    const b = new URLSearchParams('workspace=w&harness=p&role=worker'); // different order
    const ca = canonicalizeSpawnParams(a);
    const cb = canonicalizeSpawnParams(b);
    expect(ca.ok && cb.ok).toBe(true);
    if (ca.ok && cb.ok) {
      expect(ca.canonical).toBe(cb.canonical); // order-independent
      expect(ca.canonical).toBe('harness=p&role=worker&workspace=w');
    }
  });

  it('drops `sig` and any non-allowlisted param (no forged signed params, no reorder trick)', () => {
    const c = canonicalizeSpawnParams(new URLSearchParams('role=worker&sig=deadbeef&evil=1&exp=123'));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.canonical).toBe('exp=123&role=worker'); // sig + evil excluded
  });

  it('encodeURIComponent-encodes values', () => {
    const c = canonicalizeSpawnParams(new URLSearchParams('feature=F-1/a b&role=worker'));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.canonical).toBe('feature=F-1%2Fa%20b&role=worker');
  });

  it('rejects duplicate allowlisted keys (would let a forger append a later value)', () => {
    const c = canonicalizeSpawnParams(new URLSearchParams('role=worker&role=operator'));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('duplicate_param:role');
  });

  it('hmac is stable + key-sensitive (base64url over the canonical)', () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const sig1 = hmacSpawnBytes(k1, 'harness=p&role=worker').toString('base64url');
    const sig1again = hmacSpawnBytes(k1, 'harness=p&role=worker').toString('base64url');
    const sig2 = hmacSpawnBytes(k2, 'harness=p&role=worker').toString('base64url');
    expect(sig1).toBe(sig1again); // deterministic
    expect(sig1).not.toBe(sig2); // key-sensitive
    expect(sig1).toMatch(/^[A-Za-z0-9_-]+$/); // base64url (no +/=)
  });
});
