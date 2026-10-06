/**
 * WI-10006309: a column added to `harness_shared.<base>_consolidated` is
 * invisible through every per-pot `harness_<slug>.<base>` view created before
 * it, because Postgres fixes a view's column list at creation. 1156 added
 * agent_chats.continued_from_chat_id without refreshing the views, and the
 * agent-chats list returned HTTP 500 for 256 of 263 pots (pui /resume never
 * loaded). 1371 adds `harness_shared.refresh_consolidated_views(base)`.
 *
 * Guard: every migration after 1371 that adds a column to a consolidated table
 * must call `refresh_consolidated_views('<base>')` in the same file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
/** 1371 refreshed every view; earlier migrations are covered by it. */
const GUARD_FROM = 1372;

/** Bases whose columns grow in this SQL, minus those it refreshes. */
export function unrefreshedConsolidatedAdds(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, '');
  const grown = new Set<string>();
  for (const statement of code.split(';')) {
    const m = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?harness_shared"?\."?(\w+)_consolidated"?\s/i.exec(
      statement,
    );
    if (!m) continue;
    const rest = statement.slice(m.index + m[0].length);
    if (/\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)/i.test(rest)) {
      grown.add(m[1]!.toLowerCase());
    }
  }
  return [...grown].filter(
    (base) =>
      !new RegExp(`refresh_consolidated_views\\s*\\(\\s*'${base}'\\s*\\)`, 'i').test(code),
  );
}

function migrations(): Array<{ file: string; num: number; sql: string }> {
  return readdirSync(SQL_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .map((file) => ({
      file,
      num: Number.parseInt(file, 10),
      sql: readFileSync(join(SQL_DIR, file), 'utf8'),
    }));
}

describe('consolidated per-pot views are refreshed when their base grows (WI-10006309)', () => {
  it('flags the real offender 1156 and the detector shapes it must catch', () => {
    const m1156 = migrations().find((m) => m.num === 1156);
    expect(m1156, '1156 is the calibration case; it must stay readable').toBeDefined();
    expect(unrefreshedConsolidatedAdds(m1156!.sql)).toEqual(['agent_chats']);

    expect(
      unrefreshedConsolidatedAdds(
        'ALTER TABLE harness_shared.harness_issues_consolidated ADD fed_x text;',
      ),
    ).toEqual(['harness_issues']);
    expect(
      unrefreshedConsolidatedAdds(
        `ALTER TABLE harness_shared.agent_chats_consolidated ADD COLUMN x text;
         SELECT * FROM harness_shared.refresh_consolidated_views('agent_chats');`,
      ),
    ).toEqual([]);
    expect(
      unrefreshedConsolidatedAdds(
        `ALTER TABLE harness_shared.agent_chats_consolidated
           ADD CONSTRAINT c CHECK (true);
         -- ALTER TABLE harness_shared.messages_consolidated ADD COLUMN y text;`,
      ),
      'constraints and commented-out SQL do not count',
    ).toEqual([]);
  });

  it('1371 defines the refresh function', () => {
    const m1371 = migrations().find((m) => m.num === 1371);
    expect(m1371?.sql).toMatch(/FUNCTION harness_shared\.refresh_consolidated_views\(base text\)/);
  });

  it(`every migration from ${GUARD_FROM} that adds a consolidated column refreshes its views`, () => {
    const offenders = migrations()
      .filter((m) => m.num >= GUARD_FROM)
      .flatMap((m) =>
        unrefreshedConsolidatedAdds(m.sql).map(
          (base) =>
            `${m.file}: adds a column to harness_shared.${base}_consolidated; add ` +
            `SELECT * FROM harness_shared.refresh_consolidated_views('${base}');`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
