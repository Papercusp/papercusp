#!/usr/bin/env node
/**
 * Regenerate src/schema/generated.ts + generated-relations.ts from the
 * live `papercusp` database. Run after any new `.sql` migration in ./sql/.
 *
 * Usage: node libs/papercusp/libs/db/scripts/pull-schema.mjs
 *
 * After running:
 *   1. Inspect the diff in src/schema/generated.ts
 *   2. If the diff is intentional, commit it. If not, investigate the
 *      `.sql` migration that caused it.
 *
 * CI runs this and fails if the diff is non-empty (proves source-of-truth
 * is `.sql`, schema/generated.ts is a mirror).
 *
 * Quirks of drizzle-kit v0.31.10 we work around:
 *   - empty-string defaults emit `.default(')` (invalid TS). We rewrite
 *     to `.default('')` after pull.
 *   - tsvector + bytea types emit `unknown(...)` with TODO comments;
 *     keep those — they're harmless because we never write to tsvector
 *     columns from app code.
 *   - `timestamp(..., mode: 'string')` is drizzle-kit's default. The
 *     Zero replica requires `mode: 'number'` for timestamptz (see
 *     memory feedback_zero_pg_timestamptz.md). We rewrite to 'number'
 *     after pull.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync as spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(__dirname, '..');
const SCHEMA_DIR = join(DB_ROOT, 'src/schema');

console.log('==> running drizzle-kit pull against live papercusp DB');

const tmpOut = mkdtempSync(join(tmpdir(), 'drizzle-pull-'));
const result = spawnSync(
  'npx',
  ['-y', 'drizzle-kit@^0.31.10', 'introspect', '--config=' + join(DB_ROOT, 'drizzle.config.ts')],
  { cwd: DB_ROOT, stdio: 'inherit', env: { ...process.env } },
);
if (result.status !== 0) {
  console.error('drizzle-kit pull failed');
  process.exit(result.status ?? 1);
}

// drizzle-kit writes to ./src/schema/ per drizzle.config.ts `out`.
// Apply quirks fixups.
const schemaPath = join(SCHEMA_DIR, 'schema.ts');
const relationsPath = join(SCHEMA_DIR, 'relations.ts');
if (!existsSync(schemaPath)) {
  console.error('expected drizzle-kit to write src/schema/schema.ts');
  process.exit(1);
}

console.log('==> applying quirk fixups');
let schema = readFileSync(schemaPath, 'utf8');

// Fix 1: empty-string default rendering bug.
const before = schema.length;
schema = schema
  .replace(/\.default\('\)\./g, ".default('').")
  .replace(/\.default\('\)\,/g, ".default(''),")
  .replace(/\.default\('\)$/gm, ".default('')");
const fixedDefaults = (schema.match(/\.default\(''\)/g) ?? []).length;

// Fix 2: timestamp mode 'string' → 'number' for Zero compatibility.
schema = schema.replace(
  /timestamp\(\{ withTimezone: true, mode: 'string' \}\)/g,
  "timestamp({ withTimezone: true, mode: 'number' })",
);
const fixedTimestamps = (
  schema.match(/timestamp\(\{ withTimezone: true, mode: 'number' \}\)/g) ?? []
).length;

// Fix 3: function-call defaults emit as raw JS instead of sql`...` wrapping.
// E.g. drizzle-kit emits  .default(to_char(now(), \'YYYY-MM\'::text))  which
// references undeclared `to_char` and `now` identifiers. Wrap any line with
// a backslash-escaped apostrophe inside a default() in sql`...`.
let fixedFnDefaults = 0;
schema = schema.replace(
  /\.default\(([^()]*\\'[^()]*(?:\([^()]*\))*[^()]*)\)/g,
  (_match, expr) => {
    fixedFnDefaults++;
    const unescaped = expr.replace(/\\'/g, "'");
    return `.default(sql\`${unescaped}\`)`;
  },
);

// Fix 4: `unknown(...)` emitted for tsvector + bytea columns (drizzle-kit
// has no built-in mapping). `unknown` is a TS type, not a value — TS would
// reject the file. We don't read these from app code (tsvector is FTS-only,
// bytea is write-only or generated). Treat them as text() so drizzle's
// type-check is happy and index references stay valid. Raw SQL still
// reads/writes the actual underlying PG type.
let fixedUnknownCols = 0;
schema = schema.replace(/\w+: unknown\(/g, (match) => {
  fixedUnknownCols++;
  return match.replace('unknown(', 'text(');
});

// Fix 5: drizzle-kit v0.31.10 drops composite primary keys during pull.
// Re-query PG and inject any missing `primaryKey({ columns: [...] })` into
// the table-config callback. Without this, drizzle-zero refuses to generate
// (~"No primary keys found in table") and `.db.insert(...).onConflictDo*`
// can't target the upsert constraint.
//
// Uses `psql -tA` with the same DATABASE_URL the pull config used.
const dbUrl =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
const pkQuery = `
  SELECT n.nspname, t.relname,
    string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
  WHERE c.contype='p' AND n.nspname IN ('harness_shared','papercup_shared')
    AND array_length(c.conkey, 1) > 1
  GROUP BY n.nspname, t.relname
  ORDER BY 1, 2;
`;
const psql = spawn('psql', [dbUrl, '-tA', '-F', '|', '-c', pkQuery], {
  encoding: 'utf8',
});
let fixedMissingPks = 0;
if (psql.status === 0) {
  const compositePks = psql.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [schemaName, tableName, colsCsv] = line.split('|');
      return { schemaName, tableName, cols: colsCsv.split(',') };
    });

  for (const { schemaName, tableName, cols } of compositePks) {
    const pkColsArg = cols.map((c) => `table.${c}`).join(', ');
    const pkName = `${tableName}_pkey`;
    // Skip if already present.
    if (schema.includes(`name: "${pkName}"`)) continue;

    // Locate the table block: `export const <ident> = <schemaVar>.table("<tableName>", {`
    // … then either `}, (table) => [\n  ...\n]);` (existing callback) or `});` (none).
    const tableBlockRe = new RegExp(
      String.raw`(export const \w+ = \w+\.table\("${tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\// Fix 4: `unknown(...)` emitted for tsvector + bytea columns (drizzle-kit
// has no built-in mapping). `unknown` is a TS type, not a value — TS would
// reject the file. We don't read these from app code (tsvector is FTS-only,
// bytea is write-only or generated). Treat them as text() so drizzle's
// type-check is happy and index references stay valid. Raw SQL still
// reads/writes the actual underlying PG type.
let fixedUnknownCols = 0;
schema = schema.replace(/\w+: unknown\(/g, (match) => {
  fixedUnknownCols++;
  return match.replace('unknown(', 'text(');
});')}", \{[\s\S]*?)(\}\)|\}, \(table\) => \[[\s\S]*?\]\));`,
      'm',
    );
    const m = schema.match(tableBlockRe);
    if (!m) continue;

    const pkLine = `\tprimaryKey({ columns: [${pkColsArg}], name: "${pkName}"}),`;
    let replacement;
    if (m[2] === '})') {
      // No callback yet. Add one.
      replacement = `${m[1]}}, (table) => [\n${pkLine}\n]);`;
    } else {
      // Callback exists. Inject before the closing `])`.
      replacement = m[1] + m[2].replace(/\]\)$/, `${pkLine}\n])`);
    }
    schema = schema.replace(m[0], replacement);
    fixedMissingPks++;
  }
} else {
  console.warn('    skipped Fix 5 (composite PK injection): psql failed', psql.stderr);
}

// Fix 6: drizzle-kit names the schema file `schema.ts` and the relations
// file references it as `from "./schema"`. We rename the schema file to
// `generated.ts`, so the relations import must follow.
if (existsSync(relationsPath)) {
  let rel = readFileSync(relationsPath, 'utf8');
  rel = rel.replace(/from "\.\/schema"/g, 'from "./generated"');
  writeFileSync(relationsPath, rel);
}

writeFileSync(schemaPath, schema);
console.log(`    fixed ${fixedDefaults} empty-string defaults`);
console.log(`    fixed ${fixedTimestamps} timestamp modes (string→number)`);
console.log(`    fixed ${fixedFnDefaults} function-call defaults (wrapped in sql\`\`)`);
console.log(`    rewrote ${fixedUnknownCols} unsupported-type columns (tsvector/bytea → text)`);
console.log(`    injected ${fixedMissingPks} missing composite primary keys`);

// Promote: schema.ts → generated.ts, relations.ts → generated-relations.ts
copyFileSync(schemaPath, join(SCHEMA_DIR, 'generated.ts'));
if (existsSync(relationsPath)) {
  copyFileSync(relationsPath, join(SCHEMA_DIR, 'generated-relations.ts'));
}

console.log('==> done. generated.ts + generated-relations.ts updated.');
console.log('    Inspect with: git diff src/schema/generated.ts');
