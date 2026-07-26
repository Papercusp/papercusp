/**
 * Shared postgres-js client-shape fixes, split out of `connection.ts` into
 * their OWN module with ZERO `drizzle-orm` import so they can be safely
 * imported by test fixtures that must avoid drizzle's schema-extraction
 * (see `packages/operator-core/test/_org-test-db.ts`'s docstring: importing
 * anything from `connection.ts` pulls in `drizzle-orm/postgres-js`, which
 * throws under some vitest configs during schema extraction). Importing
 * THIS module only touches `postgres`'s types — never `drizzle-orm`.
 *
 * `connection.ts`'s `buildClient` applies both fixes to every canonical
 * connection; any hand-rolled `postgres(url, {...})` client that is meant to
 * BEHAVE LIKE the canonical `getOrgPg()`/`getHarnessPg()` clients (test
 * fixtures, conformance suites, one-off scripts) should apply them too, or it
 * silently drifts from production serialization behavior.
 */
import type { Sql } from 'postgres';

/**
 * EI-9265: postgres-js parses int8/bigserial columns (OID 20) as JS STRINGS
 * by default (precision-safety — a bigint can exceed Number's 2^53 range).
 * Every hand-rolled `postgres(url, {...})` client that is meant to BEHAVE
 * LIKE the canonical `getOrgPg()`/`getHarnessPg()` clients (test fixtures,
 * conformance suites, one-off scripts) MUST spread this in, or a raw-SQL read
 * of a bigserial PK (e.g. `harness_shared.coord_event_log.id`) silently comes
 * back as a string — a `typeof x === 'number'` guard downstream then treats
 * it as absent with NO thrown error (the WI-3880 coord:feed cursor bug: page
 * 2 of a cursor-paginated read silently returned page 1's rows again).
 */
export const PG_BIGINT_AS_NUMBER_TYPES = {
  bigint: {
    to: 20,
    from: [20],
    serialize: (x: any) => String(x),
    parse: (x: string) => Number(x),
  } as any,
};

/**
 * EI-13076: drizzle-orm's postgres-js driver MUTATES the client it wraps —
 * `drizzle(client)` overwrites `client.options.serializers[<date OIDs>]` with a
 * transparent passthrough (`(val) => val`) so its OWN pre-stringified params
 * survive unmangled. But our canonical clients are SHARED between drizzle and
 * raw `sql\`...\`` tagged-template callers, and a raw caller passing a JS `Date`
 * param then hits `Buffer.byteLength(Date)` inside postgres-js:
 *
 *   TypeError: The "string" argument must be of type string or an instance of
 *   Buffer or ArrayBuffer. Received an instance of Date
 *
 * Every such query THROWS — and a `.catch(() => fallback)` around it silently
 * feeds zeros forever (the pot-throughput tick recorded placements=0 on all
 * 22k+ ticks in table history this way). This restores a HYBRID serializer on
 * the date/time OIDs: a `Date` serializes to ISO (what postgres-js does by
 * default), anything else (drizzle's pre-stringified values) passes through
 * unchanged — so BOTH consumers of the shared client work.
 *
 * STICKY on purpose: the OIDs are installed as accessor properties whose
 * setter is a no-op, because `drizzle(tx)` is also called at RUNTIME on
 * transaction handles (operator-audit, agent-mcp tools, …) which share the
 * parent client's `options.serializers` object — a plain assignment there
 * would silently re-break every raw Date param in the process. Parsers are
 * left as drizzle sets them (raw reads return strings; callers already
 * tolerate `string | Date`).
 *
 * Called by `buildClient` on every canonical connection. A hand-rolled
 * `postgres(url, …)` client that gets drizzle-wrapped must call this too, or
 * it drifts back into the trap (same class as EI-9265's bigint note above).
 */
