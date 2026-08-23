import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairNotValidChecks } from './schema-checks.mjs';

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
