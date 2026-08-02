/**
 * RECURRENCE GUARD for the 2026-08-02 22:40Z silent-outage
 * (plan outage-must-not-be-silent-2026-08-02, P-004 / D-001).
 *
 * This is the test that would have FAILED before the outage and passes after it. It does not
 * test the identity guard in isolation — that is `store-identity.test.ts`. It pins the
 * RELATIONSHIP between the guards, which is the thing that was actually wrong:
 *
 *   the liveness gate ACCEPTS the impostor, and only identity rejects it.
 *
 * That relationship is what makes "just check the pid/port harder" a non-fix, and it is
 * exactly what a future reader (or a future me) will be tempted to undo — by deleting the
 * identity probe as redundant with the liveness gate, or by "fixing" the outage a second
 * time by tightening liveness. Either move reddens this file.
 *
 * It deliberately exercises `_parseDiscoveryJson` — the db package's OWN discovery gate,
 * which is the one on the `getOrgPg()` read path that actually served the wrong answers —
 * rather than the generic resolver used by `getHarnessAdminUrl()`. Those are two separate
 * implementations with different gate coverage (the generic one also has a /proc port gate;
 * this one does not), and this test targets the path the incident took.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { _parseDiscoveryJson } from './connection';
import {
  _resetStoreIdentityForTests,
  pinOrVerifyStoreIdentity,
  storeIdentityViolation,
  type StoreIdentity,
} from './store-identity';

/** The real store the process pinned at boot, from the trusted env/native path. */
const REAL_STORE: StoreIdentity = {
  systemIdentifier: '7635091775813704249',
  database: 'papercusp',
};
const REAL_URL = 'postgresql://harness_admin:pw@localhost:5432/papercusp';

/**
 * The impostor: an ephemeral operator instance's embedded Postgres. A DIFFERENT cluster,
 * so initdb necessarily gave it a different system_identifier — but it is a complete,
 * freshly-migrated `papercusp` database, which is why every shape-based check passed.
 */
const IMPOSTOR_STORE: StoreIdentity = {
  systemIdentifier: '7111222333444555666',
  database: 'papercusp',
};
const IMPOSTOR_PORT = 22060;
const IMPOSTOR_URL = `postgresql://harness_admin:pw@127.0.0.1:${IMPOSTOR_PORT}/papercusp`;

/**
 * The discovery file exactly as the incident had it: a LIVE writer pid (we use our own
 * process, which is by definition alive) advertising the impostor's port.
 */
function impostorDiscoveryJson(): string {
  return JSON.stringify({
    url: IMPOSTOR_URL,
    port: IMPOSTOR_PORT,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  _resetStoreIdentityForTests();
});

describe('the 2026-08-02 impostor, replayed through the real read path', () => {
  it('LIVENESS ACCEPTS IT — the writer pid is alive, so the gate waves it through', () => {
    const endpoint = _parseDiscoveryJson(impostorDiscoveryJson());

    // This is the load-bearing assertion. If someone "fixes" the outage by tightening the
    // liveness gate, they will expect this to become null — and it cannot, because the
    // impostor's writer really was alive. The gate is not broken; it is answering a
    // different question.
    expect(endpoint).not.toBeNull();
    expect(endpoint?.port).toBe(IMPOSTOR_PORT);
    expect(endpoint?.host).toBe('127.0.0.1');
  });

  it('IDENTITY REJECTS IT — the only guard that separates "alive" from "ours"', () => {
    // Boot: the process pins the real store from the trusted env/native path.
    expect(pinOrVerifyStoreIdentity(REAL_STORE, REAL_URL).kind).toBe('pinned');

    // The discovery file is rewritten; a pool rebuilds against the impostor.
    const verdict = pinOrVerifyStoreIdentity(IMPOSTOR_STORE, IMPOSTOR_URL);

    expect(verdict.kind).toBe('mismatch');
    expect(storeIdentityViolation()).not.toBeNull();
    expect(storeIdentityViolation()?.observed.url).toContain(String(IMPOSTOR_PORT));
  });

  it('the two verdicts DISAGREE — that disagreement is the whole fix', () => {
    const livenessAccepts = _parseDiscoveryJson(impostorDiscoveryJson()) !== null;
    pinOrVerifyStoreIdentity(REAL_STORE, REAL_URL);
    const identityRejects = pinOrVerifyStoreIdentity(IMPOSTOR_STORE, IMPOSTOR_URL).kind === 'mismatch';

    expect(livenessAccepts).toBe(true);
    expect(identityRejects).toBe(true);
  });

  it('a DEAD writer is still caught by liveness — identity did not replace it', () => {
    // The complementary half: identity does not subsume the liveness gate, so removing
    // liveness in favour of identity would reopen the phase-2 (dead endpoint) failure.
    const deadPidJson = JSON.stringify({ url: IMPOSTOR_URL, port: IMPOSTOR_PORT, pid: 2 ** 22 });
    expect(_parseDiscoveryJson(deadPidJson, () => false)).toBeNull();
  });
});

describe('what must NOT trip the guard', () => {
  it('our own store restarting on a NEW PORT is a rebind, not a violation', () => {
    // The single most likely false positive: the desktop restarts, embedded PG picks a new
    // free port, every pool rebinds. Same cluster ⇒ silence. If this ever fails, the guard
    // is unshippable — it would alarm on ordinary desktop restarts.
    pinOrVerifyStoreIdentity(REAL_STORE, REAL_URL);
    const v = pinOrVerifyStoreIdentity(REAL_STORE, 'postgresql://127.0.0.1:20216/papercusp');

    expect(v.kind).toBe('match');
    expect(storeIdentityViolation()).toBeNull();
  });

  it('a store that cannot be fingerprinted is never condemned', () => {
    // An older server, a restricted role, a transient query failure. The check cannot run,
    // so it must have no opinion — never a violation.
    pinOrVerifyStoreIdentity(REAL_STORE, REAL_URL);
    expect(pinOrVerifyStoreIdentity(null, IMPOSTOR_URL).kind).toBe('indeterminate');
    expect(storeIdentityViolation()).toBeNull();
  });
});
