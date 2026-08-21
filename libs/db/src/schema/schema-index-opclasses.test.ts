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
});