const DRIZZLE_MUTATED_DATE_OIDS = ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231'] as const;
export function restoreRawDateSerializers(client: Sql): void {
  const serializers = (client as any)?.options?.serializers as Record<string, (x: any) => any> | undefined;
  if (!serializers) return;
  const hybrid = (x: any) => (x instanceof Date ? x.toISOString() : x);
  for (const oid of DRIZZLE_MUTATED_DATE_OIDS) {
    Object.defineProperty(serializers, oid, {
      configurable: true,
      enumerable: true,
      get: () => hybrid,
      // Swallow drizzle's transparent re-assignment (driver.js does
      // `serializers[oid] = transparentParser` on every drizzle() call).
      set: () => {},
    });
  }
}

/**
 * EI-18698602043482898: postgres-js's json/jsonb OIDs (114, 3802) have the
 * SAME shared-client mutation problem as the date OIDs above, but INVERTED —
 * and because BOTH the "raw" and the "drizzle-mutated" state are wrong for
 * one of the two common call shapes, there is no JS-value form that is
 * correct under both:
 *
 *   - `${sql.json(v)}` explicitly types the param 3802 up front. postgres-js's
 *     DEFAULT serializer for 114/3802 is `JSON.stringify` (types.js), which is
 *     correct here — `v` is the real JS value and needs encoding once.
 *   - `${JSON.stringify(v)}::jsonb` (or any raw `${…}::jsonb` with a
 *     pre-stringified JS value) infers the param as untyped (OID 0); postgres-js
 *     defers serialization until the server's ParameterDescription response
 *     resolves the OID to 3802 via the cast, THEN serializes the ORIGINAL
 *     (already-stringified) value through `options.serializers['3802']`. The
 *     default `JSON.stringify` serializer here DOUBLE-encodes it — e.g. an
 *     empty array `[]` becomes the jsonb SCALAR `"[]"` (jsonb_typeof=string)
 *     instead of the array `[]` — a defect that is invisible on read unless
 *     something asserts the stored type (see seed.ts's `::text::jsonb`
 *     workaround + jsonb_array_length note).
 *
 *   drizzle-orm's postgres-js driver (driver.js) mutates serializers['114']
 *   and ['3802'] to a transparent passthrough (to keep ITS OWN
 *   pre-stringified params from being re-encoded) — which happens to fix the
 *   second bullet above but BREAKS the first: `sql.json(v)` with a real JS
 *   array/object now hits `Buffer.byteLength(Array)` inside postgres-js and
 *   throws. So today, which form is "correct" depends entirely on whether the
 *   shared client happened to get drizzle-wrapped — neither client is right
 *   for both callers.
 *
 * This installs a HYBRID serializer (mirroring `restoreRawDateSerializers`):
 * a string passes through unchanged (the pre-stringified-value case), anything
 * else is JSON.stringify'd (the raw-JS-value / `sql.json` case) — correct for
 * BOTH call shapes, on any client, whether or not it is later drizzle-wrapped.
 * STICKY for the same reason as the date OIDs: `drizzle(tx)` is called at
 * RUNTIME on transaction handles sharing the parent's `options.serializers`
 * object, so a plain assignment would silently re-break the very next
 * `drizzle(tx)` call.
 *
 * Called by `buildClient` on every canonical connection. A hand-rolled
 * `postgres(url, …)` client meant to behave like the canonical clients
 * (test fixtures, conformance suites, one-off scripts) must call this too.
 */
const DRIZZLE_MUTATED_JSON_OIDS = ['114', '3802'] as const;
export function restoreRawJsonbSerializer(client: Sql): void {
  const serializers = (client as any)?.options?.serializers as Record<string, (x: any) => any> | undefined;
  if (!serializers) return;
  const hybrid = (x: any) => (typeof x === 'string' ? x : JSON.stringify(x));
  for (const oid of DRIZZLE_MUTATED_JSON_OIDS) {
    Object.defineProperty(serializers, oid, {
      configurable: true,
      enumerable: true,
      get: () => hybrid,
      // Swallow drizzle's transparent re-assignment (driver.js does
      // `serializers["114"] = serializers["3802"] = transparentParser` on
      // every drizzle() call).
      set: () => {},
    });
  }
}
