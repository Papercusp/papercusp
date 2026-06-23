/**
 * EI-2582: a unit test that touches PG without a mock must FAIL FAST, not hang.
 *
 * Before this fix, adding a new PG-touching step to a flow like `harness:create`
 * without a matching per-test `vi.doMock` made the real `getOrgPg()` connect call
 * hang for ~60s (the vitest timeout) in a no-DB unit run — reading as a "slow
 * test" rather than the real cause (a missing mock). `buildClient` now passes a
 * bounded `connect_timeout` under VITEST so the unmocked call rejects in ~5s with
 * a clear connection error.
 *
 * Source-level contract (same approach as connection-cache.test.ts): the
 * connect-timeout wiring is asserted against the source, since exercising a real
 * connect-timeout would require an unreachable host (flaky/environment-dependent).
 * The live behavior is covered by the connection integration tests.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('connection: bounded connect_timeout under test (EI-2582)', () => {
  const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'connection.ts'),
    'utf8',
  );

  it('buildClient computes a short connect_timeout when running under VITEST', () => {
    const m = SRC.match(/function buildClient\([^)]*\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'buildClient() must exist').toBeTruthy();
    const body = m![1];
    // A short default under VITEST, env-overridable, off otherwise.
    expect(
      body,
      'buildClient must derive connectTimeoutSec from PAPERCUSP_DB_CONNECT_TIMEOUT and default short under VITEST',
    ).toMatch(/connectTimeoutSec\s*=[\s\S]*PAPERCUSP_DB_CONNECT_TIMEOUT[\s\S]*VITEST/);
  });

  it('buildClient passes connect_timeout to postgres() only when bounded (>0)', () => {
    const m = SRC.match(/function buildClient\([^)]*\)[^{]*\{([\s\S]+?)^\}/m);
    const body = m![1];
    // Spread the option in only when > 0 so prod (unset) keeps postgres-js's
    // default — preserving the embedded-pg boot-race tolerance.
    expect(body).toMatch(/connectTimeoutSec\s*>\s*0\s*\?\s*\{\s*connect_timeout:\s*connectTimeoutSec\s*\}/);
  });

  it('does NOT bound connect_timeout outside tests (boot-race tolerance preserved)', () => {
    const m = SRC.match(/function buildClient\([^)]*\)[^{]*\{([\s\S]+?)^\}/m);
    const body = m![1];
    // The non-VITEST fallback must be 0 (disabled), not a positive number.
    expect(
      body,
      'outside VITEST the connect-timeout default must be 0 (disabled) so a worker can wait for embedded PG to come up',
    ).toMatch(/VITEST\s*\?\s*5\s*:\s*0/);
  });
});
