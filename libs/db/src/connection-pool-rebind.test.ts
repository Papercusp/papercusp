/**
 * Recurrence guard for EI-19285027465993737 — a cached pool must never outlive
 * the URL that justified it.
 *
 * THE INCIDENT this pins (2026-08-01, fleet-wide): a desktop registered an
 * embedded PG in `~/.papercusp/embedded-pg.json` on port 19715 and died. The
 * shared operator had lazily pooled against it, and every DB-backed MCP tool on
 * the box failed with `ECONNREFUSED 127.0.0.1:19715` until a manual restart.
 *
 * The subtle part — and the reason three existing guards all missed it — is that
 * RESOLUTION was correct the entire time. `adminUrl()` began returning the
 * native URL as soon as the discovery pid died; only the live pool was still
 * bound to the dead endpoint. Every prior guard answers "what SHOULD we connect
 * to?"; none answered "what is the pool ACTUALLY bound to?".
 *
 * So the assertion that matters here is the discovery→ABSENT transition. The
 * pre-existing teardown inside `adminUrl()` already handled
 * discovery→DIFFERENT-discovery, which is why the bug survived: the covered case
 * and the fatal case look almost identical, and only one of them was tested.
 *
 * No Postgres needed — same as connection-helpers.test.ts, importing ./connection
 * opens no connection (all pools are lazy).
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endStalePool } from './connection';

// The rebind deliberately warns (this incident was invisible for 14 minutes —
// hundreds of ECONNREFUSED lines to a port in no config file, and nothing
// alarmed). The repo runs vitest-fail-on-console, so it is captured here rather
// than removed, and the last test in this file asserts it actually fires.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** Minimal stand-in for a postgres-js `Sql` — only `.end()` is exercised. */
const fakePool = (end = vi.fn(async () => {})) => ({ end }) as never;

const DISCOVERY = 'postgresql://harness_admin:pw@localhost:19715/papercusp';
const NATIVE = 'postgresql://harness_admin:pw@127.0.0.1:5432/papercusp';

