/**
 * Recurrence guard for the ENFORCEMENT half of plan outage-must-not-be-silent-2026-08-02
 * (D-001): a positive store-identity mismatch must REFUSE the offending discovery
 * endpoint, not merely narrate it.
 *
 * The condition being pinned is the one that actually happened on 2026-08-02 22:40Z: an
 * ephemeral operator's embedded Postgres that was alive, listening AND schema-complete —
 * so the pid gate, the port gate and the WI-5244 schema check all PASSED — answered
 * `not_found` for every record in the real store for ~13 minutes fleet-wide, while the
 * store-identity check was deployed, firing, and writing to console.error the whole time.
 * Detection without refusal is what these tests exist to prevent regressing to.
 *
 * The three no-quarantine cases matter more than the positive one. This code path can
 * only fail in two directions, and banishing a HEALTHY endpoint is the worse of them:
 * there may be nothing left to fall back to. Every uncertain input must leave the
 * quarantine empty.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _quarantineDiscoveryEndpointIfProvenForeign,
  _quarantinedDiscoveryEndpointsForTests,
  _resetDiscoveryQuarantineForTests,
  _resetUrlCacheForTests,
  setDiscoveryIdentityObserver,
} from './connection';

/**
 * A REAL listening socket on a real ephemeral port.
 *
 * The impostor must actually be LISTENING or this suite proves nothing: `readDiscoveryFile`
 * runs the pid gate and the port gate first, so a file naming a dead port is already
 * rejected upstream and never reaches the identity check. The measured 2026-08-02 impostor
 * was alive, listening AND schema-complete — passing every cheaper gate — which is exactly
 * why identity was needed. Binding a socket reconstructs that condition instead of
 * assuming it.
 */
let impostorSocket: Server;
let IMPOSTOR_PORT: number;
let IMPOSTOR_URL: string;

/** The trusted pin: env-pinned :5432, rewritten to the pgbouncer port as it is in prod. */
const PINNED_ENV_URL = 'postgresql://127.0.0.1:6432/papercusp';

let home: string;
let priorHome: string | undefined;
let priorSkip: string | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  impostorSocket = createServer();
  await new Promise<void>((resolve) => impostorSocket.listen(0, '127.0.0.1', resolve));
  const addr = impostorSocket.address();
  if (!addr || typeof addr === 'string') throw new Error('could not bind an ephemeral port');
  IMPOSTOR_PORT = addr.port;
  IMPOSTOR_URL = `postgresql://harness_admin:pwd@localhost:${IMPOSTOR_PORT}/papercusp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => impostorSocket.close(() => resolve()));
});

/** Write a discovery file advertising `port`, with a pid that is alive (our own). */
function writeDiscoveryFile(port: number): void {
  writeFileSync(
    join(home, 'embedded-pg.json'),
    JSON.stringify({
      url: `postgresql://harness_admin:pwd@localhost:${port}/papercusp`,
      port,
      pid: process.pid,
      startedAt: Date.now(),
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pc-discovery-quarantine-'));
  priorHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = home;
  // Discovery is switched OFF wholesale in some unit contexts; this suite is ABOUT
  // discovery, so assert the switch rather than inherit it.
  priorSkip = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  _resetDiscoveryQuarantineForTests();
  _resetUrlCacheForTests();
  // The quarantine deliberately logs loudly; keep the suite output clean without
  // suppressing the assertion that it DID speak.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setDiscoveryIdentityObserver(null);
  errSpy.mockRestore();
  if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = priorHome;
  if (priorSkip === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = priorSkip;
  rmSync(home, { recursive: true, force: true });
});

