/**
 * EI-18698602043482898 recurrence guard: postgres-js's json/jsonb OIDs (114,
 * 3802) have the SAME shared-client mutation problem as the date OIDs
 * (EI-13076, see connection-date-serializers.test.ts), but INVERTED — there
 * is no JS-value form that is correct under BOTH the raw and the
 * drizzle-mutated state:
 *
 *   - `${sql.json(v)}` (explicit param type 3802, real JS value): the
 *     RAW/default serializer (`JSON.stringify`) is correct; drizzle's
 *     transparent-passthrough mutation THROWS (`Buffer.byteLength(Array)`).
 *   - `${JSON.stringify(v)}::jsonb` (untyped param, already-stringified JS
 *     value, resolved to 3802 via the cast at bind time): drizzle's
 *     passthrough mutation is correct; the RAW/default `JSON.stringify`
 *     serializer DOUBLE-encodes it (e.g. `[]` → the jsonb SCALAR `"[]"`,
 *     jsonb_typeof=string instead of array).
 *
 * The fix (`restoreRawJsonbSerializer`, called by `buildClient`) installs a
 * HYBRID serializer (string → passthrough, anything else → JSON.stringify) as
 * STICKY accessor properties, so both call shapes work under both the boot-time
 * `drizzle(client)` wrap AND the runtime `drizzle(tx)` wrap (which share the
 * same options object). These tests pin each layer of that contract without
 * needing a live PG (postgres-js only connects on first query).
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PG_BIGINT_AS_NUMBER_TYPES, restoreRawJsonbSerializer } from './connection';

const FAKE_URL = 'postgres://user:pass@127.0.0.1:1/never-connects';
const JSON_OID = '114';
const JSONB_OID = '3802';

function serializerFor(client: any, oid: string): (x: any) => any {
  return client.options.serializers[oid];
}

describe('restoreRawJsonbSerializer (EI-18698602043482898)', () => {
  it('documents the trap: the default (undrizzled) serializer double-encodes an already-stringified value', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    // Without the fix, postgres-js's default json/jsonb serializer is
    // JSON.stringify — applying it to an already-stringified value
    // double-encodes it into a jsonb scalar string.
    expect(serializerFor(client, JSONB_OID)('[]')).toBe('"[]"');
  });

  it('documents the trap: a plain drizzle() wrap replaces the serializer with a transparent passthrough that throws on a real JS value', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    drizzle(client as any);
    // Without the fix: drizzle's passthrough hands the raw array straight
    // back — fine for postgres-js's own serializer contract, but the caller
    // (sql.json(v)) needed it JSON.stringify'd; downstream this throws
    // inside postgres-js's Bind (`Buffer.byteLength` on a non-string).
    expect(serializerFor(client, JSONB_OID)([])).toEqual([]);
  });

  it('JSON.stringify()s a real JS value (the sql.json(v) shape) after a drizzle() wrap', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    drizzle(client as any);
    restoreRawJsonbSerializer(client as any);
    expect(serializerFor(client, JSONB_OID)([])).toBe('[]');
    expect(serializerFor(client, JSONB_OID)({ a: 1 })).toBe('{"a":1}');
  });

  it('passes an already-stringified value through unchanged (the `${JSON.stringify(v)}::jsonb` shape)', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawJsonbSerializer(client as any);
    expect(serializerFor(client, JSONB_OID)('[]')).toBe('[]');
    expect(serializerFor(client, JSONB_OID)('{"a":1}')).toBe('{"a":1}');
  });

  it('is STICKY: a later drizzle() wrap (e.g. a runtime drizzle(tx)) cannot re-break the serializer', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawJsonbSerializer(client as any); // buildClient order: restore FIRST…
    drizzle(client as any); // …then drizzle tries to overwrite (plain assignment → no-op setter)
    drizzle(client as any); // and again — operator-audit / agent-mcp drizzle(tx) calls do this at runtime
    expect(serializerFor(client, JSONB_OID)([1, 2])).toBe('[1,2]');
    expect(serializerFor(client, JSONB_OID)('[1,2]')).toBe('[1,2]');
  });

  it('covers both the json (114) and jsonb (3802) OIDs drizzle mutates', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawJsonbSerializer(client as any);
    drizzle(client as any);
    for (const oid of [JSON_OID, JSONB_OID]) {
      expect(serializerFor(client, oid)([1]), `OID ${oid}`).toBe('[1]');
      expect(serializerFor(client, oid)('[1]'), `OID ${oid}`).toBe('[1]');
    }
  });

  it('tolerates a client without an options.serializers surface', () => {
    expect(() => restoreRawJsonbSerializer({} as any)).not.toThrow();
    expect(() => restoreRawJsonbSerializer(null as any)).not.toThrow();
  });
});
