/**
 * `installNumericArrayTyping` — EI-21301868186403490. Guards the fix that makes
 * `sql.array([1, 2, 3])` reach Postgres as an INTEGER array instead of text[].
 *
 * WHY THIS NEEDS NO DATABASE. Like its WI-41207 sibling, the defect is decided entirely
 * client-side at query-BUILD time. postgres-js's `array()` (`index.js:326`) is:
 *
 *     new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap)
 *
 * and `inferType` (`types.js:221`) has no `number` case, so it returns 0 and the `|| 25`
 * coerces a numeric array to TEXT. Constructing a client does not connect, so the exact
 * inputs to that expression are assertable here with no I/O and no flakiness.
 *
 * THE NEGATIVE CONTROL IS THE POINT OF THE FILE. Without it every assertion below would pass
 * just as happily if `installNumericArrayTyping` did nothing at all. The end-to-end behaviour
 * against a real server ("operator does not exist: integer = text") was measured separately;
 * what is pinned HERE is the client-side type choice that causes it.
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  PG_ELEMENT_OID_FLOAT8,
  PG_ELEMENT_OID_INT8,
  installNumericArrayTyping,
  numericArrayElementOid,
  seedBuiltinArrayTypes,
} from './raw-serializers';

const TEXT_OID = 25;
const TEXT_ARRAY_OID = 1009;
const INT8_ARRAY_OID = 1016;
const FLOAT8_ARRAY_OID = 1022;

/** A client that is constructed but never connected — no socket is opened. */
function coldClient(): any {
  return postgres('postgresql://unused:unused@127.0.0.1:1/unused', { max: 1 });
}

function withClient(fn: (sql: any) => void): void {
  const sql = coldClient();
  try {
    fn(sql);
  } finally {
    void sql.end({ timeout: 0 }).catch(() => {});
  }
}

/** Reproduce postgres-js's own build-time type choice (types.js:89) for an array parameter. */
function resolvedArrayOid(p: any): number | undefined {
  return p.array?.[p.type] ?? p.type;
}

describe('numericArrayElementOid (EI-21301868186403490)', () => {
  it('types an all-integer array as int8 and a fractional one as float8', () => {
    expect(numericArrayElementOid([1, 2, 3])).toBe(PG_ELEMENT_OID_INT8);
    expect(numericArrayElementOid([1.5])).toBe(PG_ELEMENT_OID_FLOAT8);
    // Beyond Number.MAX_SAFE_INTEGER: claiming int8 precision here would be a lie.
    expect(numericArrayElementOid([2 ** 53])).toBe(PG_ELEMENT_OID_FLOAT8);
    // One fractional value decides the whole array.
    expect(numericArrayElementOid([1, 2, 3.5])).toBe(PG_ELEMENT_OID_FLOAT8);
  });

  it('declines anything that is not an all-number array', () => {
    expect(numericArrayElementOid(['a', 'b'])).toBeUndefined();
    expect(numericArrayElementOid([1, 'a'])).toBeUndefined(); // mixed — not ours to type
    expect(numericArrayElementOid([])).toBeUndefined(); // no type information
    expect(numericArrayElementOid([null, undefined])).toBeUndefined(); // ditto
    expect(numericArrayElementOid([1n, 2n])).toBeUndefined(); // bigint already infers correctly
  });

  it('ignores NULLs interleaved with real numbers', () => {
    expect(numericArrayElementOid([1, null, 3])).toBe(PG_ELEMENT_OID_INT8);
  });
});

describe('installNumericArrayTyping (EI-21301868186403490)', () => {
  it('NEGATIVE CONTROL: an unpatched client types a NUMBER array as TEXT — the bug', () => {
    // If this ever stops reporting TEXT_OID, postgres-js has changed its coercion and the rest
    // of this file has stopped proving anything. Fail here first, loudly.
    withClient((sql) => {
      expect(sql.array([1, 2, 3]).type).toBe(TEXT_OID);
      seedBuiltinArrayTypes(sql);
      expect(resolvedArrayOid(sql.array([1, 2, 3]))).toBe(TEXT_ARRAY_OID);
    });
  });

  it('a patched client types a number array as int8[] rather than text[]', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      expect(sql.array([1, 2, 3]).type).toBe(PG_ELEMENT_OID_INT8);
      expect(resolvedArrayOid(sql.array([1, 2, 3]))).toBe(INT8_ARRAY_OID);
    });
  });

  it('a patched client types a fractional array as float8[]', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      expect(resolvedArrayOid(sql.array([1.5, 2.5]))).toBe(FLOAT8_ARRAY_OID);
    });
  });

  it('leaves string and bigint arrays exactly as postgres-js typed them', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      const stringsBefore = resolvedArrayOid(sql.array(['a', 'b']));
      const bigintsBefore = resolvedArrayOid(sql.array([1n, 2n]));
      installNumericArrayTyping(sql);
      expect(resolvedArrayOid(sql.array(['a', 'b']))).toBe(stringsBefore);
      expect(resolvedArrayOid(sql.array(['a', 'b']))).toBe(TEXT_ARRAY_OID);
      expect(resolvedArrayOid(sql.array([1n, 2n]))).toBe(bigintsBefore);
      expect(resolvedArrayOid(sql.array([1n, 2n]))).toBe(INT8_ARRAY_OID);
    });
  });

  it('never overrides an explicit OID passed by the caller', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      // A caller who deliberately wants numbers as text[] must still get text[].
      expect(sql.array([1, 2, 3], TEXT_OID).type).toBe(TEXT_OID);
      expect(resolvedArrayOid(sql.array([1, 2, 3], TEXT_OID))).toBe(TEXT_ARRAY_OID);
    });
  });

  it('leaves mixed and empty arrays to postgres-js', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      expect(sql.array([1, 'a']).type).toBe(TEXT_OID);
      expect(sql.array([]).type).toBe(0);
    });
  });

  it('fixes the VARIADIC form without corrupting its arity', () => {
    // postgres-js also accepts array(1, 2, 3). The wrapper must re-type it AND must not let an
    // explicit `undefined` leak into `arguments` as a fourth element.
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      const p = sql.array(1, 2, 3);
      expect(p.value).toEqual([1, 2, 3]);
      expect(resolvedArrayOid(p)).toBe(INT8_ARRAY_OID);

      const s = sql.array('a', 'b');
      expect(s.value).toEqual(['a', 'b']);
      expect(resolvedArrayOid(s)).toBe(TEXT_ARRAY_OID);
    });
  });

  it('is idempotent — installing twice does not nest or change the result', () => {
    withClient((sql) => {
      seedBuiltinArrayTypes(sql);
      installNumericArrayTyping(sql);
      const once = sql.array;
      installNumericArrayTyping(sql);
      expect(sql.array).toBe(once); // the second call is a no-op, not another wrapper
      expect(resolvedArrayOid(sql.array([1, 2]))).toBe(INT8_ARRAY_OID);
    });
  });

  it('degrades quietly if postgres-js internals move', () => {
    // Same contract as seedBuiltinArrayTypes: never throw at client construction.
    expect(() => installNumericArrayTyping({} as any)).not.toThrow();
    expect(() => installNumericArrayTyping(undefined as any)).not.toThrow();
    expect(() => installNumericArrayTyping({ array: 'not-a-function' } as any)).not.toThrow();
  });
});
