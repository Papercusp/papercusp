import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  repairClippedArrayLiteralDefaults,
  repairEmptyArrayDefaults,
  repairPlanRunsOwnedSequence,
  repairRawSqlCallDefaults,
} from './schema-defaults.mjs';
import { findDroppedPgSchemaObjects } from './schema-policies.mjs';

describe('repairPlanRunsOwnedSequence', () => {
  const other = [
    'export const other = harnessShared.table("other", {',
    '\tid: bigserial({ mode: "bigint" }).primaryKey().notNull(),',
    '});',
  ].join('\n');
  const planRuns = [
    'export const planRunsInHarnessShared = harnessShared.table("plan_runs", {',
    '\tid: bigserial({ mode: "bigint" }).primaryKey().notNull(),',
    '});',
  ].join('\n');
  const source = [other, planRuns].join('\n');
  const sequence = {
    startWith: '7', increment: '2', minValue: '1', maxValue: '9223372036854775807', cache: '4', cycle: true,
  };
  const previous = 'export const planRunsIdSeqInHarnessShared = harnessShared.sequence("plan_runs_id_seq", {})';

  it('retains the exact catalog options and the numeric ID without changing unrelated serial columns', () => {
    const repaired = repairPlanRunsOwnedSequence(source, sequence);

    expect(repaired).toContain('harnessShared.sequence("plan_runs_id_seq", {  startWith: "7", increment: "2", minValue: "1", maxValue: "9223372036854775807", cache: "4", cycle: true })');
    expect(repaired).toContain('id: bigint({ mode: "number" }).default(sql`nextval(\'harness_shared.plan_runs_id_seq\'::regclass)`).primaryKey().notNull(),');
    expect(repaired).toContain(other);
    expect(findDroppedPgSchemaObjects({ previous, next: repaired })).toEqual([]);
    expect(repairPlanRunsOwnedSequence(repaired, sequence)).toBe(repaired);
  });

  it('keeps the guard active when either the catalog binding or the serial column is missing', () => {
    const differentColumn = [other, planRuns.replace('bigserial', 'bigint')].join('\n');
    const expected = ['sequence:harness_shared.plan_runs_id_seq'];

    expect(findDroppedPgSchemaObjects({ previous, next: repairPlanRunsOwnedSequence(source, undefined) })).toEqual(expected);
    expect(findDroppedPgSchemaObjects({ previous, next: repairPlanRunsOwnedSequence(differentColumn, sequence) })).toEqual(expected);
  });
});

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

describe('repairClippedArrayLiteralDefaults (migration 1638 reasons default)', () => {
  it('restores a clipped single-element ARRAY[...::text] default as sql``', () => {
    const source = `
	reasons: text().array().default(["RAY['explicit'::tex"]),
	capabilities: text().array().default(["RAY['*'::tex"]).notNull(),
    `;

    const repaired = repairClippedArrayLiteralDefaults(source);

    expect(repaired.fixed).toBe(2);
    expect(repaired.schema).toContain("reasons: text().array().default(sql`ARRAY['explicit'::text]`),");
    expect(repaired.schema).toContain("capabilities: text().array().default(sql`ARRAY['*'::text]`).notNull(),");
    expect(repaired.schema).not.toContain('"RAY[');
  });

  it('restores a multi-element literal with every element kept', () => {
    const repaired = repairClippedArrayLiteralDefaults(
      `kinds: text().array().default(["RAY['a'::text, 'b'::tex"]),`,
    );

    expect(repaired).toEqual({
      schema: "kinds: text().array().default(sql`ARRAY['a'::text, 'b'::text]`),",
      fixed: 1,
    });
  });

  it('leaves a clipped non-text cast alone, since its clipped letter is unknown', () => {
    const source = `codes: varchar().array().default(["RAY['x'::character varyin"]),`;

    expect(repairClippedArrayLiteralDefaults(source)).toEqual({ schema: source, fixed: 0 });
  });

  it('does not touch ordinary array defaults and is idempotent', () => {
    const source = `
      labels: text("labels").array().default(["system"]).notNull(),
      tags: text().array().default([]).notNull(),
    `;
    expect(repairClippedArrayLiteralDefaults(source)).toEqual({ schema: source, fixed: 0 });

    const once = repairClippedArrayLiteralDefaults(`r: text().array().default(["RAY['explicit'::tex"]),`);
    expect(repairClippedArrayLiteralDefaults(once.schema)).toEqual({ schema: once.schema, fixed: 0 });
  });

  it('keeps the committed generated schema free of any clipped ARRAY[...] default', () => {
    const generated = readFileSync(join(__dirname, 'generated.ts'), 'utf8');

    expect(generated).not.toMatch(/\.default\(\["RAY\[/);
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
