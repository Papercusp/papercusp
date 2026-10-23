import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { getTableColumns } from 'drizzle-orm';
import * as ts from 'typescript';
import { repairUnconstrainedVectorColumns } from './schema-vector-columns.mjs';

const source = `import { pgTable, vector } from 'drizzle-orm/pg-core';
export const sample = pgTable('sample', {
  embedding: vector().notNull(),
  named: vector('named_vector'),
  fixed: vector({ dimensions: 4 }),
});`;

describe('unconstrained vector schema projection', () => {
  it('constructs the projected schema in real Drizzle and preserves width-free vector serialization', () => {
    const repaired = repairUnconstrainedVectorColumns(source);
    expect(repaired.fixed).toBe(2);
    expect(repaired.schema).toContain('fixed: vector({ dimensions: 4 })');
    const output = ts.transpileModule(repaired.schema, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: Record<string, any> = {};
    new Function('require', 'exports', output)(createRequire(import.meta.url), exports);
    const columns = getTableColumns(exports.sample);
    expect(columns.embedding.getSQLType()).toBe('vector');
    expect(columns.named.name).toBe('named_vector');
    expect(columns.fixed.getSQLType()).toBe('vector(4)');
    expect(columns.embedding.mapToDriverValue([1, .25, -3])).toBe('[1,0.25,-3]');
    expect(columns.embedding.mapFromDriverValue('[1,0.25,-3]')).toEqual([1, .25, -3]);
  });
  it('is idempotent and does not change constrained vectors or unrelated calls', () => {
    const once = repairUnconstrainedVectorColumns(source);
    expect(repairUnconstrainedVectorColumns(once.schema)).toEqual({ schema: once.schema, fixed: 0 });
    const fixed = 'embedding: vector("embedding", { dimensions: 768 }),';
    expect(repairUnconstrainedVectorColumns(fixed)).toEqual({ schema: fixed, fixed: 0 });
  });
  it('fails visibly rather than emitting an unresolved custom column helper', () => {
    expect(() => repairUnconstrainedVectorColumns('embedding: vector(),')).toThrow('pg-core import');
  });
});
