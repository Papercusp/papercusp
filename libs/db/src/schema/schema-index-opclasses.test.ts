import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  repairIndexOperatorClasses,
  repairTruncatedIndexExpressions,
  stripConcurrentBuildLeftoverIndexes,
} from './schema-index-opclasses.mjs';

const fixture = `import { pgSchema, text, timestamp, index } from "drizzle-orm/pg-core";
export const harnessShared = pgSchema("harness_shared");
export const dreamRuns = harnessShared.table("dream_runs", {
  workspaceId: text("workspace_id"),
  potSlug: text("pot_slug"),
  startedAt: timestamp("started_at"),
}, (table) => [
  index("dream_runs_ws_pot_started_idx").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.potSlug.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
]);`;

const coveringFixture = `import { pgSchema, text, timestamp, integer, index } from "drizzle-orm/pg-core";
export const harnessShared = pgSchema("harness_shared");
export const toolInvocations = harnessShared.table("tool_invocations", {
  invokedAt: timestamp("invoked_at"),
  toolName: text("tool_name"),
  durationMs: integer("duration_ms"),
  status: text("status"),
}, (table) => [
  index("tool_invocations_invoked_at_cov_idx").using("btree", table.invokedAt.desc().nullsFirst().op("timestamptz_ops"), table.toolName.asc().nullsLast().op(null), table.durationMs.asc().nullsLast().op(null), table.status.asc().nullsLast().op(null)),
]);`;

describe('repairIndexOperatorClasses', () => {
  it('applies catalog order to every field in a multi-column index', () => {
    const result = repairIndexOperatorClasses(fixture, [
      {
        schemaName: 'harness_shared',
        tableName: 'dream_runs',
        indexName: 'dream_runs_ws_pot_started_idx',
        opclasses: ['text_ops', 'text_ops', 'timestamptz_ops'],
      },
    ]);

    expect(result.matched).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.source).toContain(
      'table.potSlug.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")',
    );
  });

  it('does not rewrite expression indexes whose catalog keys are not fields', () => {
    const result = repairIndexOperatorClasses(fixture, [
      {
        schemaName: 'harness_shared',
        tableName: 'dream_runs',
        indexName: 'dream_runs_ws_pot_started_idx',
        opclasses: ['text_ops', 'text_ops', 'timestamptz_ops'],
        expression: true,
      },
    ]);

    expect(result.matched).toBe(0);
    expect(result.changed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.source).toBe(fixture);
  });

  it('removes null operator calls for INCLUDE attributes and is idempotent', () => {
    const metadata = [
      {
        schemaName: 'harness_shared',
        tableName: 'tool_invocations',
        indexName: 'tool_invocations_invoked_at_cov_idx',
        opclasses: ['timestamptz_ops', null, null, null],
      },
    ];

    const result = repairIndexOperatorClasses(coveringFixture, metadata);
    expect(result.matched).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.source).not.toContain('.op(null)');
    expect(result.source).toContain(
      'table.toolName.asc().nullsLast(), table.durationMs.asc().nullsLast(), table.status.asc().nullsLast()',
    );

    const secondPass = repairIndexOperatorClasses(result.source, metadata);
    expect(secondPass.changed).toBe(0);
    expect(secondPass.source).toBe(result.source);
  });
});

// drizzle-kit reads index keys as coalesce(attname, pg_get_indexdef(...)),
// which is type `name`, so expression keys arrive cut at 63 bytes.
const operationIdKey = "(((payload -> 'blueprintOperation'::text) ->> 'operationId'::text))";
const callerIdKey = "(((payload -> 'blueprintOperation'::text) ->> 'callerId'::text))";
const truncatedFixture = `import { pgSchema, text, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export const harnessShared = pgSchema("harness_shared");
export const workItems = harnessShared.table("work_items", {
  workspaceId: text("workspace_id"),
  payload: jsonb("payload"),
}, (table) => [
  index("blueprint_invocation_item_recovery_idx").using("btree", sql\`workspace_id\`, sql\`${operationIdKey.slice(0, 63)}\`, sql\`${callerIdKey.slice(0, 63)}\`).where(sql\`(payload ? 'blueprintOperation'::text)\`),
]);`;
const recoveryRow = {
  schemaName: 'harness_shared',
  tableName: 'work_items',
  indexName: 'blueprint_invocation_item_recovery_idx',
  keys: [
    { expression: false, definition: 'workspace_id' },
    { expression: true, definition: operationIdKey },
    { expression: true, definition: callerIdKey },
  ],
};

