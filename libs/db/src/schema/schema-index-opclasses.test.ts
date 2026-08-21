import { describe, expect, it } from 'vitest';
import { repairIndexOperatorClasses } from './schema-index-opclasses.mjs';

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
