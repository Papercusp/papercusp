/**
 * EI-19462929205805752 — the BEHAVIORAL half of the per-harness pool rebind guard.
 * The static scan in `connection-pool-rebind.test.ts` proves the guard is WIRED IN;
 * only this proves it WORKS.
 *
 * THE HOLE THIS PINS: `getHarnessPg` builds its pools with `appUrl()`, but
 * `_harnessClients` was evicted ONLY by LRU pressure and `_resetForTests`. Nothing
 * evicted it when that URL moved, so a discovery rebind left every per-harness pool
 * bound to the dead endpoint until the process exited — the same shape as
 * EI-19285027465993737, on the one pool family the static scan had allowlisted away.
 *
 * WHY THIS FILE IS `.integration.` AND NOT A UNIT TEST: building a pool goes through
 * `buildClient`, and `assertRealPgAllowed` refuses that under `PAPERCUSP_FORBID_REAL_PG=1`
 * (the unit-suite rail from EI-19311807188719573). The rail names this exact escape —
 * "rename the file *.integration.test.ts" — so the guard is honoured rather than
 * disabled. NOTE it still needs NO database: postgres-js is lazy, these tests only
 * compare handle IDENTITY, and no query is ever issued.
 *
 * WHY THE ENDPOINTS ARE REAL LISTENING SOCKETS: `_defaultIsPortServed` reads
 * /proc/net/tcp, so a made-up port makes `readDiscoveryFile` return null and BOTH
 * cases collapse onto the same native-fallback URL — the rebind assertion would then
 * pass for the wrong reason, which is the failure mode this whole class came from.
 * So the fixture opens genuine ephemeral sockets it owns on 127.0.0.1.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, appUrl, getHarnessPg } from './connection';

// This fixture exercises the discovery rung. The operator's on-disk URL pin
// precedes discovery even after process.env is cleared, so isolate that one
// provider while retaining the real URL resolver, socket check and pool cache.
vi.mock('./operator-db-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./operator-db-env')>()),
  readOperatorDbEnvLocal: () => ({}),
}));

// The rebind deliberately warns — this incident class was invisible for 14 minutes.
// The repo runs vitest-fail-on-console, so it is captured rather than removed, and
// the first test asserts it actually fires.
let warn: ReturnType<typeof vi.spyOn>;

const ENV_KEYS = [
  'PAPERCUSP_HOME',
  'PAPERCUSP_SKIP_PG_DISCOVERY',
  'HARNESS_DATABASE_URL',
  'HARNESS_ADMIN_DATABASE_URL',
  'DATABASE_URL',
] as const;

let saved: Record<string, string | undefined>;
let home: string;

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Every env rung must be cleared or `appUrl()` short-circuits before discovery and
  // the test passes without exercising anything.
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), 'pc-pool-rebind-'));
  process.env.PAPERCUSP_HOME = home;
  // `_resetForTests` also calls `_resetUrlCacheForTests`, which nulls `_resolvedAppUrl`
  // — that is what makes a previously env-cached URL unable to leak into this test.
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  warn.mockRestore();
});

const writeDiscovery = (port: number) =>
  writeFileSync(
    join(home, 'embedded-pg.json'),
    JSON.stringify({ host: '127.0.0.1', port, user: 'harness_admin', password: 'pw' }),
  );

/** A genuinely listening ephemeral socket, so `_defaultIsPortServed` accepts the endpoint. */
const listen = async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
};

describe('per-harness pools rebind when the app URL moves (EI-19462929205805752)', () => {
  it('evicts a cached harness pool once discovery moves to a different endpoint', async () => {
    const a = await listen();
    const b = await listen();
    try {
      writeDiscovery(a.port);
      expect(new URL(appUrl()).port).toBe(String(a.port));
      const first = getHarnessPg('acme');
      // Assert the steady state FIRST: without this, the `not.toBe` below would also
      // pass if the getter simply never cached, which is not what we are proving.
      expect(getHarnessPg('acme')).toBe(first);

      writeDiscovery(b.port);
      // A cache MISS is what calls `appUrl()` — the point at which the move is seen.
      getHarnessPg('other');

      expect(getHarnessPg('acme')).not.toBe(first);
      expect(warn).toHaveBeenCalled();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('does NOT churn harness pools while the endpoint is unchanged', async () => {
    const a = await listen();
    try {
      writeDiscovery(a.port);
      expect(new URL(appUrl()).port).toBe(String(a.port));
      const first = getHarnessPg('acme');
      getHarnessPg('other'); // re-resolves appUrl(); same endpoint => no eviction
      expect(getHarnessPg('acme')).toBe(first);
    } finally {
      await a.close();
    }
  });
});