describe('repairTruncatedIndexExpressions', () => {
  it('restores each truncated key from the catalog definition at its position', () => {
    expect(truncatedFixture).toContain("'operationId'::te`");

    const result = repairTruncatedIndexExpressions(truncatedFixture, [recoveryRow]);

    expect(result).toMatchObject({ matched: 1, changed: 1, repairedKeys: 2 });
    expect(result.source).toContain(
      `.using("btree", sql\`workspace_id\`, sql\`${operationIdKey}\`, sql\`${callerIdKey}\`).where(sql\`(payload ? 'blueprintOperation'::text)\`)`,
    );
  });

  it('maps keys by position when two truncated fragments share the same prefix', () => {
    const shared = `(((payload -> 'resource_governor'::text) ->> 'namespaceAndSomethingLonger`;
    const first = `${shared}A'::text))`;
    const second = `${shared}B'::text))`;
    const prefix = shared.slice(0, 63);
    const source = truncatedFixture.replace(
      /\.using\("btree", [^\n]*\)\.where/,
      `.using("btree", sql\`workspace_id\`, sql\`${prefix}\`, sql\`${prefix}\`).where`,
    );

    const result = repairTruncatedIndexExpressions(source, [
      {
        ...recoveryRow,
        keys: [recoveryRow.keys[0], { expression: true, definition: first }, { expression: true, definition: second }],
      },
    ]);

    expect(result.repairedKeys).toBe(2);
    expect(result.source).toContain(`sql\`${first}\`, sql\`${second}\``);
  });

  it('leaves the declaration unchanged when the catalog key count disagrees', () => {
    const result = repairTruncatedIndexExpressions(truncatedFixture, [
      { ...recoveryRow, keys: recoveryRow.keys.slice(0, 2) },
    ]);

    expect(result).toMatchObject({ matched: 0, changed: 0, repairedKeys: 0, skipped: 1 });
    expect(result.source).toBe(truncatedFixture);
  });

  it('never replaces a fragment that is not a prefix of the catalog definition', () => {
    const result = repairTruncatedIndexExpressions(truncatedFixture, [
      {
        ...recoveryRow,
        keys: [
          recoveryRow.keys[0],
          { expression: true, definition: "((payload ->> 'somethingElse'::text))" },
          recoveryRow.keys[2],
        ],
      },
    ]);

    expect(result.repairedKeys).toBe(1);
    expect(result.source).toContain(`sql\`${operationIdKey.slice(0, 63)}\``);
    expect(result.source).toContain(`sql\`${callerIdKey}\``);
  });

  it('escapes template-literal metacharacters in a restored definition', () => {
    const definition = "(((payload -> 'blueprintOperation'::text) ->> 'operationId'::text) || '`${x}\\\\')";
    const result = repairTruncatedIndexExpressions(truncatedFixture, [
      { ...recoveryRow, keys: [recoveryRow.keys[0], { expression: true, definition }, recoveryRow.keys[2]] },
    ]);

    expect(result.repairedKeys).toBe(2);
    expect(result.source).toContain("'operationId'::text) || '\\`\\${x}\\\\\\\\')`");
  });

  it('is idempotent', () => {
    const once = repairTruncatedIndexExpressions(truncatedFixture, [recoveryRow]);
    const twice = repairTruncatedIndexExpressions(once.source, [recoveryRow]);

    expect(twice).toMatchObject({ matched: 1, changed: 0, repairedKeys: 0 });
    expect(twice.source).toBe(once.source);
  });
});

/**
 * Every sql`` fragment whose parentheses do not balance outside single-quoted
 * SQL literals. drizzle-kit cuts index expression keys at 63 bytes
 * (coalesce(attname, pg_get_indexdef(...)) is typed `name`) and over-strips some
 * CHECK bodies; both leave unbalanced fragments behind.
 */
function unbalancedSqlFragments(source: string): { total: number; unbalanced: string[] } {
  const fragment = /sql`((?:[^`\\]|\\.)*)`/g;
  const unbalanced: string[] = [];
  let total = 0;
  for (const match of source.matchAll(fragment)) {
    total += 1;
    let depth = 0;
    let inLiteral = false;
    let ok = true;
    for (const ch of match[1]) {
      if (ch === "'") inLiteral = !inLiteral;
      if (inLiteral) continue;
      if (ch === '(') depth += 1;
      else if (ch === ')' && --depth < 0) ok = false;
    }
    if (!ok || depth !== 0) unbalanced.push(match[1].slice(0, 120));
  }
  return { total, unbalanced };
}

describe('generated.ts sql fragment integrity (WI-6554700010008565)', () => {
  it('detects a 63-byte-truncated key and ignores parentheses inside literals', () => {
    const truncated = `index("x").using("btree", sql\`${"split_part((((launch_spec -> 'acceptedOperation'::text) -> 'pin".slice(0, 63)}\`)`;
    const literal = `check("y", sql\`status <> '(('::text\`)`;

    expect(unbalancedSqlFragments(truncated).unbalanced).toHaveLength(1);
    expect(unbalancedSqlFragments(literal)).toEqual({ total: 1, unbalanced: [] });
  });

  it('keeps every sql fragment in the committed generated mirror paren-balanced', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');
    const result = unbalancedSqlFragments(generated);

    expect(result.total).toBeGreaterThan(500);
    expect(result.unbalanced).toEqual([]);
  });
});

describe('stripConcurrentBuildLeftoverIndexes (WI-6554700010008628)', () => {
  const source = [
    '\tindex("route_invocations_ws_time_idx").using("btree", table.workspaceId.asc()),',
    '\tindex("route_invocations_ws_time_idx_ccnew").using("btree", table.workspaceId.asc()),',
    '\tuniqueIndex("shared_presence_pkey_ccnew").using("btree", table.workspaceId.asc()),',
    '\tindex("carry_notes_bm25_ccold1").using("bm25", sql`COALESCE(note, \'\'::text)`),',
    '\tindex("ccnew_is_not_a_suffix_here").using("btree", table.id.asc()),',
    '',
  ].join('\n');

  it('removes only *_ccnew / *_ccold[N] declarations and is idempotent', () => {
    const once = stripConcurrentBuildLeftoverIndexes(source);

    expect(once.stripped).toEqual([
      'route_invocations_ws_time_idx_ccnew',
      'shared_presence_pkey_ccnew',
      'carry_notes_bm25_ccold1',
    ]);
    expect(once.source).toContain('index("route_invocations_ws_time_idx")');
    expect(once.source).toContain('index("ccnew_is_not_a_suffix_here")');
    expect(stripConcurrentBuildLeftoverIndexes(once.source)).toEqual({ source: once.source, stripped: [] });
  });
});
