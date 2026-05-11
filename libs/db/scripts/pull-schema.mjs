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

writeFileSync(schemaPath, schema);
console.log(`    fixed ${fixedDefaults} empty-string defaults`);
console.log(`    fixed ${fixedTimestamps} timestamp modes (string→number)`);

// Promote: schema.ts → generated.ts, relations.ts → generated-relations.ts
copyFileSync(schemaPath, join(SCHEMA_DIR, 'generated.ts'));
if (existsSync(relationsPath)) {
  copyFileSync(relationsPath, join(SCHEMA_DIR, 'generated-relations.ts'));
}

console.log('==> done. generated.ts + generated-relations.ts updated.');
console.log('    Inspect with: git diff src/schema/generated.ts');
