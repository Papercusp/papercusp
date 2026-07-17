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
  it("getOrgPg() validates the target ONLY when the admin URL source is 'discovery'", () => {
    const m = SRC.match(/export function getOrgPg\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m).toBeTruthy();
    const body = m![1];
    expect(body, 'getOrgPg() must call validateDiscoveryTargetOnce for a discovery-sourced pool (WI-5244)').toMatch(
      /_resolvedAdminUrlSource === 'discovery'\)\s*validateDiscoveryTargetOnce\(_adminClient/,
    );
  });

  it("getOrgPgApp() validates the target ONLY when the app URL source is 'discovery'", () => {
    const m = SRC.match(/export function getOrgPgApp\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m).toBeTruthy();
    const body = m![1];
    expect(body, 'getOrgPgApp() must call validateDiscoveryTargetOnce for a discovery-sourced pool (WI-5244)').toMatch(
      /_resolvedAppUrlSource === 'discovery'\)\s*validateDiscoveryTargetOnce\(_appOrgClient/,
    );
  });

  it('validateDiscoveryTargetOnce is fail-soft (never throws/blocks on a query error)', () => {
    const fn = SRC.match(/function validateDiscoveryTargetOnce\([^{]*\{([\s\S]+?)^\}/m);
    expect(fn, 'validateDiscoveryTargetOnce must exist').toBeTruthy();
    const body = fn![1];
    expect(body, 'must be fire-and-forget (void the promise, never await/return it)').toMatch(/^\s*void sql/m);
    expect(body, 'must swallow a validation-query error rather than propagate it').toMatch(/\.catch\(/);
  });
});
