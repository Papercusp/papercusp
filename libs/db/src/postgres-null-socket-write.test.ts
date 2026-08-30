/**
 * WI-1048027: a transient pgbouncer CONNECTION_CLOSED must not kill the process.
 *
 * ROOT CAUSE (postgres.js 3.4.9, unfixed upstream -- 3.4.9 is the latest release):
 * the connection closure tears down the socket without resetting its
 * deferred-write state, and `nextWrite` trusts that state.
 *
 *   write(x, fn)   -- for a small chunk, defers via `setImmediate(nextWrite)`
 *   closed()       -- sets `socket = null`, but leaves `chunk`/`nextWriteTimer` set
 *   nextWrite(fn)  -- calls `socket.write(chunk, fn)` with NO null check
 *
 * When pgbouncer drops an idle server connection, `closed()` nulls the socket and
 * `reconnect()` schedules `connect` behind a backoff. Queries queued during that
 * backoff window still reach `write()`, which arms `setImmediate(nextWrite)`;
 * the immediate then fires against a null socket and raises
 *
 *   TypeError: Cannot read properties of null (reading 'write')
 *       at Immediate.nextWrite (node_modules/postgres/src/connection.js:255:22)
 *       at process.processImmediate (node:internal/timers:504:21)
 *
 * That throw is OUT OF BAND -- it happens inside an Immediate, not on any query's
 * call stack or promise chain -- so no caller-side `try/catch` and no rejection
 * handler can observe it, and it terminates the process. This is why the
 * CONNECTION_CLOSED surfaces twice: once HANDLED via
 * `closed() -> error(Errors.connection('CONNECTION_CLOSED', ...))`, and then once
 * UNHANDLED as the TypeError that kills the run. Canonical run 4 died this way at
 * ~85/121 tasks after ~74 minutes while reporting `failed=0`.
 *
 * The exposure is NOT limited to the affected-tests runner: the governed-admission
 * write uses the shared org-admin pool via `getOrgPg() -> buildClient()`
 * (idle_timeout 30s), so ANY long-running consumer of that pool is exposed.
 * affected-tests is merely where it was observed, because it runs 55-74 minutes.
 *
 * THE FIX lives in `patches/postgres+3.4.9.patch` (patch-package, the mechanism
 * this repo already uses for 5 other deps). It is purely additive -- it adds a
 * null guard to `nextWrite` and completes the teardown state reset in `closed()`
 * and `terminate()`; it removes nothing, so the happy path is byte-for-byte
 * unchanged. A process-level `uncaughtException` handler or a narrower
 * `idle_timeout` would both be mitigations (catch-and-swallow / window-narrowing)
 * and are explicitly disallowed here.
 *
 * These tests are the recurrence guard for the whole class: they assert against
 * the postgres build this package actually resolves, so if postgres is ever
 * upgraded and the patch is not rebased, they fail rather than silently
 * reintroducing a process-killing crash.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Resolve the postgres package THIS package would actually import, rather than a
 * hardcoded relative path -- the point is to assert on the code that really runs.
 */
const require_ = createRequire(import.meta.url);

/**
 * postgres.js does not expose `./package.json` in its `exports` map, so resolve
 * the entry point and walk up to the package root. Walking (rather than assuming
 * a fixed depth) keeps this correct whichever export condition resolves --
 * `src/index.js` under ESM/bun, `cjs/src/index.js` under require.
 */
function resolvePostgresRoot(): string {
  const entry = require_.resolve('postgres');
  let dir = path.dirname(entry);
  for (let hops = 0; hops < 8; hops++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'postgres') return dir;
      } catch {
        // Unparseable manifest on the way up -- keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the postgres package root from ${entry}`);
}

const PG_ROOT = resolvePostgresRoot();

/** Every build postgres.js ships. `src` is the ESM/bun entry, `cjs` is what a
 *  plain `require('postgres')` resolves to, `cf` is the workerd entry. They are
 *  separate copies of the same source, so a patch applied to only one leaves the
 *  others crashing. */
const BUILD_RELATIVE_PATHS = ['src/connection.js', 'cjs/src/connection.js', 'cf/src/connection.js'];

type Build = { rel: string; abs: string; source: string };

const BUILDS: Build[] = BUILD_RELATIVE_PATHS.flatMap((rel) => {
  const abs = path.join(PG_ROOT, rel);
  return fs.existsSync(abs) ? [{ rel, abs, source: fs.readFileSync(abs, 'utf8') }] : [];
});

/** Extract the whole `function nextWrite(fn) { ... }` declaration from a build. */
function extractNextWrite(source: string): string {
  const m = source.match(/^ {2}function nextWrite\(fn\) \{[\s\S]+?^ {2}\}/m);
  expect(m, 'postgres connection.js must declare `function nextWrite(fn)`').toBeTruthy();
  return m![0];
}

/**
 * Evaluate a real `nextWrite` declaration inside a harness that mimics the
 * connection closure's mutable state. This exercises the ACTUAL shipped source
 * text -- not a reimplementation of it -- so the test cannot drift from the fix.
 */
