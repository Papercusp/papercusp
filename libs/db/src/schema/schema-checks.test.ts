import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairCheckPrefixes, repairNotValidChecks } from './schema-checks.mjs';

describe('repairCheckPrefixes', () => {
  it("restores a function-call check whose closers drizzle-kit's `))` strip removed", () => {
    // pg_get_constraintdef: CHECK (harness_shared.valid_mapping(datatype_mappings))
    const source = `check("data_sources_datatype_mappings_chk", sql\`CHECK (harness_shared.valid_mapping(datatype_mappings\`),`;

    const repaired = repairCheckPrefixes(source);

    expect(repaired.fixed).toBe(1);
    expect(repaired.source).toBe(
      `check("data_sources_datatype_mappings_chk", sql\`harness_shared.valid_mapping(datatype_mappings)\`),`,
    );
  });

  it('strips the kept prefix from balanced bodies (bare column, CASE expression)', () => {
    const source = `
      check("singleton_check", sql\`CHECK (singleton)\`),
      check("case_check", sql\`CHECK (\nCASE\n    WHEN (kind = 'tool'::text) THEN (state IS NOT NULL)\n    ELSE (state IS NULL)\nEND)\`),
    `;

    const repaired = repairCheckPrefixes(source);

    expect(repaired.fixed).toBe(2);
    expect(repaired.source).toContain('check("singleton_check", sql`singleton`)');
    expect(repaired.source).toContain(
      "sql`\nCASE\n    WHEN (kind = 'tool'::text) THEN (state IS NOT NULL)\n    ELSE (state IS NULL)\nEND`",
    );
  });

  it('composes after repairNotValidChecks for a NOT VALID function-call check', () => {
    const source = `check("pending_fn", sql\`CHECK (harness_shared.valid_mapping(mappings)) NOT VALID\`),`;

    const repaired = repairCheckPrefixes(repairNotValidChecks(source).source);

    expect(repaired.source).toBe(`check("pending_fn", sql\`harness_shared.valid_mapping(mappings)\`),`);
  });

  it('leaves ordinary and unrecognizable bodies unchanged, and is idempotent', () => {
    const source = `
      check("ordinary", sql\`status = 'CHECK (x'::text\`),
      check("over_closed", sql\`CHECK (value))\`),
    `;
    expect(repairCheckPrefixes(source)).toEqual({ source, fixed: 0 });

    const once = repairCheckPrefixes(`check("fn", sql\`CHECK (f(g(x)\`),`);
    expect(once.source).toBe(`check("fn", sql\`f(g(x))\`),`);
    expect(repairCheckPrefixes(once.source)).toEqual({ source: once.source, fixed: 0 });
  });

  // WI-6554700010008565: the committed mirror carried 9 checks with a kept
  // `CHECK (` prefix (4 of them paren-unbalanced) until pull-schema gained Fix 11b.
  it('keeps the committed generated mirror free of kept CHECK ( prefixes', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');

    expect(generated).toMatch(/check\("[^"]+", sql`/);
    expect(repairCheckPrefixes(generated)).toEqual({ source: generated, fixed: 0 });
  });
});

describe('repairNotValidChecks', () => {
  it('drops NOT VALID and removes drizzle-kits unmatched trailing closers', () => {
    const source = `check("goals_budget_window_sec_positive", sql\`(budget_window_sec IS NULL) OR (budget_window_sec > 0))) NOT VALID\`),`;

    const repaired = repairNotValidChecks(source);

    expect(repaired.fixed).toBe(1);
    expect(repaired.source).toBe(
      `check("goals_budget_window_sec_positive", sql\`(budget_window_sec IS NULL) OR (budget_window_sec > 0)\`),`,
    );
  });

  it('balances nested expressions without counting parentheses in SQL literals', () => {
    const source = `
      check("nested", sql\`((label = 'value (with parens)') AND (enabled = true))) NOT VALID\`),
      check("ordinary", sql\`status = 'NOT VALID'\`),
    `;

    const repaired = repairNotValidChecks(source);

    expect(repaired.fixed).toBe(1);
    expect(repaired.source).toContain(
      `sql\`((label = 'value (with parens)') AND (enabled = true))\``,
    );
    expect(repaired.source).toContain(`sql\`status = 'NOT VALID'\``);
  });

  it('leaves validated checks unchanged and is idempotent', () => {
    const source = `
      check("validated", sql\`(budget_window_sec IS NULL) OR (budget_window_sec > 0)\`),
    `;

    expect(repairNotValidChecks(source)).toEqual({ source, fixed: 0 });

    const once = repairNotValidChecks(
      `check("pending", sql\`(value > 0))) NOT VALID\`),`,
    );
    expect(repairNotValidChecks(once.source)).toEqual({
      source: once.source,
      fixed: 0,
    });
  });

  it('keeps the committed generated mirror free of NOT VALID check bodies', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');

    expect(repairNotValidChecks(generated)).toEqual({
      source: generated,
      fixed: 0,
    });
  });
});
