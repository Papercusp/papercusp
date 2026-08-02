import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetStoreIdentityForTests,
  clearStoreIdentityViolation,
  describeStoreIdentityMismatch,
  parseStoreIdentity,
  pinOrVerifyStoreIdentity,
  pinnedStoreIdentity,
  redactUrl,
  sameStore,
  storeIdentityViolation,
  STORE_IDENTITY_SQL,
  type StoreIdentity,
} from './store-identity';

const OURS: StoreIdentity = { systemIdentifier: '7635091775813704249', database: 'papercusp' };
/** A different cluster: what a freshly-initdb'd impostor embedded PG necessarily looks like. */
const IMPOSTOR: StoreIdentity = { systemIdentifier: '7999000111222333444', database: 'papercusp' };

const OUR_URL = 'postgresql://harness_admin:secret@localhost:5432/papercusp';
const IMPOSTOR_URL = 'postgresql://harness_admin:secret@127.0.0.1:22060/papercusp';

beforeEach(() => {
  _resetStoreIdentityForTests();
});

describe('parseStoreIdentity — tolerant, never partial', () => {
  it('reads a well-formed probe row', () => {
    expect(
      parseStoreIdentity([{ system_identifier: '7635091775813704249', database: 'papercusp' }]),
    ).toEqual(OURS);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-array', { system_identifier: '1', database: 'papercusp' }],
    ['an empty result set', []],
    ['a row that is not an object', ['nope']],
    ['a missing system_identifier', [{ database: 'papercusp' }]],
    ['a missing database', [{ system_identifier: '1' }]],
    ['an empty system_identifier', [{ system_identifier: '', database: 'papercusp' }]],
    ['a whitespace-only database', [{ system_identifier: '1', database: '   ' }]],
    ['a non-string identifier (numeric overflow risk)', [{ system_identifier: 7635091775813704249, database: 'papercusp' }]],
  ])('returns null for %s rather than a half-read identity', (_label, rows) => {
    expect(parseStoreIdentity(rows)).toBeNull();
  });

  it('trims incidental whitespace', () => {
    expect(parseStoreIdentity([{ system_identifier: ' 42 ', database: ' papercusp ' }])).toEqual({
      systemIdentifier: '42',
      database: 'papercusp',
    });
  });

  it('keeps system_identifier as a STRING — it is a 64-bit value that a JS number would round', () => {
    const parsed = parseStoreIdentity([
      { system_identifier: '7635091775813704249', database: 'papercusp' },
    ]);
    expect(parsed?.systemIdentifier).toBe('7635091775813704249');
    // The round-trip a `number` would silently perform, and why the ::text cast exists.
    expect(String(Number('7635091775813704249'))).not.toBe('7635091775813704249');
  });
});

describe('the probe SQL', () => {
  it('casts system_identifier to text so a bigint cannot be rounded in transit', () => {
    expect(STORE_IDENTITY_SQL).toContain('system_identifier::text');
  });

  it('carries current_database(), because one cluster can host several databases', () => {
    expect(STORE_IDENTITY_SQL).toContain('current_database()');
  });
});

describe('pin and verify', () => {
  it('pins the first determinate identity', () => {
    const v = pinOrVerifyStoreIdentity(OURS, OUR_URL);
    expect(v.kind).toBe('pinned');
    expect(pinnedStoreIdentity()).toMatchObject({ systemIdentifier: OURS.systemIdentifier });
  });

  it('matches a later sighting of the same store', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    expect(pinOrVerifyStoreIdentity(OURS, OUR_URL).kind).toBe('match');
    expect(storeIdentityViolation()).toBeNull();
  });

  it('matches across a RESTART on a different port — same cluster, moved endpoint', () => {
    // Generation-2's case: the address moved. That is a rebind, not a violation.
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:20216/papercusp');
    expect(v.kind).toBe('match');
    expect(storeIdentityViolation()).toBeNull();
  });

  it('flags a DIFFERENT CLUSTER — the 2026-08-02 impostor', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    expect(v.kind).toBe('mismatch');
    expect(storeIdentityViolation()).not.toBeNull();
  });

  it('flags the RIGHT cluster but the WRONG database', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(
      { systemIdentifier: OURS.systemIdentifier, database: 'papercusp_test' },
      OUR_URL,
    );
    expect(v.kind).toBe('mismatch');
  });

  it('sameStore requires BOTH halves to agree', () => {
    expect(sameStore(OURS, { ...OURS })).toBe(true);
    expect(sameStore(OURS, { ...OURS, database: 'other' })).toBe(false);
    expect(sameStore(OURS, { ...OURS, systemIdentifier: '1' })).toBe(false);
  });
});

