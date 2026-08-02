/**
 * EI-19311807188719573 — proves the unit-layer real-Postgres rail actually FIRES.
 *
 * A guard nobody has watched fail is indistinguishable from a no-op, and this whole
 * work item exists because a test that could not fail sat green for weeks. So assert
 * the rail's behaviour directly rather than trusting that wiring it up was enough.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
const ORIGINAL_FLAG = process.env.PAPERCUSP_FORBID_REAL_PG;

beforeEach(() => {
  // A resolvable URL, so the call reaches buildClient rather than failing earlier for
  // an unrelated reason. Nothing ever connects to it — the rail throws first.
  process.env.HARNESS_ADMIN_DATABASE_URL = 'postgres://someuser:hunter2@127.0.0.1:5432/pcdb';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = ORIGINAL_URL;
  if (ORIGINAL_FLAG === undefined) delete process.env.PAPERCUSP_FORBID_REAL_PG;
  else process.env.PAPERCUSP_FORBID_REAL_PG = ORIGINAL_FLAG;
});

describe('the unit-layer real-Postgres rail', () => {
  it('is ARMED for every unit test — the setup file, not each test, turns it on', () => {
    // If this ever reads undefined, the rail silently stopped protecting the whole
    // unit layer and every escape-to-production-data bug becomes invisible again.
    expect(process.env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
  });

  it('refuses to build a real pool, naming both the offending pool and the fix', async () => {
    const { getOrgPg } = await import('./connection');
    let thrown: Error | null = null;
    try {
      getOrgPg();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, 'getOrgPg() must not open a real pool under the unit layer').toBeTruthy();
    const msg = thrown!.message;
    expect(msg).toContain('REAL Postgres connection');
    // The message has to be self-explaining: the alternative symptom is a connection
    // timeout that reads like flakiness, which is what sends people chasing ghosts.
    expect(msg, 'must name the offending pool').toContain('org-admin');
    expect(msg, 'must state the escape hatch').toContain('integration.test.ts');
  });

  it('REDACTS credentials — this message lands in test output and CI logs', async () => {
    const { getOrgPg } = await import('./connection');
    let msg = '';
    try {
      getOrgPg();
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg, 'the password must never be echoed').not.toContain('hunter2');
    expect(msg).toContain('<redacted>');
    // Host/port survive redaction — they are what identifies WHICH database was hit,
    // and are the first thing a reader needs.
    expect(msg).toContain('127.0.0.1:5432');
  });

  it('stands down when the flag is cleared, so an integration run is unaffected', async () => {
    delete process.env.PAPERCUSP_FORBID_REAL_PG;
    const { getOrgPg } = await import('./connection');
    // With the rail down, this proceeds past the guard. It may still fail trying to
    // reach a database that isn't there — that is fine and is the point: whatever it
    // throws, it must NOT be the rail's refusal.
    let msg = '';
    try {
      getOrgPg();
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).not.toContain('REAL Postgres connection');
  });
});
