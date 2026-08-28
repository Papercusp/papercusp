/**
 * Cache-invalidation regression tests for the connection module.
 *
 * E2E round-13 bug #33: getOrgPg() only called adminUrl() on first
 * client-build, so adminUrl()'s discovery-file URL-change detection
 * never fired after boot. Workers that called getOrgPg() repeatedly
 * still got the stale cached client (pointing at the old PG port).
 *
 * The fix moves the adminUrl() call out of the if-null branch so
 * every getOrgPg() invocation re-resolves the URL. When discovery
 * URL changes, adminUrl() invalidates the cached client; the next
 * getOrgPg() rebuilds with the fresh URL.
 *
 * This test verifies the source-level contract — getOrgPg() and
 * getOrgPgApp() unconditionally call their respective Url() helper.
 * The rebuild-on-change behavior is covered end-to-end by
 * connection-phase1.integration.test.ts when run against a live embedded PG.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('connection cache invalidation source contract (bug #33)', () => {
  const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'connection.ts'),
    'utf8',
  );

  it('getOrgPg() calls adminUrl() unconditionally (not just on first build)', () => {
    // Find the getOrgPg function body.
    const m = SRC.match(/export function getOrgPg\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'getOrgPg() must be exported as a function').toBeTruthy();
    const body = m![1];
    // Require an adminUrl() call OUTSIDE the if-null guard.
    // We assert this by looking for `adminUrl()` BEFORE the
    // `if (!_adminClient)` line.
    const beforeIf = body.split(/if\s*\(\s*!_adminClient\s*\)/)[0];
    expect(beforeIf, 'getOrgPg() must invoke adminUrl() unconditionally so its discovery-URL-change detection fires (bug #33)').toMatch(/adminUrl\(\)/);
  });

  it('getOrgPgApp() calls appUrl() unconditionally (not just on first build)', () => {
    const m = SRC.match(/export function getOrgPgApp\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m).toBeTruthy();
    const body = m![1];
    const beforeIf = body.split(/if\s*\(\s*!_appOrgClient\s*\)/)[0];
    expect(beforeIf, 'getOrgPgApp() must invoke appUrl() unconditionally so its discovery-URL-change detection fires (bug #33)').toMatch(/appUrl\(\)/);
  });

  it('appUrl() invalidates _appOrgClient when discovery URL changes', () => {
    // The fix added a sibling invalidation block to appUrl() that
    // mirrors adminUrl()'s. Lock the contract.
    const fn = SRC.match(/function appUrl\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(fn).toBeTruthy();
    const body = fn![1];
    expect(body, 'appUrl() must clear _appOrgClient when discovery URL changes (bug #33 — sibling of adminUrl invalidation)').toMatch(/_appOrgClient\s*=\s*null/);
    expect(body, 'appUrl() must clear _appOrgDrizzle when discovery URL changes').toMatch(/_appOrgDrizzle\s*=\s*null/);
  });

  it('adminUrl() invalidates _adminClient when discovery URL changes (pre-existing, locked here)', () => {
    const fn = SRC.match(/function adminUrl\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(fn).toBeTruthy();
    const body = fn![1];
    expect(body).toMatch(/_adminClient\s*=\s*null/);
    expect(body).toMatch(/_adminDrizzle\s*=\s*null/);
  });

  // WI-5244(2): a discovery-file target is spoofable by any local install; a
  // newly-built pool sourced from discovery gets a cheap, fire-and-forget
  // validation query so an impostor/mismatched DB is flagged loudly instead of
  // silently read as empty (the 2026-07-17 08:29Z incident's ~40-min-to-detect
  // gap). Env-pinned managed hosts are trusted and skip the check.
  // The WI-5244 SCHEMA check stays discovery-only (env-pinned managed hosts are trusted and
  // the check is not free), but the STORE-IDENTITY probe added by
  // outage-must-not-be-silent-2026-08-02 must run for EVERY pool: the pin has to be
  // established from the trusted env/native path at boot, or the first impostor observed
  // would become the pin and legitimise itself. So the discovery condition moved from the
  // call site into the `checkSchema` argument. Both halves are asserted here.
  it("getOrgPg() gates the SCHEMA check on 'discovery' but probes identity unconditionally", () => {
    const m = SRC.match(/export function getOrgPg\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m).toBeTruthy();
    const body = m![1];
    expect(body, 'getOrgPg() must call validateDiscoveryTargetOnce for every pool').toMatch(
      /validateDiscoveryTargetOnce\(_adminClient/,
    );
    expect(body, 'the WI-5244 schema check must remain scoped to discovery-sourced pools').toMatch(
      /checkSchema:\s*_resolvedAdminUrlSource === 'discovery'/,
    );
    expect(body, 'the call must NOT be re-gated on the source — that would skip the identity pin').not.toMatch(
      /if\s*\(_resolvedAdminUrlSource === 'discovery'\)\s*validateDiscoveryTargetOnce/,
    );
  });

  it("getOrgPgApp() gates the SCHEMA check on 'discovery' but probes identity unconditionally", () => {
    const m = SRC.match(/export function getOrgPgApp\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m).toBeTruthy();
    const body = m![1];
    expect(body, 'getOrgPgApp() must call validateDiscoveryTargetOnce for every pool').toMatch(
      /validateDiscoveryTargetOnce\(_appOrgClient/,
    );
    expect(body, 'the WI-5244 schema check must remain scoped to discovery-sourced pools').toMatch(
      /checkSchema:\s*_resolvedAppUrlSource === 'discovery'/,
    );
    expect(body, 'the call must NOT be re-gated on the source — that would skip the identity pin').not.toMatch(
      /if\s*\(_resolvedAppUrlSource === 'discovery'\)\s*validateDiscoveryTargetOnce/,
    );
  });

  // The identity probe must stay INSIDE the same fail-soft, fire-and-forget wrapper as the
  // WI-5244 check: a mismatch is loud, but an unreadable probe must never affect the pool.
  it('validateDiscoveryTargetOnce probes store identity and reports a mismatch loudly', () => {
    const fn = SRC.match(/function validateDiscoveryTargetOnce\([^{]*\{([\s\S]+?)^\}/m);
    expect(fn).toBeTruthy();
    const body = fn![1];
    expect(body, 'must fingerprint the cluster, not just the schema shape').toMatch(
      /system_identifier/,
    );
    expect(body, 'must carry current_database() — one cluster hosts several databases').toMatch(
      /current_database\(\)/,
    );
    expect(body, 'must route the probe through the pin/verify state machine').toMatch(
      /pinOrVerifyStoreIdentity\(/,
    );
    expect(body, 'a positive mismatch must be reported, not swallowed').toMatch(
      /kind === 'mismatch'/,
    );
  });

  it('validateDiscoveryTargetOnce is fail-soft (never throws/blocks on a query error)', () => {
    const fn = SRC.match(/function validateDiscoveryTargetOnce\([^{]*\{([\s\S]+?)^\}/m);
    expect(fn, 'validateDiscoveryTargetOnce must exist').toBeTruthy();
    const body = fn![1];
    expect(body, 'must be fire-and-forget (void the promise, never await/return it)').toMatch(/^\s*void sql/m);
    expect(body, 'must swallow a validation-query error rather than propagate it').toMatch(/\.catch\(/);
  });

  it('test pool resets fence already-issued identity probes from the retired generation', () => {
    const validate = SRC.match(/function validateDiscoveryTargetOnce\([^{]*\{([\s\S]+?)^\}/m);
    expect(validate, 'validateDiscoveryTargetOnce must exist').toBeTruthy();
    expect(
      validate![1],
      'a detached identity probe must capture the generation of the pool that issued it',
    ).toMatch(/const probeGeneration\s*=\s*_identityProbeTestGeneration/);
    expect(
      validate![1],
      'a probe resolving after a test reset must not pin or reject the replacement cluster',
    ).toMatch(/probeGeneration\s*!==\s*_identityProbeTestGeneration\) return/);

    const reset = SRC.match(/export async function _resetForTests\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(reset, '_resetForTests must exist').toBeTruthy();
    expect(
      reset![1],
      'the test reset must invalidate callbacks before it retires their pools',
    ).toMatch(/_identityProbeTestGeneration\s*\+=\s*1[\s\S]*?_resetUrlCacheForTests\(\)/);
  });

  // EI-18789855771421275: getOrgPgLosslessBigint() is a SEPARATE cached pool
  // sharing adminUrl()'s discovery-file resolution — if adminUrl()'s
  // invalidation block doesn't ALSO clear it, a discovery-file URL change
  // (desktop restart / port shuffle) leaves it silently pointed at the stale
  // target forever (the exact bug #33 class, for the new pool).
  it("adminUrl()'s discovery-URL-change invalidation ALSO clears _adminLosslessBigintClient", () => {
    const fn = SRC.match(/function adminUrl\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(fn).toBeTruthy();
    const body = fn![1];
    expect(
      body,
      'adminUrl() must clear _adminLosslessBigintClient when discovery URL changes (EI-18789855771421275)',
    ).toMatch(/_adminLosslessBigintClient\s*=\s*null/);
  });

  it('getOrgPgLosslessBigint() builds its client with an empty types override (no bigint→number rounding)', () => {
    const m = SRC.match(/export function getOrgPgLosslessBigint\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'getOrgPgLosslessBigint() must be exported as a function').toBeTruthy();
    const body = m![1];
    expect(body, 'must call buildClient() rather than roll its own postgres(...) client').toMatch(/buildClient\(/);
    expect(
      body,
      'must NOT pass PG_BIGINT_AS_NUMBER_TYPES — the whole point is an unrounded bigint',
    ).not.toMatch(/PG_BIGINT_AS_NUMBER_TYPES/);
  });

  it('getOrgPgListener() stays on the direct admin URL with an idle-safe dedicated client', () => {
    const m = SRC.match(/export function getOrgPgListener\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'getOrgPgListener() must be exported as a function').toBeTruthy();
    const body = m![1];
    expect(body, 'LISTEN client must resolve adminUrl()').toMatch(/adminUrl\(\)/);
    expect(body, 'LISTEN client must not route through the transaction pooler').not.toMatch(/maybePgbouncer/);
    expect(body, 'LISTEN client must use the shared long-lived connection options').toMatch(
      /longLivedPoolConnectionOptions\(['"]org-admin-listener['"]\)/,
    );
    expect(body, 'LISTEN client must never idle-timeout its subscription').toMatch(/idle_timeout:\s*0/);
    expect(body, 'LISTEN client must be capped at one direct backend').toMatch(/max:\s*1/);
  });

  it("processConnectionCeiling()'s fixedOverhead accounts for the lossless-bigint pool", () => {
    expect(
      SRC,
      'fixedOverhead must include the org-admin-lossless-bigint pool so the connection-budget guard stays honest (EI-18789855771421275)',
    ).toMatch(/const fixedOverhead\s*=\s*8[\s\S]*?\+[\s\S]*?2\s*\/\*\s*org-admin-lossless-bigint/);
  });
});
