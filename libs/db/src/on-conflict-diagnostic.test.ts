import { describe, expect, it } from 'vitest';
import {
  ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE,
  explainOnConflictSkew,
  isOnConflictSkewError,
  parseConflictTarget,
  parseInsertTarget,
} from './on-conflict-diagnostic';

/**
 * Build an error shaped like the one postgres-js actually rejects with: a
 * PostgresError carrying `.code`, plus `query`/`parameters` attached as
 * NON-ENUMERABLE own properties (see queryError() in postgres/src/connection.js).
 * Constructing it this way — rather than a plain object literal — is what makes
 * these tests evidence about the real error shape instead of about a fixture.
 */
function pgError(opts: { code?: string; message?: string; query?: string }): Error {
  const err = new Error(
    opts.message ??
      'there is no unique or exclusion constraint matching the ON CONFLICT specification',
  );
  if (opts.code !== undefined) {
    Object.defineProperty(err, 'code', { value: opts.code, enumerable: false });
  }
  if (opts.query !== undefined) {
    Object.defineProperty(err, 'query', { value: opts.query, enumerable: false });
  }
  return err;
}

const REAL_UPSERT =
  'INSERT INTO harness_shared.agent_facts (owner_id, key, value)\n' +
  '  VALUES ($1, $2, $3)\n' +
  '  ON CONFLICT (owner_id, key)\n' +
  '  DO UPDATE SET value = excluded.value, updated_at = now()';

describe('isOnConflictSkewError', () => {
  it('recognises the error by SQLSTATE', () => {
    expect(isOnConflictSkewError(pgError({ code: '42P10' }))).toBe(true);
  });

  it('recognises it by message when a boundary dropped the code', () => {
    // A re-wrap / serialize hop loses non-enumerable `.code` but keeps `.message`.
    expect(isOnConflictSkewError(pgError({}))).toBe(true);
  });

  it('does NOT fire on unrelated database errors', () => {
    // 23505 is unique_violation — a DIFFERENT, legitimate, very common error.
    // Enriching it with deploy-skew prose would be actively misleading.
    expect(
      isOnConflictSkewError(
        pgError({ code: '23505', message: 'duplicate key value violates unique constraint "x_pkey"' }),
      ),
    ).toBe(false);
  });

  it('does not throw on non-error inputs', () => {
    for (const junk of [null, undefined, 'a string', 42, {}, []]) {
      expect(isOnConflictSkewError(junk)).toBe(false);
    }
  });
});

describe('statement parsing', () => {
  it('recovers the relation and the conflict target from a realistic upsert', () => {
    expect(parseInsertTarget(REAL_UPSERT)).toBe('harness_shared.agent_facts');
    expect(parseConflictTarget(REAL_UPSERT)).toBe('(owner_id, key)');
  });

  it('handles quoted identifiers, newlines, and ON CONSTRAINT', () => {
    const sql =
      'insert into\n  "Weird Schema"."Tbl"\n  (x) values (1)\n  on conflict on constraint my_uq do nothing';
    expect(parseInsertTarget(sql)).toBe('"Weird Schema"."Tbl"');
    expect(parseConflictTarget(sql)).toBe('on constraint my_uq');
  });

  it('keeps the WHERE clause of a partial-index target (it is part of the spec)', () => {
    const sql =
      'INSERT INTO t (x) VALUES (1) ON CONFLICT (a) WHERE deleted_at IS NULL DO UPDATE SET x = excluded.x';
    expect(parseConflictTarget(sql)).toBe('(a) WHERE deleted_at IS NULL');
  });

  it('stops at the FIRST action keyword, not a later parenthesis in the SET body', () => {
    const sql =
      'INSERT INTO t (x) VALUES (1) ON CONFLICT (a) DO UPDATE SET x = coalesce(excluded.x, t.x)';
    expect(parseConflictTarget(sql)).toBe('(a)');
  });

  it('reports no target for a bare ON CONFLICT DO NOTHING', () => {
    // Deliberate: a bare DO NOTHING infers no index, so it can never raise
    // 42P10. An empty string here would read as "the target was blank".
    expect(parseConflictTarget('INSERT INTO t (x) VALUES (1) ON CONFLICT DO NOTHING')).toBeNull();
  });

  it('returns null rather than guessing when there is no statement', () => {
    expect(parseInsertTarget(undefined)).toBeNull();
    expect(parseConflictTarget(undefined)).toBeNull();
    expect(parseInsertTarget('SELECT 1')).toBeNull();
  });
});

