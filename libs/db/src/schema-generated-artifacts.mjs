import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TABLE_DECLARATION =
  /^export const ([A-Za-z_$][\w$]*) = (?:[A-Za-z_$][\w$]*\.table|pgTable)\(/gm;
const NEXT_EXPORT = '\nexport const ';
const FOREIGN_TABLE_REFERENCE =
  /foreignColumns:\s*\[\s*([A-Za-z_$][\w$]*)\./g;
const UNTYPED_EXTRA_CONFIG = '}, (table) => [';
const TYPED_EXTRA_CONFIG = '}, (table): PgTableExtraConfigValue[] => [';

/**
 * Break TypeScript's inference cycle for mutually-referencing composite FKs.
 *
 * drizzle-kit renders composite foreign keys in table extra-config callbacks.
 * When table A references table B and B references A, TypeScript must infer A
 * while it is still inferring B (TS7022/TS7024). Drizzle's supported escape
 * hatch for circular schema inference is an explicit type boundary; for a
 * composite FK, the boundary belongs on the extra-config callback rather than
 * on an individual column.
 *
 * The transform discovers cycles from the generated foreignColumns clauses and
 * annotates only tables that participate in one. It is intentionally generic:
 * a later migration that introduces another mutual composite FK is covered by
 * the same generator fix instead of adding another table-name allow-list.
 *
 * @param {string} source drizzle-kit's generated schema source
 * @returns {{ schema: string, circularTables: string[] }}
 */
export function annotateCircularForeignKeyExtraConfigs(source) {
  const matches = [...source.matchAll(TABLE_DECLARATION)];
  /** @type {Map<string, { name: string, start: number, end: number, block: string }>} */
  const tables = new Map();

  for (const match of matches) {
    const name = match[1];
    const start = match.index;
    const next = source.indexOf(NEXT_EXPORT, start + match[0].length);
    const end = next === -1 ? source.length : next + 1;
    tables.set(name, { name, start, end, block: source.slice(start, end) });
  }

  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  for (const table of tables.values()) {
    const dependencies = new Set(
      [...table.block.matchAll(FOREIGN_TABLE_REFERENCE)]
        .map((match) => match[1])
        .filter((name) => tables.has(name)),
    );
    edges.set(table.name, dependencies);
  }

  /**
   * @param {string} current
   * @param {string} target
   * @param {Set<string>} seen
   */
  function reaches(current, target, seen) {
    if (current === target) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    for (const dependency of edges.get(current) ?? []) {
      if (reaches(dependency, target, seen)) return true;
    }
    return false;
  }

  const circularTables = [...tables.values()]
    .filter((table) =>
      [...(edges.get(table.name) ?? [])].some((dependency) =>
        reaches(dependency, table.name, new Set()),
      ),
    )
    .map((table) => table.name);

  if (circularTables.length === 0) return { schema: source, circularTables };

  let schema = source;
  const circularSet = new Set(circularTables);
  const reverseBlocks = [...tables.values()]
    .filter((table) => circularSet.has(table.name))
    .sort((a, b) => b.start - a.start);

  for (const table of reverseBlocks) {
    if (table.block.includes(TYPED_EXTRA_CONFIG)) continue;
    if (!table.block.includes(UNTYPED_EXTRA_CONFIG)) {
      throw new Error(
        `Circular composite-FK table ${table.name} has no generated array extra-config callback to annotate`,
      );
    }
    const patched = table.block.replace(UNTYPED_EXTRA_CONFIG, TYPED_EXTRA_CONFIG);
    schema = schema.slice(0, table.start) + patched + schema.slice(table.end);
  }

  if (!schema.includes('type PgTableExtraConfigValue')) {
    const importPattern = /(import \{[^\n]*)( \} from "drizzle-orm\/pg-core")/;
    if (!importPattern.test(schema)) {
      throw new Error('Generated schema has no single-line drizzle-orm/pg-core import to extend');
    }
    schema = schema.replace(
      importPattern,
      '$1, type PgTableExtraConfigValue$2',
    );
  }

  return { schema, circularTables };
}

/**
 * Promote drizzle-kit's temporary schema artifacts, then remove the ignored
 * source names so the package typecheck cannot compile a stale second mirror.
 * Copy-before-remove keeps a failed promotion recoverable.
 *
 * @param {{ schemaPath: string, relationsPath: string, schemaDir: string }} input
 * @returns {{ generatedSchemaPath: string, generatedRelationsPath: string | null }}
 */
export function promoteGeneratedSchemaArtifacts({ schemaPath, relationsPath, schemaDir }) {
  const generatedSchemaPath = join(schemaDir, 'generated.ts');
  const generatedRelationsPath = join(schemaDir, 'generated-relations.ts');
  if (resolve(schemaPath) === resolve(generatedSchemaPath)) {
    throw new Error('Refusing to promote a schema artifact onto itself');
  }

  copyFileSync(schemaPath, generatedSchemaPath);
  const promotedRelations = existsSync(relationsPath);
  if (promotedRelations) copyFileSync(relationsPath, generatedRelationsPath);

  rmSync(schemaPath, { force: true });
  if (promotedRelations) rmSync(relationsPath, { force: true });

  return {
    generatedSchemaPath,
    generatedRelationsPath: promotedRelations ? generatedRelationsPath : null,
  };
}
