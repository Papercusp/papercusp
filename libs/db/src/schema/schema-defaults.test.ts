import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairEmptyArrayDefaults } from './schema-defaults.mjs';

describe('repairEmptyArrayDefaults', () => {
  it('turns drizzle-kits one-empty-string rendering into a real empty array', () => {
    const source = `
      clientScope: text("client_scope").array().default([""]).notNull(),
      anchorPaths: text("anchor_paths").array().default([""]).notNull(),
    `;

    const repaired = repairEmptyArrayDefaults(source);

    expect(repaired.fixed).toBe(2);
    expect(repaired.schema).toContain(
      'text("client_scope").array().default([]).notNull()',
    );
    expect(repaired.schema).not.toMatch(/\.array\(\)\.default\(\[""\]\)/);
  });

  it('does not alter non-empty array or scalar defaults', () => {
    const source = `
      labels: text("labels").array().default(["system"]).notNull(),
      status: text("status").default("").notNull(),
    `;

    expect(repairEmptyArrayDefaults(source)).toEqual({ schema: source, fixed: 0 });
  });

  it('is idempotent after the empty-array rendering is repaired', () => {
    const once = repairEmptyArrayDefaults(
      'clientScope: text("client_scope").array().default([""]).notNull(),',
    );

    expect(repairEmptyArrayDefaults(once.schema)).toEqual({
      schema: once.schema,
      fixed: 0,
    });
  });

  it('keeps the committed generated schema free of the unfixed rendering', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');

    expect(generated).not.toMatch(/\.array\(\)\.default\(\[""\]\)/);
  });
});
