/**
 * routines-loop-fields.test.ts — pure (no-DB) unit coverage for the LOOP recurrence
 * kind's JS-side helpers (loop-routines-interval-recurrence-2026-06-20 P-001 / B-LOOP-1).
 *
 * The load-bearing claim/park behavior is proven against a real Postgres in
 * operator-core/.../claim.integration.test.ts; this file pins the cheap, pure pieces:
 * the next_fire_at='infinity' (parked-loop) sentinel normalization, which keeps every
 * JS reader correct even though postgres-js parses an `infinity` timestamptz to an
 * INVALID Date.
 */
import { describe, expect, it } from 'vitest';
import { NEXT_FIRE_PARKED, isParkedNextFire, normalizeNextFireAt } from './routines-runtime';

describe('routines loop — next_fire_at parked sentinel', () => {
  it('NEXT_FIRE_PARKED is a VALID far-future Date (toISOString works, never due)', () => {
    expect(NEXT_FIRE_PARKED).toBeInstanceOf(Date);
    expect(Number.isNaN(NEXT_FIRE_PARKED.getTime())).toBe(false);
    // It must NOT be due (the SQL `next_fire_at <= now()` semantics, mirrored in JS).
    expect(NEXT_FIRE_PARKED.getTime()).toBeGreaterThan(Date.now());
    // It must be serializable — the footgun the sentinel exists to avoid.
    expect(() => NEXT_FIRE_PARKED.toISOString()).not.toThrow();
  });

  it('normalizeNextFireAt maps postgres-js infinity (an Invalid Date) → NEXT_FIRE_PARKED', () => {
    // postgres-js parses `infinity`::timestamptz to an Invalid Date (getTime()===NaN);
    // `new Date('infinity')` reproduces exactly that.
    const pgInfinity = new Date('infinity');
    expect(Number.isNaN(pgInfinity.getTime())).toBe(true); // sanity: the input really is invalid
    const normalized = normalizeNextFireAt(pgInfinity);
    expect(normalized).toBeInstanceOf(Date);
    expect(normalized!.getTime()).toBe(NEXT_FIRE_PARKED.getTime());
    // …and the normalized value is consistent with the SQL not-due semantics + serializable.
    expect(normalized!.getTime()).toBeGreaterThan(Date.now());
    expect(() => normalized!.toISOString()).not.toThrow();
  });

  it('normalizeNextFireAt passes a real finite Date through unchanged, and NULL stays NULL', () => {
    const real = new Date('2026-06-20T12:00:00.000Z');
    expect(normalizeNextFireAt(real)?.getTime()).toBe(real.getTime());
    expect(normalizeNextFireAt(null)).toBeNull();
    expect(normalizeNextFireAt(undefined)).toBeNull();
  });

  it('isParkedNextFire detects the sentinel and only the sentinel', () => {
    expect(isParkedNextFire(NEXT_FIRE_PARKED)).toBe(true);
    expect(isParkedNextFire(new Date(NEXT_FIRE_PARKED.getTime()))).toBe(true); // value equality, not identity
    expect(isParkedNextFire(null)).toBe(false);
    expect(isParkedNextFire(new Date())).toBe(false);
    expect(isParkedNextFire(new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });
});
