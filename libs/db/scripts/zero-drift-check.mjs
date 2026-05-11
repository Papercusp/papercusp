#!/usr/bin/env node
/**
 * CI-friendly drift check: compares
 *   (A) tables in the live `zero_harness` PG publication
 *   (B) tables in the hand-written `libs/zero-harness/src/schema.ts`
 *
 * Exit code:
 *   0 — every published table has a corresponding entry in schema.ts
 *   1 — drift detected (new PG tables not yet published, or schema.ts
 *       references a table no longer in the publication)
 *
 * Per-table column drift is logged as a warning but doesn't fail the
 * check, since hand-written schema legitimately omits some columns
 * (tsvector _search, write-only bytea blobs, etc.).
 *
 * Usage:
 *   node libs/papercusp/libs/db/scripts/zero-drift-check.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../..');
const ZERO_SCHEMA = resolve(REPO, 'libs/zero-harness/src/schema.ts');

if (!existsSync(ZERO_SCHEMA)) {
  console.error(`expected zero schema at ${ZERO_SCHEMA}`);
  process.exit(1);
}

const dbUrl =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

// Live publication membership
let pgTables;
try {
  const out = execSync(
    `psql "${dbUrl}" -tA -F "|" -c "SELECT schemaname || '.' || tablename FROM pg_publication_tables WHERE pubname='zero_harness' AND schemaname IN ('harness_shared','papercup_shared') ORDER BY 1;"`,
    { encoding: 'utf8' },
  );
  pgTables = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
} catch (err) {
  console.error('failed to read publication tables:', err.message);
  process.exit(1);
}

// Hand-written zero schema's table list — parse `.from('schema.table')` calls.
// Skip the docstring example `.from('schema.table')` on line ~17 (false positive).
const schemaSrc = readFileSync(ZERO_SCHEMA, 'utf8');
const handTables = new Set();
const fromRe = /\.from\(\s*['"]([a-z_]+\.[a-z_0-9]+)['"]\s*\)/g;
let m;
while ((m = fromRe.exec(schemaSrc)) !== null) {
  if (m[1] === 'schema.table') continue;
  handTables.add(m[1]);
}

const missing = [...pgTables].filter((t) => !handTables.has(t)).sort();
const orphan = [...handTables].filter((t) => !pgTables.has(t)).sort();

console.log(`PG publication zero_harness:    ${pgTables.size} tables (cross-cutting only)`);
console.log(`hand-written Zero schema.ts:    ${handTables.size} tables`);

if (missing.length === 0 && orphan.length === 0) {
  console.log('✓ no drift detected');
  process.exit(0);
}

if (missing.length > 0) {
  console.log();
  console.log(`✗ tables in publication but NOT in schema.ts (${missing.length}):`);
  for (const t of missing) console.log(`    ${t}`);
  console.log();
  console.log('  Run:  node libs/papercusp/libs/db/scripts/zero-schema-suggest.mjs <table_name>');
  console.log('  …to print a starter entry for each.');
}

if (orphan.length > 0) {
  console.log();
  console.log(`✗ tables in schema.ts but NOT in publication (${orphan.length}):`);
  for (const t of orphan) console.log(`    ${t}`);
  console.log();
  console.log('  Either re-add to publication or remove from schema.ts.');
}

process.exit(1);