function instantiateNextWrite(
  nextWriteDeclaration: string,
  initial: { socket: unknown; chunk: unknown; nextWriteTimer: unknown },
) {
  const factory = new Function(
    'initial',
    `
      let socket = initial.socket;
      let chunk = initial.chunk;
      let nextWriteTimer = initial.nextWriteTimer;
      ${nextWriteDeclaration}
      return {
        nextWrite,
        readState: () => ({ socket, chunk, nextWriteTimer }),
      };
    `,
  ) as (i: typeof initial) => {
    nextWrite: (fn?: unknown) => unknown;
    readState: () => { socket: unknown; chunk: unknown; nextWriteTimer: unknown };
  };
  return factory(initial);
}

describe('postgres.js null-socket deferred write (WI-1048027)', () => {
  it('ships at least the ESM and CJS builds, both resolved from the real package', () => {
    // If this fails, the build layout changed and the per-build assertions below
    // may be silently checking nothing.
    expect(BUILDS.length, `expected >=2 postgres builds under ${PG_ROOT}`).toBeGreaterThanOrEqual(2);
    expect(BUILDS.map((b) => b.rel)).toContain('src/connection.js');
    expect(BUILDS.map((b) => b.rel)).toContain('cjs/src/connection.js');
  });

  describe.each(BUILDS)('build $rel', ({ source }) => {
    it('nextWrite returns instead of throwing when the socket was torn down', () => {
      const harness = instantiateNextWrite(extractNextWrite(source), {
        socket: null, // closed() nulled it while the immediate was pending
        chunk: Buffer.from('SELECT 1'),
        nextWriteTimer: null,
      });

      // The precise regression: this used to raise
      // "TypeError: Cannot read properties of null (reading 'write')".
      expect(() => harness.nextWrite()).not.toThrow();
    });

    it('nextWrite reports backpressure (false) and clears the unsendable chunk', () => {
      const harness = instantiateNextWrite(extractNextWrite(source), {
        socket: null,
        chunk: Buffer.from('unsendable'),
        nextWriteTimer: null,
      });

      // `false` mirrors Node's socket.write backpressure contract, which callers
      // already handle; the close itself is surfaced separately via
      // Errors.connection('CONNECTION_CLOSED'), so dropping the chunk loses no
      // error signal -- but it MUST be dropped, or it would be concatenated onto
      // the next connection's StartupMessage.
      expect(harness.nextWrite()).toBe(false);
      const state = harness.readState();
      expect(state.chunk, 'chunk buffered for a dead socket must be dropped').toBeNull();
      expect(state.nextWriteTimer).toBeNull();
    });

    it('still writes normally when the socket is alive (happy path unchanged)', () => {
      const written: unknown[] = [];
      const harness = instantiateNextWrite(extractNextWrite(source), {
        socket: {
          write: (chunk: unknown) => {
            written.push(chunk);
            return true;
          },
        },
        chunk: Buffer.from('SELECT 1'),
        nextWriteTimer: null,
      });

      expect(harness.nextWrite()).toBe(true);
      expect(written).toHaveLength(1);
      expect(harness.readState().chunk).toBeNull();
    });

    it('CONTROL: the same test detects the bug when the guard is removed', () => {
      // Falsifiability. Without this, the assertions above would pass just as
      // happily against a test harness that never exercised the defect at all.
      const patched = extractNextWrite(source);
      const unpatched = patched.replace(/\n {4}if \(socket === null\) \{[\s\S]*?\n {4}\}\n/, '\n');

      expect(
        unpatched,
        'control must actually remove the guard -- a no-op mutation proves nothing',
      ).not.toBe(patched);
      expect(unpatched).not.toMatch(/socket === null/);

      const harness = instantiateNextWrite(unpatched, {
        socket: null,
        chunk: Buffer.from('SELECT 1'),
        nextWriteTimer: null,
      });

      expect(() => harness.nextWrite()).toThrow(TypeError);
    });

    it('teardown resets deferred-write state, not just the timer handle', () => {
      // reconnect() reuses the same closure and connected() resets neither field.
      // Leaving nextWriteTimer non-null wedges write()'s `nextWriteTimer === null`
      // scheduling guard so deferred writes are never re-armed again; leaving
      // `chunk` set corrupts the next connection's StartupMessage.
      const closedBody = source.match(/^ {2}async function closed\(hadError\) \{[\s\S]+?^ {2}\}/m);
      expect(closedBody, 'connection.js must declare `async function closed(hadError)`').toBeTruthy();
      expect(closedBody![0]).toMatch(/chunk = nextWriteTimer = null/);

      const terminateBody = source.match(/^ {2}function terminate\(\) \{[\s\S]+?^ {2}\}/m);
      expect(terminateBody, 'connection.js must declare `function terminate()`').toBeTruthy();
      expect(terminateBody![0]).toMatch(/chunk = nextWriteTimer = null/);
    });
  });
});
