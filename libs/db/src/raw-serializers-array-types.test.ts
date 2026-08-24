/**
 * `seedBuiltinArrayTypes` — WI-41207. Guards the fix that makes `sql.array(...)` correctly
 * typed on the FIRST query of a cold pool.
 *
 * WHY THIS NEEDS NO DATABASE. The defect is decided entirely client-side, at query-BUILD time,
 * by one expression in postgres-js (`types.js:89`):
 *
 *     x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value)
 *
 * `x.array` is `options.shared.typeArrayMap`. When it is empty the lookup misses and the
 * expression falls through to `x.type` — the ELEMENT oid (25/text) instead of the ARRAY oid
 * (1009/text[]) — so the parameter is declared `text` while its value is an array and the
 * server answers "op ANY/ALL (array) requires array on right side". Constructing a postgres-js
 * client does NOT connect (it is lazy), so the exact inputs to that expression can be asserted
 * here with no I/O, no Docker, and no flakiness.
 *
 * The negative control below is the point of the file: without it every assertion here would
 * pass just as happily if `seedBuiltinArrayTypes` did nothing at all.
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { seedBuiltinArrayTypes } from './raw-serializers';

const TEXT_OID = 25;
const TEXT_ARRAY_OID = 1009;

/** A client that is constructed but never connected — no socket is opened. */
function coldClient(): any {
  return postgres('postgresql://unused:unused@127.0.0.1:1/unused', { max: 1 });
}

/** Reproduce postgres-js's own build-time type choice (types.js:89) for an array parameter. */
function resolvedArrayOid(sql: any, values: unknown[]): number | undefined {
  const p = sql.array(values);
  return p.array?.[p.type] ?? p.type;
}

describe('seedBuiltinArrayTypes (WI-41207)', () => {
  it('NEGATIVE CONTROL: an unseeded cold client resolves text[] to the ELEMENT oid — the bug', () => {
    // If this ever starts passing as 1009, either postgres-js changed or something else is
    // seeding the map — and the rest of this file has stopped proving anything. Fail here first.
    const sql = coldClient();
    try {
      expect(sql.options.shared.typeArrayMap[TEXT_OID]).toBeUndefined();
      expect(resolvedArrayOid(sql, ['a', 'b'])).toBe(TEXT_OID);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
    }
  });

  it('a seeded cold client resolves a string array to text[] (1009)', () => {
    const sql = coldClient();
    try {
      seedBuiltinArrayTypes(sql);
      expect(sql.options.shared.typeArrayMap[TEXT_OID]).toBe(TEXT_ARRAY_OID);
      expect(resolvedArrayOid(sql, ['pending', 'running'])).toBe(TEXT_ARRAY_OID);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
    }
  });

  it('never clobbers an entry a real fetchArrayTypes() already established', () => {
    // The catalog is authoritative over our constants; seeding must be additive only.
    const sql = coldClient();
    try {
      sql.options.shared.typeArrayMap[TEXT_OID] = 4242; // pretend the handshake wrote this
      seedBuiltinArrayTypes(sql);
      expect(sql.options.shared.typeArrayMap[TEXT_OID]).toBe(4242);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
    }
  });

  it('SHAPE GUARD: postgres-js still exposes options.shared.typeArrayMap', () => {
    // The fix reaches into library internals (as restoreRawDateSerializers/JsonbSerializer
    // already do). If an upgrade moves or renames this, the seed would silently become a no-op
    // and WI-41207 would quietly return. Fail loudly at that upgrade instead.
    const sql = coldClient();
    try {
      expect(sql.options, 'postgres-js client.options').toBeTruthy();
      expect(sql.options.shared, 'postgres-js client.options.shared').toBeTruthy();
      expect(
        sql.options.shared.typeArrayMap,
        'postgres-js client.options.shared.typeArrayMap — seedBuiltinArrayTypes writes here',
      ).toBeTruthy();
      // And the Parameter still carries a reference to that same map.
      expect(sql.array(['a']).array).toBe(sql.options.shared.typeArrayMap);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
    }
  });

  it('tolerates a client without the expected internals instead of throwing', () => {
    expect(() => seedBuiltinArrayTypes({} as any)).not.toThrow();
    expect(() => seedBuiltinArrayTypes(undefined as any)).not.toThrow();
    expect(() => seedBuiltinArrayTypes({ options: {} } as any)).not.toThrow();
  });

  it('DOCUMENTS A SEPARATE, UNFIXED DEFECT: a NUMBER array is typed text[], not int4[]', () => {
    // postgres-js's inferType has no `number` case, so sql.array([1,2,3]) infers oid 25 and this
    // seed cannot help — it resolves to text[] and fails against an integer column even on a
    // fully warmed pool ("operator does not exist: integer = text"). Call sites passing numbers
    // must pass the OID explicitly: sql.array(xs, 1007). Pinned so the limitation is discovered
    // by reading this file rather than by a production failure.
    const sql = coldClient();
    try {
      seedBuiltinArrayTypes(sql);
      expect(resolvedArrayOid(sql, [1, 2, 3])).toBe(TEXT_ARRAY_OID); // NOT 1007/int4[]
    } finally {
      void sql.end({ timeout: 0 }).catch(() => {});
    }
  });
});
