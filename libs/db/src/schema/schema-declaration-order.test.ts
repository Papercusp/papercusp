import { describe, expect, it } from 'vitest';
import { sortPgCoreImportSpecifiers, sortTopLevelDeclarations } from './schema-declaration-order.mjs';

// Two fixtures with the SAME four declarations (two schemas, two tables) in
// deliberately different original orders — the point of sortTopLevelDeclarations
// is that catalog-order churn (EI-22145279419639902) must not matter: both must
// converge to byte-identical output.
const fixtureUnsortedA = `import { pgSchema, text } from "drizzle-orm/pg-core"

export const zSchema = pgSchema("z_schema");
export const zTable = zSchema.table("some_table", {
  id: text("id"),
});
export const aSchema = pgSchema("a_schema");
export const aTable = aSchema.table("some_table", {
  id: text("id"),
});
`;

const fixtureUnsortedB = `import { pgSchema, text } from "drizzle-orm/pg-core"

export const aSchema = pgSchema("a_schema");
export const aTable = aSchema.table("some_table", {
  id: text("id"),
});
export const zSchema = pgSchema("z_schema");
export const zTable = zSchema.table("some_table", {
  id: text("id"),
});
`;

describe('sortTopLevelDeclarations', () => {
  it('reorders two differently-ordered inputs with the same declarations to identical output', () => {
    const resultA = sortTopLevelDeclarations(fixtureUnsortedA);
    const resultB = sortTopLevelDeclarations(fixtureUnsortedB);

    expect(resultA.declarationCount).toBe(4);
    expect(resultB.declarationCount).toBe(4);
    expect(resultA.source).toBe(resultB.source);

    // schema kind sorts before table kind; within a kind, by (schemaObj, name).
    const idx = (s: string) => resultA.source.indexOf(s);
    expect(idx('export const aSchema')).toBeLessThan(idx('export const zSchema'));
    expect(idx('export const zSchema')).toBeLessThan(idx('export const aTable'));
    expect(idx('export const aTable')).toBeLessThan(idx('export const zTable'));
  });

  it('is idempotent: re-sorting already-sorted output is a true no-op', () => {
    const once = sortTopLevelDeclarations(fixtureUnsortedA);
    expect(once.changed).toBe(true);

    const twice = sortTopLevelDeclarations(once.source);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
    expect(twice.declarationCount).toBe(once.declarationCount);
  });

  it('passes an unrecognized top-level declaration through unchanged, appended after every recognized block', () => {
    const fixture = `import { pgSchema, text } from "drizzle-orm/pg-core"

export const zSchema = pgSchema("z_schema");
export const SOME_CONSTANT = 42;
export const aSchema = pgSchema("a_schema");
`;

    const result = sortTopLevelDeclarations(fixture);
    expect(result.declarationCount).toBe(3);
    expect(result.source).toContain('export const SOME_CONSTANT = 42;');

    const idx = (s: string) => result.source.indexOf(s);
    // Recognized blocks are sorted first (aSchema before zSchema)...
    expect(idx('export const aSchema')).toBeLessThan(idx('export const zSchema'));
    // ...and the unrecognized block trails every recognized+sorted block.
    expect(idx('export const zSchema')).toBeLessThan(idx('export const SOME_CONSTANT'));
  });

  it('is a no-op when the source has no top-level export const declarations', () => {
    const fixture = 'import { pgSchema } from "drizzle-orm/pg-core"\n';
    const result = sortTopLevelDeclarations(fixture);
    expect(result).toEqual({ source: fixture, changed: false, declarationCount: 0 });
  });
});

describe('sortPgCoreImportSpecifiers', () => {
  it('sorts named imports alphabetically, ignoring the `type` keyword on `type X` specifiers', () => {
    const fixture = 'import { timestamp, text, type PgColumn, index } from "drizzle-orm/pg-core"';
    const result = sortPgCoreImportSpecifiers(fixture);
    expect(result.changed).toBe(true);
    expect(result.source).toBe(
      'import { type PgColumn, index, text, timestamp } from "drizzle-orm/pg-core"',
    );
  });

  it('is a no-op when the specifiers are already sorted', () => {
    const fixture = 'import { type PgColumn, index, text, timestamp } from "drizzle-orm/pg-core"';
    const result = sortPgCoreImportSpecifiers(fixture);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(fixture);
  });

  it('is a no-op when no drizzle-orm/pg-core import line is present', () => {
    const fixture = 'export const x = 1;\n';
    const result = sortPgCoreImportSpecifiers(fixture);
    expect(result).toEqual({ source: fixture, changed: false });
  });
});
