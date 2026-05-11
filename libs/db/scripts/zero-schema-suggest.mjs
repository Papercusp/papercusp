#!/usr/bin/env node
/**
 * Suggest a Zero schema entry for a single PG table — useful when adding
 * a new table that needs to be published via Zero. Reads the introspected
 * `generated.ts`, runs drizzle-zero against just that table, and prints
 * the entry you can paste into libs/zero-harness/src/schema.ts.
 *
 * Usage:
 *   node libs/papercusp/libs/db/scripts/zero-schema-suggest.mjs <pg_table_name>
 *
 * Example:
 *   node …/zero-schema-suggest.mjs harness_design_artifacts
 *
 * Output:
 *   // ── harness_shared.harness_design_artifacts ───
 *   export const harnessDesignArtifacts = table('harnessDesignArtifacts')
 *     .from('harness_shared.harness_design_artifacts')
 *     .columns({ id: string(), ... })
 *     .primaryKey('id', 'harnessSlug');
 *
 * Why not auto-cutover the whole schema? See PHASE0-AUDIT.md: hand-written
 * `libs/zero-harness/src/schema.ts` uses camelCase aliases that drizzle-zero
 * doesn't preserve. This tool helps maintain it semi-automatically.
 */
import { drizzleZeroConfig } from 'drizzle-zero';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '../src/schema');

const target = process.argv[2];
if (!target) {
  console.error('usage: zero-schema-suggest.mjs <pg_table_name>');
  process.exit(1);
}

// Snake → camel for column names (matches hand-written convention).
function camelize(s) {
  return s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

// Singularize the Drizzle export name back to the PG table name.
// `harness_design_artifactsInHarness_shared` → `harness_design_artifacts`.
function pgTableFromDrizzleKey(key) {
  return key
    .replace(/InHarness_shared$/, '')
    .replace(/InPapercup_shared$/, '');
}

const schemaModule = await import(`${SCHEMA_DIR}/generated.ts`);
const relationsModule = await import(`${SCHEMA_DIR}/generated-relations.ts`);
const combined = { ...schemaModule, ...relationsModule };

let config;
try {
  config = drizzleZeroConfig(combined);
} catch (err) {
  console.error('drizzle-zero failed:', err.message);
  process.exit(1);
}

let match = null;
for (const [drizzleKey, tableConfig] of Object.entries(config.tables)) {
  if (pgTableFromDrizzleKey(drizzleKey) === target) {
    match = { drizzleKey, tableConfig };
    break;
  }
}

if (!match) {
  console.error(`table '${target}' not found in introspected schema`);
  console.error('available targets:');
  for (const k of Object.keys(config.tables).slice(0, 20)) {
    console.error(`  ${pgTableFromDrizzleKey(k)}`);
  }
  process.exit(1);
}

const { drizzleKey, tableConfig } = match;
const pgSchema = drizzleKey.endsWith('InHarness_shared')
  ? 'harness_shared'
  : 'papercup_shared';

const camelTableName = camelize(target);
const lines = [];
lines.push(`// ── ${pgSchema}.${target} ──`);
lines.push(`export const ${camelTableName} = table('${camelTableName}')`);
lines.push(`  .from('${pgSchema}.${target}')`);
lines.push(`  .columns({`);

const cols = tableConfig.columns ?? {};
const pkCols = Array.isArray(tableConfig.primaryKey)
  ? tableConfig.primaryKey
  : [tableConfig.primaryKey].filter(Boolean);

for (const [pgCol, colConfig] of Object.entries(cols)) {
  const camelCol = camelize(pgCol);
  const zeroType = colConfig.type ?? 'string';
  const optional = colConfig.optional ? '.optional()' : '';
  const fromClause = camelCol !== pgCol ? `.from('${pgCol}')` : '';
  lines.push(`    ${camelCol}: ${zeroType}()${optional}${fromClause},`);
}

lines.push(`  })`);
if (pkCols.length > 0) {
  const camelPks = pkCols.map((c) => `'${camelize(c)}'`).join(', ');
  lines.push(`  .primaryKey(${camelPks});`);
} else {
  lines.push(`  ;  // ⚠ no primary key declared — Zero requires one`);
}

console.log(lines.join('\n'));
console.log();
console.log('// Paste into libs/zero-harness/src/schema.ts and add to');
console.log('// the schema export at the bottom. Then add named queries');
console.log('// to libs/zero-harness/src/queries.ts.');
