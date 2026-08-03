/**
 * Pins the embedded-pg discovery-file contract between its WRITER and its READER.
 *
 * The bug this locks down: apps/operator/bin/serve.ts writes
 * `{ url, port, pid, startedAt }`, but connection.ts's reader gated on
 * `parsed.host && parsed.port` — a key the writer has never emitted. Step 2 of the
 * documented resolution chain (discovery file) was therefore dead code, and every
 * env-less caller fell through to the native :5432 fallback. That silently selects the
 * WRONG DATABASE on a dev box running the desktop, and is a hard ECONNREFUSED on a
 * packaged install (no :5432 exists there) — which is how it surfaced: ~200 "unit"
 * suites reddened on a packaged Linux install while passing anywhere a stray native
 * :5432 happened to be listening.
 *
 * `_parseDiscoveryJson` is pure (no fs, no env) once both probes are injected, so these
 * assert the shape contract directly rather than through a live pool. The
 * writer/reader-contract and stale-pid-guard tests below all pass an explicit
 * `served` stub for the (new, EI-19384906720464601) port-listening probe so they stay
 * decoupled from whatever ports genuinely happen to be listening on the test box —
 * the port gate itself is exercised separately, against the real `_defaultIsPortServed`,
 * in the last describe block.
 */
import { describe, it, expect } from 'vitest';
import { _parseDiscoveryJson, _defaultIsPidAlive, _defaultIsPortServed } from './connection';

// The EXACT payload apps/operator/bin/serve.ts writes (serve.ts: writeJsonAtomic).
const REAL_WRITER_PAYLOAD = JSON.stringify({
  url: 'postgresql://harness_admin:harness_admin_pwd@localhost:19790/papercusp',
  port: 19790,
  pid: 767318,
  startedAt: 1783659942209,
});

const alive = () => true;
const dead = () => false;
const served = () => true;
const notServed = () => false;

describe('_parseDiscoveryJson — writer/reader contract', () => {
  it('resolves the real writer payload (which carries `url`, never `host`)', () => {
    const got = _parseDiscoveryJson(REAL_WRITER_PAYLOAD, alive, served);
    expect(got, 'the shape serve.ts actually writes must resolve, not fall through').not.toBeNull();
    expect(got).toMatchObject({
      host: 'localhost',
      port: 19790,
      user: 'harness_admin',
      password: 'harness_admin_pwd',
    });
  });

  it('the regression itself: a payload with no `host` key still resolves', () => {
    const raw = JSON.parse(REAL_WRITER_PAYLOAD) as Record<string, unknown>;
    expect(raw.host, 'writer must not have grown a host key (else this test is moot)').toBeUndefined();
    expect(_parseDiscoveryJson(JSON.stringify(raw), alive, served)).not.toBeNull();
  });

  it('still honors the legacy {host, port} shape (older desktops on disk)', () => {
    const got = _parseDiscoveryJson(JSON.stringify({ host: '127.0.0.1', port: 5544 }), alive, served);
    expect(got).toMatchObject({ host: '127.0.0.1', port: 5544 });
  });

  it('prefers the url when both url and a stale legacy host/port are present', () => {
    const got = _parseDiscoveryJson(
      JSON.stringify({ url: 'postgresql://u:p@db.local:6000/papercusp', host: 'stale', port: 1111 }),
      alive,
      served,
    );
    expect(got).toMatchObject({ host: 'db.local', port: 6000 });
  });

  it('falls through (null) on unparseable json — caller uses the native fallback', () => {
    expect(_parseDiscoveryJson('{ not json', alive, served)).toBeNull();
  });

  it('falls through (null) on an unparseable url with no legacy shape to fall back to', () => {
    expect(_parseDiscoveryJson(JSON.stringify({ url: 'not-a-url' }), alive, served)).toBeNull();
  });

  it('falls through (null) when the url carries no port and no diagnostic port', () => {
    expect(_parseDiscoveryJson(JSON.stringify({ url: 'postgresql://u:p@h/papercusp' }), alive, served)).toBeNull();
  });

  it('uses the diagnostic `port` when the url omits one', () => {
    const got = _parseDiscoveryJson(
      JSON.stringify({ url: 'postgresql://u:p@h/papercusp', port: 7777 }),
      alive,
      served,
    );
    expect(got).toMatchObject({ host: 'h', port: 7777 });
  });

  it('url-decodes credentials (passwords may be percent-encoded)', () => {
    const got = _parseDiscoveryJson(
      JSON.stringify({ url: 'postgresql://us%40r:p%40ss@localhost:5555/papercusp' }),
      alive,
      served,
    );
    expect(got).toMatchObject({ user: 'us@r', password: 'p@ss' });
  });
});

