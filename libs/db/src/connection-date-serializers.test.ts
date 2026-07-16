/**
 * EI-13076 recurrence guard: drizzle-orm's postgres-js driver MUTATES the
 * client it wraps — `drizzle(client)` overwrites the shared
 * `client.options.serializers` date-OID entries with a transparent
 * passthrough, after which a raw `sql` tagged-template query with a JS `Date`
 * parameter throws `Buffer.byteLength(Date)` deep in postgres-js. Because the
 * pot-throughput tick swallowed that error (`.catch(() => [])`), EVERY
 * throughput tick in table history recorded placements/completed/mttc/stuck
 * as 0/null with no signal anywhere.
 *
 * The fix (`restoreRawDateSerializers`, called by `buildClient`) installs
 * HYBRID serializers (Date → ISO, non-Date passthrough) as STICKY accessor
 * properties, so both the boot-time `drizzle(client)` wraps AND the runtime
 * `drizzle(tx)` wraps (which share the same options object) cannot re-break
 * raw Date params. These tests pin each layer of that contract without
 * needing a live PG (postgres-js only connects on first query).
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PG_BIGINT_AS_NUMBER_TYPES, restoreRawDateSerializers } from './connection';

const FAKE_URL = 'postgres://user:pass@127.0.0.1:1/never-connects';
const TIMESTAMPTZ_OID = '1184';
const DATE = new Date('2026-07-16T22:00:00.000Z');

function serializerFor(client: any, oid: string): (x: any) => any {
  return client.options.serializers[oid];
}

describe('restoreRawDateSerializers (EI-13076)', () => {
  it('documents the trap: a plain drizzle() wrap replaces the date serializer with a transparent passthrough', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    drizzle(client as any);
    // Without the fix, the serializer hands the raw Date straight to
    // postgres-js's Buffer.byteLength — this is the broken state.
    expect(serializerFor(client, TIMESTAMPTZ_OID)(DATE)).toBe(DATE);
  });

  it('restores Date → ISO serialization after a drizzle() wrap', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    drizzle(client as any);
    restoreRawDateSerializers(client as any);
    expect(serializerFor(client, TIMESTAMPTZ_OID)(DATE)).toBe(DATE.toISOString());
  });

  it('passes non-Date values through unchanged (drizzle pre-stringified params keep working)', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawDateSerializers(client as any);
    expect(serializerFor(client, TIMESTAMPTZ_OID)('2026-07-16 18:00:00+00')).toBe('2026-07-16 18:00:00+00');
  });

  it('is STICKY: a later drizzle() wrap (e.g. a runtime drizzle(tx)) cannot re-break the serializer', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawDateSerializers(client as any); // buildClient order: restore FIRST…
    drizzle(client as any); // …then drizzle tries to overwrite (plain assignment → no-op setter)
    drizzle(client as any); // and again — operator-audit / agent-mcp drizzle(tx) calls do this at runtime
    expect(serializerFor(client, TIMESTAMPTZ_OID)(DATE)).toBe(DATE.toISOString());
  });

  it('covers every date/time OID drizzle mutates', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    restoreRawDateSerializers(client as any);
    drizzle(client as any);
    for (const oid of ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231']) {
      expect(serializerFor(client, oid)(DATE), `OID ${oid}`).toBe(DATE.toISOString());
    }
  });

  it('tolerates a client without an options.serializers surface', () => {
    expect(() => restoreRawDateSerializers({} as any)).not.toThrow();
    expect(() => restoreRawDateSerializers(null as any)).not.toThrow();
  });
});
