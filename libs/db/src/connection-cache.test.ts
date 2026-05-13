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
 * connection-phase1.test.ts when run against a live embedded PG.
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
});