describe('_parseDiscoveryJson — stale-file guard (pid)', () => {
  // serve.ts writes this file and never unlinks it, so a leftover from a stopped
  // desktop outlives the PG it names. Honoring it would send env-less callers at a
  // dead port — worse than the native fallback. The pid decides.
  it('ignores a file whose writer process is gone (dead pid ⇒ native fallback)', () => {
    expect(_parseDiscoveryJson(REAL_WRITER_PAYLOAD, dead, served)).toBeNull();
  });

  it('honors the file while its writer is alive', () => {
    expect(_parseDiscoveryJson(REAL_WRITER_PAYLOAD, alive, served)).not.toBeNull();
  });

  it('trusts a legacy file that carries no pid at all', () => {
    const got = _parseDiscoveryJson(JSON.stringify({ host: 'h', port: 1234 }), dead, served);
    expect(got, 'no pid ⇒ nothing to liveness-check ⇒ behave as before').toMatchObject({ port: 1234 });
  });

  it('_defaultIsPidAlive: true for this process, false for an unused pid', () => {
    expect(_defaultIsPidAlive(process.pid)).toBe(true);
    expect(_defaultIsPidAlive(2 ** 30)).toBe(false);
  });
});

// EI-19384906720464601: connection.ts is the resolver behind getOrgPg() — the hottest
// DB read path — and had NO port-listening gate at all (only libs/generic/embedded-pg-
// discovery's independent copy got one, 2026-08-01, after a measured outage). These pin
// the same regression against THIS file's own gate.
describe('_parseDiscoveryJson — stale-file guard (port-listening)', () => {
  it('THE OUTAGE: rejects a file whose pid is ALIVE but whose port is NOT served', () => {
    // pid alive (so the pid gate passes) is exactly the case that got through before —
    // only the port gate can catch it.
    expect(_parseDiscoveryJson(REAL_WRITER_PAYLOAD, alive, notServed)).toBeNull();
  });

  it('a legacy {host,port} file with a dead port is also rejected, not just url-shaped ones', () => {
    const got = _parseDiscoveryJson(JSON.stringify({ host: 'h', port: 1234 }), alive, notServed);
    expect(got).toBeNull();
  });

  it('a file with no port at all is still trusted (port gate has nothing to judge)', () => {
    // Mirrors the generic resolver's back-compat case: an env with no numeric port
    // anywhere never reaches isPortServed at all (the `port` truthy-check upstream
    // already returns null), so it's covered by the existing "falls through" tests
    // above — this just pins that `notServed` being wired in doesn't change that.
    expect(_parseDiscoveryJson(JSON.stringify({ url: 'postgresql://u:p@h/papercusp' }), alive, notServed)).toBeNull();
  });
});

// _defaultIsPortServed itself, against the REAL /proc/net/tcp{,6} (no injection) —
// the same regression pins as libs/generic/embedded-pg-discovery/src/index.test.ts's
// port-reachability-gate block, so this file's copy is held to the identical bar.
describe('_defaultIsPortServed (real /proc, Linux-only)', () => {
  const onLinux = process.platform === 'linux' ? it : it.skip;

  onLinux('rejects a port nothing is listening on', () => {
    // Port 9 (Discard, RFC 863) — essentially guaranteed unbound in a test sandbox,
    // same choice the generic resolver's test suite makes for the identical reason.
    expect(_defaultIsPortServed(9)).toBe(false);
  });

  onLinux('accepts a port that IS being listened on', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      expect(_defaultIsPortServed(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