describe('indeterminate never rejects and never pins', () => {
  it('does not pin when the very first probe is unreadable', () => {
    const v = pinOrVerifyStoreIdentity(null, OUR_URL);
    expect(v.kind).toBe('indeterminate');
    expect(pinnedStoreIdentity()).toBeNull();
  });

  it('does not violate when a probe fails AFTER a pin', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(null, OUR_URL);
    expect(v.kind).toBe('indeterminate');
    expect(storeIdentityViolation()).toBeNull();
  });

  it('an unreadable probe between two good ones changes nothing', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    pinOrVerifyStoreIdentity(null, OUR_URL);
    expect(pinOrVerifyStoreIdentity(OURS, OUR_URL).kind).toBe('match');
    expect(storeIdentityViolation()).toBeNull();
  });

  it('a check that cannot run can never reject a healthy configuration', () => {
    // The invariant, stated as a property: no sequence of indeterminate probes
    // can ever produce a violation.
    for (let i = 0; i < 25; i++) pinOrVerifyStoreIdentity(null, OUR_URL);
    expect(storeIdentityViolation()).toBeNull();
    expect(pinnedStoreIdentity()).toBeNull();
  });
});

describe('the violation latches', () => {
  it('survives the store coming back — the evidence is the point', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    // The impostor dies and the real store returns; a self-clearing check would go quiet
    // here and discard the only record that anything happened.
    expect(pinOrVerifyStoreIdentity(OURS, OUR_URL).kind).toBe('match');
    expect(storeIdentityViolation()).not.toBeNull();
  });

  it('retains the FIRST divergence, not the most recent flap', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    pinOrVerifyStoreIdentity({ systemIdentifier: '3333', database: 'papercusp' }, 'postgresql://localhost:1/x');
    expect(storeIdentityViolation()?.observed.systemIdentifier).toBe(IMPOSTOR.systemIdentifier);
  });

  it('is released only deliberately', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    clearStoreIdentityViolation();
    expect(storeIdentityViolation()).toBeNull();
  });
});

describe('redaction', () => {
  it('never echoes the password', () => {
    const out = redactUrl(OUR_URL);
    expect(out).not.toContain('secret');
    expect(out).toContain('5432');
    expect(out).toContain('papercusp');
  });

  it('degrades to a label rather than echoing an unparseable string', () => {
    expect(redactUrl('not a url with a secret in it')).toBe('<unparseable-url>');
  });

  it('the mismatch message leaks no credentials', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    if (v.kind !== 'mismatch') throw new Error('expected mismatch');
    expect(describeStoreIdentityMismatch(v.pinned, v.observed)).not.toContain('secret');
  });
});

describe('the operator-facing message', () => {
  it('names both stores and both endpoints', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    if (v.kind !== 'mismatch') throw new Error('expected mismatch');
    const msg = describeStoreIdentityMismatch(v.pinned, v.observed);
    expect(msg).toContain(OURS.systemIdentifier);
    expect(msg).toContain(IMPOSTOR.systemIdentifier);
    expect(msg).toContain('22060');
  });

  it('explicitly forbids the data-loss reading that made this outage expensive', () => {
    pinOrVerifyStoreIdentity(OURS, OUR_URL);
    const v = pinOrVerifyStoreIdentity(IMPOSTOR, IMPOSTOR_URL);
    if (v.kind !== 'mismatch') throw new Error('expected mismatch');
    const msg = describeStoreIdentityMismatch(v.pinned, v.observed);
    // The single most costly misreading: 'not found' taken as deletion.
    expect(msg).toMatch(/NOT evidence of data loss/i);
    expect(msg).toMatch(/do not delete/i);
  });
});