describe('a proven-foreign discovery endpoint is refused, not just reported', () => {
  it('reports every proven fallback before log deduplication without changing uncertain routing', () => {
    const observe = vi.fn();
    setDiscoveryIdentityObserver(observe);
    writeDiscoveryFile(IMPOSTOR_PORT);
    expect(_quarantineDiscoveryEndpointIfProvenForeign({ url: IMPOSTOR_URL }, { url: IMPOSTOR_URL })).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      expect(_quarantineDiscoveryEndpointIfProvenForeign({ url: PINNED_ENV_URL }, { url: IMPOSTOR_URL })).toBe(true);
    }
    expect(observe.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      'db-discovery-identity', { eligible: 1, applied: 0, reason: 'foreign-discovery-endpoint' },
    ]));
    expect(errSpy).toHaveBeenCalledTimes(1);
    setDiscoveryIdentityObserver(() => { throw new Error('telemetry unavailable'); });
    expect(_quarantineDiscoveryEndpointIfProvenForeign({ url: PINNED_ENV_URL }, { url: IMPOSTOR_URL })).toBe(true);
  });
  it('quarantines the endpoint the discovery file currently advertises', () => {
    writeDiscoveryFile(IMPOSTOR_PORT);

    const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
      { url: PINNED_ENV_URL },
      { url: IMPOSTOR_URL },
    );

    expect(quarantined).toBe(true);
    expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([`127.0.0.1:${IMPOSTOR_PORT}`]);
  });

  it('says so loudly — a silent refusal would be its own invisible outage', () => {
    writeDiscoveryFile(IMPOSTOR_PORT);
    _quarantineDiscoveryEndpointIfProvenForeign({ url: PINNED_ENV_URL }, { url: IMPOSTOR_URL });

    const said = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(said).toContain('QUARANTINED');
    expect(said).toContain(String(IMPOSTOR_PORT));
  });

  it('normalizes localhost and 127.0.0.1 to the same endpoint', () => {
    writeDiscoveryFile(IMPOSTOR_PORT); // file says `localhost`
    const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
      { url: PINNED_ENV_URL },
      { url: `postgresql://127.0.0.1:${IMPOSTOR_PORT}/papercusp` }, // pool says 127.0.0.1
    );
    expect(quarantined).toBe(true);
  });

  it('is idempotent — a second mismatch on the same endpoint does not re-add it', () => {
    writeDiscoveryFile(IMPOSTOR_PORT);
    _quarantineDiscoveryEndpointIfProvenForeign({ url: PINNED_ENV_URL }, { url: IMPOSTOR_URL });
    _quarantineDiscoveryEndpointIfProvenForeign({ url: PINNED_ENV_URL }, { url: IMPOSTOR_URL });
    expect(_quarantinedDiscoveryEndpointsForTests()).toHaveLength(1);
  });
});

describe('fail-soft: an uncertain mismatch never banishes an endpoint', () => {
  it('does NOT quarantine when the PIN itself came from the discovery file', () => {
    // The inversion guard. The pin is whichever pool was probed first, which is not
    // guaranteed to be the trusted one. If the pin came from this same discovery
    // endpoint, then "the endpoint that disagrees with the pin" is the REAL store, and
    // quarantining it would banish the real store and enshrine the impostor.
    writeDiscoveryFile(IMPOSTOR_PORT);

    const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
      { url: IMPOSTOR_URL }, // pinned FROM the discovery endpoint
      { url: 'postgresql://127.0.0.1:6432/papercusp' }, // the env-pinned real store
    );

    expect(quarantined).toBe(false);
    expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([]);
  });

  it('does NOT quarantine an env-pinned pool — env is the rung we fall back TO', () => {
    writeDiscoveryFile(IMPOSTOR_PORT);

    // The mismatching pool is NOT the discovery endpoint (some other trusted target).
    const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
      { url: PINNED_ENV_URL },
      { url: 'postgresql://db.internal:5432/papercusp' },
    );

    expect(quarantined).toBe(false);
    expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([]);
  });

  it('does NOT quarantine when there is no discovery file at all', () => {
    // Nothing written — the mismatch cannot be attributed to a discovery endpoint.
    const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
      { url: PINNED_ENV_URL },
      { url: IMPOSTOR_URL },
    );
    expect(quarantined).toBe(false);
    expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([]);
  });

  it('does NOT quarantine when the discovery file advertises a DIFFERENT endpoint', async () => {
    // The file has already flapped on to another port; the observed pool is stale and no
    // longer what discovery hands out, so there is nothing here to refuse. The second
    // endpoint must also be genuinely LISTENING — otherwise readDiscoveryFile rejects it
    // at the port gate and this would pass for the wrong reason (no endpoint at all,
    // rather than a different one).
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherAddr = other.address();
    if (!otherAddr || typeof otherAddr === 'string') throw new Error('bind failed');
    try {
      writeDiscoveryFile(otherAddr.port);
      const quarantined = _quarantineDiscoveryEndpointIfProvenForeign(
        { url: PINNED_ENV_URL },
        { url: IMPOSTOR_URL },
      );
      expect(quarantined).toBe(false);
      expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it.each([
    ['an unparseable observed url', PINNED_ENV_URL, 'not-a-url'],
    ['an unparseable pinned url', 'not-a-url', IMPOSTOR_URL],
  ])('does NOT quarantine on %s — an endpoint we cannot name is one we cannot judge', (
    _label,
    pinned,
    observed,
  ) => {
    writeDiscoveryFile(IMPOSTOR_PORT);
    expect(
      _quarantineDiscoveryEndpointIfProvenForeign({ url: pinned }, { url: observed }),
    ).toBe(false);
    expect(_quarantinedDiscoveryEndpointsForTests()).toEqual([]);
  });
});