describe('endStalePool — the rebind decision', () => {
  it('REBINDS when the discovery target disappears (THE incident: discovery→native)', () => {
    const end = vi.fn(async () => {});
    expect(endStalePool(fakePool(end), DISCOVERY, NATIVE, 'org-admin')).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('does NOT rebind when the URL is unchanged — the steady state must stay free', () => {
    const end = vi.fn(async () => {});
    expect(endStalePool(fakePool(end), NATIVE, NATIVE, 'org-admin')).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });

  it('does nothing when there is no pool yet — first build is not a rebind', () => {
    expect(endStalePool(null, null, NATIVE, 'org-admin')).toBe(false);
  });

  it('rebinds on discovery→DIFFERENT-discovery too, so it fully subsumes the old teardown', () => {
    const other = 'postgresql://harness_admin:pw@localhost:29999/papercusp';
    expect(endStalePool(fakePool(), DISCOVERY, other, 'org-admin')).toBe(true);
  });

  it('rebinds on native→discovery — the reverse direction was never covered either', () => {
    expect(endStalePool(fakePool(), NATIVE, DISCOVERY, 'org-admin')).toBe(true);
  });

  it('rebinds when only the pgbouncer routing changes, same logical database', () => {
    const direct = 'postgresql://harness_admin:pw@127.0.0.1:5432/papercusp';
    const pooled = 'postgresql://harness_admin:pw@127.0.0.1:6432/papercusp';
    expect(endStalePool(fakePool(), direct, pooled, 'org-admin')).toBe(true);
  });
});

describe('the teardown must never be able to block the caller escaping a dead pool', () => {
  it('still rebinds when .end() THROWS synchronously', () => {
    const pool = {
      end: () => {
        throw new Error('socket already destroyed');
      },
    } as never;
    expect(() => endStalePool(pool, DISCOVERY, NATIVE, 'org-admin')).not.toThrow();
    expect(endStalePool(pool, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
  });

  it('still rebinds when .end() REJECTS — a pool pointed at a dead port cannot drain', () => {
    // This is the realistic shape of the incident: the endpoint is refusing
    // connections, so the drain cannot succeed. If an unhandled rejection or an
    // await could stall here, recovery would deadlock on the very failure it is
    // recovering from.
    const end = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(endStalePool({ end } as never, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
    expect(end).toHaveBeenCalled();
  });

  it('returns synchronously — it must not await the drain', () => {
    // A dead endpoint's drain only resolves on timeout; awaiting it would add
    // that timeout to every rebind on the recovery path.
    const end = vi.fn(() => new Promise<void>(() => {})); // never settles
    expect(endStalePool({ end } as never, DISCOVERY, NATIVE, 'org-admin')).toBe(true);
  });
});

/**
 * THE WIRING — everything above this line tests the DECISION, and every one of it
 * passed for four weeks while the app pool had no guard at all.
 *
 * `endStalePool` was defined, exported, unit-tested to six decimal places, and
 * called from two of the four pool getters. `getOrgPgApp()` — the pool that 100%
 * of workspace-scoped MCP calls take, via `withWorkspace()` — recomputed its URL
 * on every invocation and then THREW IT AWAY (EI-19461720588871359). A test suite
 * that only exercises the helper cannot see that: "the helper exists" is not "the
 * feature works", and the difference is the call site.
 *
 * So these assert the call graph, not the function. They read the source rather
 * than calling the getters because building a pool constructs a real postgres-js
 * client and fires `validateDiscoveryTargetOnce`'s probe query, neither of which
 * belongs in a no-DB unit test.
 */
// Overridable so falsifiability can be proven against a COPY (scripts/mutation-probe.sh)
// instead of mutating the shared tree — git-sync sweeps every few minutes and will
// happily commit a mutant that is only meant to live for the length of one run.
const CONNECTION_SRC = readFileSync(
  process.env.PROBE_CONNECTION_SRC ?? new URL('./connection.ts', import.meta.url),
  'utf8',
);

/**
 * Pool getters that legitimately have nothing to compare, each with its reason.
 * An entry here is a DECISION on the record, not a silent exemption — which is
 * the difference between this allowlist and the gap it replaces.
 */
/**
 * EI-19462929205805752 — pools whose rebind guard is REAL but does not live in the
 * getter's own body, so the `endStalePool(` scan below would wrongly read them as
 * unguarded. `getHarnessPg` is guarded at the point the URL CHANGES (inside
 * `appUrl()`) rather than at the point it is USED, precisely because its cache-hit
 * path must not pay `readDiscoveryFile()`'s readFileSync.
 *
 * The `centralGuard` name is asserted to be both DEFINED and CALLED below. Without
 * that, this map would be strictly worse than the allowlist it replaced: an entry
 * asserting "guarded elsewhere" that nothing checks is how a deleted guard keeps a
 * green test.
 */
const GUARDED_CENTRALLY: Record<string, { centralGuard: string; reason: string }> = {
  getHarnessPg: {
    centralGuard: 'endHarnessPoolsOnAppUrlRebind',
    reason:
      'Its LRU cache-hit path returns the cached handle WITHOUT recomputing appUrl(), ' +
      'so there is no fresh URL to compare against at the point of use. The guard ' +
      'therefore sits in appUrl() itself, which has already computed both sides by the ' +
      'time it returns — free there, a synchronous readFileSync on the hit path here.',
  },
};

const UNGUARDED_BY_DESIGN: Record<string, string> = {
  createDedicatedOrgPg:
    'WI-638180: it CACHES NOTHING. Every call resolves the URL fresh and builds a ' +
    'new caller-owned pool from that same resolution, so there is no previously ' +
    'built-with URL that could have gone stale — the staleness this guard exists ' +
    'to catch is only reachable through a module-scoped pool that outlives a ' +
    'discovery-file rewrite. Its client is closed by its owner when the work ' +
    'settles, so it cannot survive one either.',
};

function callsPoolBuilder(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'buildClient') {
    return true;
  }
  return ts.forEachChild(node, callsPoolBuilder) === true;
}

/** Use declaration boundaries so a neighboring async function cannot supply another getter's guard. */
function poolBuildingFunctions(): Array<{ name: string; body: string }> {
  const source = ts.createSourceFile('connection.ts', CONNECTION_SRC, ts.ScriptTarget.Latest);
  const printer = ts.createPrinter({ removeComments: true });
  return source.statements.filter(ts.isFunctionDeclaration).flatMap(declaration => {
    const { name, body } = declaration;
    if (!name || !body || !callsPoolBuilder(body)) return [];
    return [{ name: name.text, body: printer.printNode(ts.EmitHint.Unspecified, body, source) }];
  });
}

describe('the rebind guard is WIRED INTO every pool getter, not merely exported', () => {
  const getters = poolBuildingFunctions();

  it('finds the pool getters at all — a zero-match scan would pass every case below', () => {
    // The failure this file exists to prevent is a check that measures nothing and
    // reports clean. If the source shape drifts so the scan stops finding getters,
    // that must be a RED here rather than a silent green everywhere else.
    expect(getters.map((g) => g.name).sort()).toEqual(
      ['createDedicatedOrgPg', 'getHarnessPg', 'getOrgPg', 'getOrgPgApp', 'getOrgPgLosslessBigint', 'withPriorityOrgPg'].sort(),
    );
  });

  it.each(getters)(
    '$name calls endStalePool, is guarded centrally, or is allowlisted with a reason',
    ({ name, body }) => {
      const central = GUARDED_CENTRALLY[name];
      if (central) {
        expect(central.reason.length).toBeGreaterThan(40);
        // The named guard must EXIST and be CALLED. An entry asserting "guarded
        // elsewhere" that nothing verifies is worse than no entry at all: it turns a
        // deleted guard into a green test, which is the exact shape of the bug this
        // whole file exists to prevent.
        expect(CONNECTION_SRC).toContain(`function ${central.centralGuard}(`);
        const mentions = CONNECTION_SRC.split(`${central.centralGuard}(`).length - 1;
        expect(mentions).toBeGreaterThan(1); // the definition, PLUS at least one call site
        return;
      }
      if (name in UNGUARDED_BY_DESIGN) {
        expect(UNGUARDED_BY_DESIGN[name]!.length).toBeGreaterThan(40);
        expect(body).not.toContain('endStalePool');
        return;
      }
      expect(body).toContain('endStalePool(');
    },
  );

  it.each(
    getters.filter(
      (g) => !(g.name in UNGUARDED_BY_DESIGN) && !(g.name in GUARDED_CENTRALLY),
    ),
  )(
    '$name compares against the URL IT records — not a sibling pool’s',
    ({ name, body }) => {
      if (name === 'withPriorityOrgPg') {
        expect(body).toContain('endStalePool(priorityOrgPg.client, priorityOrgPg.url, url,');
        expect(body).toContain('priorityOrgPg.url = dedicated.url');
        expect(body).toContain('endStalePool(priorityOrgPg.appClient, priorityOrgPg.appUrl, appTarget,');
        expect(body).toContain('priorityOrgPg.appUrl = appTarget');
        return;
      }
      // Passing the wrong module var typechecks perfectly (they are all
      // `string | null`) and fails silently in one of two directions: a pool that
      // never rebinds, or one that rebinds on every call. Only the pairing catches it.
      const call = /endStalePool\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,/.exec(body);
      expect(call, `${name} calls endStalePool with an unparseable argument list`).toBeTruthy();
      const [, poolVar, builtWithVar] = call!;
      expect(body).toMatch(new RegExp(`\\b${builtWithVar}\\s*=\\s*url\\b`));
      expect(builtWithVar).toBe(`${poolVar}Url`);
    },
  );

  it('records the app pool’s built-with URL — the var whose absence WAS the bug', () => {
    // Grep-able, deliberately: the filed report's whole evidence was that no
    // `_appOrgClientUrl` existed anywhere in the repo.
    expect(CONNECTION_SRC).toContain('let _appOrgClientUrl: string | null = null;');
  });

  it('clears every built-with URL in _resetForTests, so a reset is never half-done', () => {
    const reset = /export async function _resetForTests\(\)[\s\S]*?\n}/.exec(CONNECTION_SRC);
    expect(reset).toBeTruthy();
    for (const v of ['_adminClientUrl', '_adminLosslessBigintClientUrl', '_appOrgClientUrl']) {
      expect(reset![0]).toContain(`${v} = null`);
    }
  });
});

describe('observability — the silence was half the incident', () => {
  it('WARNS, naming the pool, when a live pool is rebound', () => {
    // 14 minutes of fleet-wide failure produced no signal that the DB endpoint
    // had moved. A rebind is rare and load-bearing; it must leave a trace.
    endStalePool(fakePool(), DISCOVERY, NATIVE, 'org-admin-lossless-bigint');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org-admin-lossless-bigint'));
  });

  it('stays SILENT on the steady-state path, so the warning keeps its meaning', () => {
    endStalePool(fakePool(), NATIVE, NATIVE, 'org-admin');
    expect(warn).not.toHaveBeenCalled();
  });
});
