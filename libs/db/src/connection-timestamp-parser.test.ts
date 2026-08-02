/**
 * EI-19331550321709126 recurrence guard: postgres-js's default PARSER for
 * OID 1114 (`timestamp WITHOUT time zone`) is `x => new Date(x)`, which V8
 * interprets a timezone-less date-TIME string as SERVER-LOCAL, not UTC. On a
 * server running e.g. America/New_York, a bare `timestamp` value read via a
 * `... AT TIME ZONE 'UTC'` cast (the idiom agents reach for specifically to
 * "get UTC" — see dev:pg_query's guidance) was silently shifted by the
 * server's UTC offset before it ever reached JS — invisibly, because the
 * resulting `Date` still serializes with a trailing "Z" that looks
 * authoritative (measured live: a true 07:15:29Z value rendered as
 * 11:15:29Z).
 *
 * `PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES` (merged into every canonical client by
 * `buildClient`) fixes this by forcing OID 1114 to parse as UTC regardless
 * of process/server TZ. These tests pin that contract without needing a
 * live PG (postgres-js only connects on first query — same technique as
 * connection-date-serializers.test.ts).
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
} from './connection';

const FAKE_URL = 'postgres://user:pass@127.0.0.1:1/never-connects';
const TIMESTAMP_NO_TZ_OID = '1114';
const TIMESTAMPTZ_OID = '1184';
const DATE_OID = '1082';

function parserFor(client: any, oid: string): (x: string) => any {
  return client.options.parsers[oid];
}

describe('PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES (EI-19331550321709126)', () => {
  it('documents the trap: the postgres-js DEFAULT OID-1114 parser is TZ-sensitive', () => {
    const client = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      // A bare (no-offset) timestamp string, as `AT TIME ZONE 'UTC'` returns it.
      const parsed = parserFor(client, TIMESTAMP_NO_TZ_OID)('2026-08-02 07:15:29.372');
      // Broken default: interpreted as -04:00 local, so the UTC instant is
      // shifted 4h forward — this is the corruption the fix removes.
      expect(parsed.toISOString()).toBe('2026-08-02T11:15:29.372Z');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('forces OID 1114 to parse as UTC, independent of process TZ', () => {
    const client = postgres(FAKE_URL, {
      max: 1,
      types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
    });
    const originalTz = process.env.TZ;
    try {
      for (const tz of ['America/New_York', 'UTC', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        const parsed = parserFor(client, TIMESTAMP_NO_TZ_OID)('2026-08-02 07:15:29.372');
        expect(parsed.toISOString(), `TZ=${tz}`).toBe('2026-08-02T07:15:29.372Z');
      }
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('does not double-append Z if the wire value somehow already carries an offset', () => {
    const client = postgres(FAKE_URL, {
      max: 1,
      types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
    });
    const parse = parserFor(client, TIMESTAMP_NO_TZ_OID);
    expect(parse('2026-08-02T07:15:29.372Z').toISOString()).toBe('2026-08-02T07:15:29.372Z');
    expect(parse('2026-08-02 07:15:29.372+00').toISOString()).toBe('2026-08-02T07:15:29.372Z');
  });

  it('leaves OID 1184 (timestamptz) and 1082 (date) parsing untouched', () => {
    const withoutFix = postgres(FAKE_URL, { max: 1, types: PG_BIGINT_AS_NUMBER_TYPES });
    const withFix = postgres(FAKE_URL, {
      max: 1,
      types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
    });
    // timestamptz already carries its own offset — same parser, same result.
    const tzInput = '2026-08-02 07:15:29.372+00';
    expect(parserFor(withFix, TIMESTAMPTZ_OID)(tzInput).toISOString()).toBe(
      parserFor(withoutFix, TIMESTAMPTZ_OID)(tzInput).toISOString(),
    );
    // date-only is already UTC per the ECMA-262 date-only grammar — same parser.
    const dateInput = '2026-08-02';
    expect(parserFor(withFix, DATE_OID)(dateInput).toISOString()).toBe(
      parserFor(withoutFix, DATE_OID)(dateInput).toISOString(),
    );
  });
});
