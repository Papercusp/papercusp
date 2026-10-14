import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairEmptyArrayDefaults, repairRawSqlCallDefaults } from './schema-defaults.mjs';

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

describe('repairRawSqlCallDefaults (WI-6554700010011854)', () => {
  it('wraps the cast-dropped uuid default drizzle-kit emits for DEFAULT gen_random_uuid()::text', () => {
    const source =
      'delegationId: text("delegation_id").default((gen_random_uuid())).primaryKey().notNull(),';

    const repaired = repairRawSqlCallDefaults(source);

    expect(repaired.fixed).toBe(1);
    expect(repaired.schema).toBe(
      'delegationId: text("delegation_id").default(sql`(gen_random_uuid())`).primaryKey().notNull(),',
    );
  });

  it('wraps a bare call without parentheses and unescapes quoted arguments', () => {
    const source = [
      'createdAt: timestamp("created_at").default(now()),',
      "month: text(\"month\").default(to_char(now(), \\'YYYY-MM\\'::text)),",
    ].join('\n');

    const repaired = repairRawSqlCallDefaults(source);

    expect(repaired.fixed).toBe(2);
    expect(repaired.schema).toContain('.default(sql`now()`)');
    expect(repaired.schema).toContain(".default(sql`to_char(now(), 'YYYY-MM'::text)`)");
  });

  it('leaves JS literals, member calls and existing sql`` defaults untouched', () => {
    const source = [
      'a: integer("a").default(0),',
      'b: boolean("b").default(true),',
      'c: text("c").default("x(y)"),',
      'd: jsonb("d").default({}),',
      'e: bigint("e").default(Date.now()),',
      'f: text("f").default(sql`(gen_random_uuid())::text`),',
      "g: text(\"g\").default(sql`('RG-'::text || (gen_random_uuid())::text)`),",
    ].join('\n');

    expect(repairRawSqlCallDefaults(source)).toEqual({ schema: source, fixed: 0 });
  });

  it('is idempotent once the call is wrapped', () => {
    const once = repairRawSqlCallDefaults('x: text("x").default((gen_random_uuid())),');

    expect(repairRawSqlCallDefaults(once.schema)).toEqual({ schema: once.schema, fixed: 0 });
  });

  it('keeps the committed generated schema free of raw SQL call defaults', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');

    expect(repairRawSqlCallDefaults(generated).fixed).toBe(0);
  });
});
