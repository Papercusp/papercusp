/**
 * `readPathInterestsByOwner` — the source for the `holds-a-lock-on` coupling edge.
 *
 * WHY THIS FILE EXISTS. The bug it guards is not a wrong value; it is a query that
 * CANNOT produce the value its consumer needs, and therefore returns a clean,
 * error-free, permanently-empty result that no ordinary test notices:
 *
 *   · `agent_file_locks_pkey` is PRIMARY KEY (coordination_domain, path), so at most
 *     ONE owner exists per path. The consumer emits an edge when TWO owners share a
 *     path. A holds-only source is UNSATISFIABLE BY CONSTRUCTION.
 *   · `agent_lock_waiters.status` is TRANSIENT — measured on the live table:
 *     granted 20, expired 4, cancelled 3, **waiting 0**. Gating tickets on
 *     `status = 'waiting'` reproduces the same always-empty defect one level over.
 *
 * Both mistakes typecheck, and a hand-built fixture that writes the same store the
 * code reads passes either way — which is how this shape survived three separate
 * instances in one feature (EI-20199756190949760). So these assertions run against
 * the emitted SQL, and each carries a CONTROL: a deliberately-wrong query that the
 * same assertion must REJECT. A guard that has never failed is not a guard.
 */
import { describe, expect, it } from 'vitest';
import { readPathInterestsByOwner } from './su-lock-store';

/**
 * Minimal stand-in for the postgres.js tagged template: records the SQL it is asked
 * to run and resolves empty. Nested fragments (the domain filters) interpolate as
 * their own recorded text, so the assembled text reflects what would really execute.
 */
function captureSql(): { sql: never; text: () => string } {
  const seen: string[] = [];
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]): unknown => {
    let out = '';
    strings.forEach((s, i) => {
      out += s;
      if (i < vals.length) {
        const v = vals[i] as { __frag?: string } | undefined;
        out += v && typeof v === 'object' && '__frag' in v ? String(v.__frag) : '?';
      }
    });
    // A nested fragment is awaited only by the outer template, never by the caller.
    const frag = { __frag: out, then: undefined } as Record<string, unknown>;
    seen.push(out);
    const p = Promise.resolve([]) as unknown as Record<string, unknown>;
    return Object.assign(p, frag);
  };
  return {
    sql: tag as never,
    // The LAST recorded template is the outermost (fragments are built first).
    text: () => seen[seen.length - 1] ?? '',
  };
}

const OWNERS = ['su-aaa', 'su-bbb'];

/** The two properties that make the source satisfiable at all. */
function readsContentionSource(text: string): boolean {
  return /agent_lock_waiters/i.test(text) && /unnest/i.test(text);
}
function gatesTicketsOnWindowNotStatus(text: string): boolean {
  return /wait_until\s*>/i.test(text) && !/status\s*=/i.test(text);
}

describe('readPathInterestsByOwner — the source must be able to produce two owners on one path', () => {
  it('unions the waiter queue in, because a mutual-exclusion table alone never can', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS);
    const text = cap.text();

    expect(text).toMatch(/agent_file_locks/i);
    expect(readsContentionSource(text)).toBe(true);
  });

  it('gates tickets on their wait_until window, NEVER on the transient status column', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS);
    expect(gatesTicketsOnWindowNotStatus(cap.text())).toBe(true);
  });

  it('never reads the abandoned agent_granular_locks table', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS);
    expect(cap.text()).not.toMatch(/agent_granular_locks/i);
  });

  it('reads every coordination domain by default — the writer keys a different tree than the reader', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS);
    const text = cap.text();
    expect(text).toMatch(/TRUE/);
    expect(text).not.toMatch(/coordination_domain\s*=/i);
  });

  it('still honours an explicitly requested domain', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS, { coordinationDomain: '/some/tree' });
    expect(cap.text()).toMatch(/coordination_domain\s*=/i);
  });

  it('includeIntents:false returns the holds-only lane, which is correct ONLY for include_detail', async () => {
    const cap = captureSql();
    await readPathInterestsByOwner(cap.sql, OWNERS, { includeIntents: false });
    const text = cap.text();
    expect(text).toMatch(/agent_file_locks/i);
    expect(text).not.toMatch(/agent_lock_waiters/i);
  });

  it('short-circuits on an empty owner set without touching the DB', async () => {
    const cap = captureSql();
    const rows = await readPathInterestsByOwner(cap.sql, []);
    expect(rows).toEqual([]);
    expect(cap.text()).toBe('');
  });

  // ── CONTROLS ──────────────────────────────────────────────────────────────
  // The assertions above are only worth anything if they REJECT the two shapes
  // that shipped as silently-empty signals. These are the historical defects
  // verbatim, and each must fail its own predicate.
  describe('controls — the assertions must reject the shapes that actually shipped', () => {
    it('rejects the holds-only query (unsatisfiable under the composite PK)', () => {
      const shipped = `SELECT owner, path AS node FROM agent_file_locks
         WHERE expires_ts > clock_timestamp() AND owner = ANY(?::text[])`;
      expect(readsContentionSource(shipped)).toBe(false);
    });

    it('rejects gating tickets on status, which is empty essentially always', () => {
      const tempting = `SELECT w.owner, p FROM agent_lock_waiters w, LATERAL unnest(w.paths) AS p
         WHERE w.status = 'waiting' AND w.owner = ANY(?::text[])`;
      expect(gatesTicketsOnWindowNotStatus(tempting)).toBe(false);
    });

    it('calibration: the real query satisfies both predicates the controls fail', async () => {
      const cap = captureSql();
      await readPathInterestsByOwner(cap.sql, OWNERS);
      const text = cap.text();
      expect(readsContentionSource(text)).toBe(true);
      expect(gatesTicketsOnWindowNotStatus(text)).toBe(true);
    });
  });
});