describe('explainOnConflictSkew', () => {
  it('returns null for anything that is not this error, so callers keep their own formatting', () => {
    expect(explainOnConflictSkew(pgError({ code: '23505', message: 'duplicate key' }))).toBeNull();
    expect(explainOnConflictSkew(new Error('boom'))).toBeNull();
    expect(explainOnConflictSkew(null)).toBeNull();
  });

  it('names the table, the target, and the cause', () => {
    const out = explainOnConflictSkew(pgError({ code: '42P10', query: REAL_UPSERT }))!;
    expect(out).toContain('harness_shared.agent_facts');
    expect(out).toContain('(owner_id, key)');
    expect(out).toContain('DEPLOY SKEW');
    // The actionable next step must name the relation, not a placeholder.
    expect(out).toContain('dev:pg_query { describe: "harness_shared.agent_facts" }');
  });

  it('PRESERVES the original Postgres sentence verbatim as the first line', () => {
    // Load-bearing: existing substring/regex matchers over the old text (the
    // tool-error classifier's dual-engine messagePattern rules, log greps) must
    // keep matching. This is the no-breakage guarantee, so pin it explicitly.
    const original =
      'there is no unique or exclusion constraint matching the ON CONFLICT specification';
    const out = explainOnConflictSkew(pgError({ code: '42P10', query: REAL_UPSERT }))!;
    expect(out.split('\n')[0]).toBe(original);
    expect(out).toContain(original);
  });

  it('degrades honestly when the statement is not attached', () => {
    const out = explainOnConflictSkew(pgError({ code: '42P10' }))!;
    // It must still deliver the CAUSE (the half that shortens the diagnosis)...
    expect(out).toContain('DEPLOY SKEW');
    // ...and must NOT invent a relation it could not recover.
    expect(out).toContain('could not recover');
    expect(out).not.toContain('describe: "undefined"');
    expect(out).not.toContain('describe: "null"');
  });

  it('exports the SQLSTATE it keys on', () => {
    expect(ON_CONFLICT_NO_MATCHING_INDEX_SQLSTATE).toBe('42P10');
  });
});

/**
 * ── Falsifiability controls ─────────────────────────────────────────────────
 * A guard that has never failed is a guard nobody has tested. These keep two
 * deliberately-WRONG implementations permanently in the file (never mutating
 * the shared tree — see the repo's mutation-probe guidance) and assert the
 * assertions above can actually tell them apart from the real subject.
 */
describe('falsifiability controls', () => {
  it('a GREEDY conflict-target regex can consume the SET body — the real one does not', () => {
    const sql =
      "INSERT INTO t (x) VALUES (1) ON CONFLICT (a) DO UPDATE SET x = 'DO UPDATE'";
    // The deliberately-wrong variant: greedy `[\s\S]*` runs to the LAST
    // action-looking token, including one inside the SET expression.
    const GREEDY = /\bon\s+conflict\b([\s\S]*)\bdo\s+(?:nothing|update)\b/i;
    const wrong = GREEDY.exec(sql)?.[1].trim();
    const right = parseConflictTarget(sql);
    expect(right).toBe('(a)');
    expect(wrong).toContain('DO UPDATE SET');
    // If these were equal the non-greedy choice would be untested.
    expect(wrong).not.toBe(right);
  });

  it('REGRESSION: the identifier class must not admit punctuation', () => {
    // An earlier draft built IDENT with a literal high-Unicode tail, which
    // parses as ONE contiguous range starting at `_` and therefore also
    // swallowed `{ | } ~`. It compiled, and it parsed every real table name
    // correctly, so nothing surfaced it — only a direct probe did. Pin the
    // behaviour that draft got wrong.
    for (const junk of ['{|}~', '{', '~']) {
      expect(parseInsertTarget(`INSERT INTO ${junk} (x) VALUES (1)`)).toBeNull();
    }
    // Calibration: the SAME instrument must still accept real identifiers, or
    // the assertion above would pass simply by matching nothing at all.
    expect(parseInsertTarget('INSERT INTO harness_shared.tool_invocations (x) VALUES (1)')).toBe(
      'harness_shared.tool_invocations',
    );
  });
});
