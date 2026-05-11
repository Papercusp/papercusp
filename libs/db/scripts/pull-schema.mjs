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
 * Drizzle-kit v0.31.10 quirks the script silently patches so the
 * regenerated output is committable as-is (see PHASE0-AUDIT.md):
 *   Fix 1: empty-string defaults emit `.default(')` (invalid TS).
 *   Fix 2: timestamp mode 'string' → 'number' (Zero requires number).
 *   Fix 3: function-call defaults wrapped in sql`` (e.g. to_char(now(), …)).
 *   Fix 4: `unknown(...)` for tsvector/bytea rewritten to text().
 *   Fix 5: missing PKs (drizzle-kit drops ~half of them) injected via PG.
 *   Fix 6: relations.ts import rewritten from "./schema" to "./generated".
 *   Fix 7: drizzle-kit truncates `((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint`
 *          at the type-cast colon, producing unbalanced-paren SQL that
 *          breaks esbuild. Rewrite to a balanced `(EXTRACT(epoch FROM
 *          now()) * 1000)::bigint`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(__dirname, '..');
const SCHEMA_DIR = join(DB_ROOT, 'src/schema');

console.log('==> running drizzle-kit pull against live papercusp DB');

const result = spawnSync(
  'npx',
  ['-y', 'drizzle-kit@^0.31.10', 'introspect', '--config=' + join(DB_ROOT, 'drizzle.config.ts')],
  { cwd: DB_ROOT, stdio: 'inherit', env: { ...process.env } },
);
if (result.status !== 0) {
  console.error('drizzle-kit pull failed');
  process.exit(result.status ?? 1);
}

const schemaPath = join(SCHEMA_DIR, 'schema.ts');
const relationsPath = join(SCHEMA_DIR, 'relations.ts');
if (!existsSync(schemaPath)) {
  console.error('expected drizzle-kit to write src/schema/schema.ts');
  process.exit(1);
}

console.log('==> applying quirk fixups');
let schema = readFileSync(schemaPath, 'utf8');

// Fix 1: empty-string default rendering bug.
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

// Fix 3: function-call defaults emit as raw JS with broken escapes
// (e.g. `default(to_char(now(), \'YYYY-MM\'::text))`). Per-default fix:
// balanced-paren walk from `.default(`, treating backticks as "skip
// region" so existing `sql`(...)`` content isn't miscounted. Wrap any
// inner content containing `\'` in a sql`` template.
let fixedFnDefaults = 0;
{
  const out = [];
  let i = 0;
  while (i < schema.length) {
    const idx = schema.indexOf('.default(', i);
    if (idx === -1) {
      out.push(schema.slice(i));
      break;
    }
    out.push(schema.slice(i, idx));
    let depth = 1;
    let j = idx + '.default('.length;
    while (j < schema.length && depth > 0) {
      const ch = schema[j];
      if (ch === '`') {
        // Skip backtick-quoted region (e.g. existing sql`...`)
        const close = schema.indexOf('`', j + 1);
        if (close === -1) { j = schema.length; break; }
        j = close + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    const innerStart = idx + '.default('.length;
    const inner = schema.slice(innerStart, j - 1); // excludes closing `)`
    if (inner.includes("\\'") && !inner.trimStart().startsWith('sql`')) {
      const unescaped = inner.replace(/\\'/g, "'");
      out.push('.default(sql`' + unescaped + '`)');
      fixedFnDefaults++;
    } else {
      out.push('.default(' + inner + ')');
    }
    i = j;
  }
  schema = out.join('');
}

// Fix 4: `unknown(...)` emitted for tsvector + bytea columns. Treat as text().
let fixedUnknownCols = 0;
schema = schema.replace(/\w+: unknown\(/g, (match) => {
  fixedUnknownCols++;
  return match.replace('unknown(', 'text(');
});

// Fix 5: drizzle-kit drops primary keys. Re-query PG and inject any missing
// `primaryKey({ columns: [...] })` into the table-config callback.
let fixedMissingPks = 0;
const dbUrl =
  process.env.HARNESS_ADMIN_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
const pkQuery = [
  "SELECT n.nspname, t.relname,",
  "  string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum))",
  "FROM pg_constraint c",
  "JOIN pg_class t ON c.conrelid = t.oid",
  "JOIN pg_namespace n ON t.relnamespace = n.oid",
  "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)",
  "WHERE c.contype='p' AND n.nspname IN ('harness_shared','papercup_shared')",
  "GROUP BY n.nspname, t.relname",
  "ORDER BY 1, 2;",
].join(' ');
const psql = spawnSync('psql', [dbUrl, '-tA', '-F', '|', '-c', pkQuery], {
  encoding: 'utf8',
});
if (psql.status === 0) {
  const compositePks = psql.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [schemaName, tableName, colsCsv] = line.split('|');
      return { schemaName, tableName, cols: colsCsv.split(',') };
    });

  for (const { schemaName: _s, tableName, cols } of compositePks) {
    const pkName = tableName + '_pkey';
    if (schema.includes('name: "' + pkName + '"')) continue;
    // Skip if a single-col `.primaryKey()` is already chained on the col.
    if (cols.length === 1) {
      const colRe = new RegExp('\\b' + cols[0] + ': \\w+\\([^)]*\\)\\.primaryKey\\(\\)');
      // Check inside this table's block first
      const blockRe = new RegExp(
        '(export const \\w+ = \\w+\\.table\\("' + tableName + '", \\{)([\\s\\S]*?)(\\}\\)|\\}, \\(table\\) => \\[[\\s\\S]*?\\]\\))',
        'm',
      );
      const blockM = schema.match(blockRe);
      if (blockM && colRe.test(blockM[2])) continue;
    }

    const pkColsArg = cols.map((c) => 'table.' + c).join(', ');
    const tableBlockRe = new RegExp(
      '(export const \\w+ = \\w+\\.table\\("' + tableName + '", \\{[\\s\\S]*?)(\\}\\)|\\}, \\(table\\) => \\[[\\s\\S]*?\\]\\))(;?)',
      'm',
    );
    const m = schema.match(tableBlockRe);
    if (!m) continue;

    const pkLine = '\tprimaryKey({ columns: [' + pkColsArg + '], name: "' + pkName + '"}),';
    let replacement;
    if (m[2] === '})') {
      replacement = m[1] + '}, (table) => [\n' + pkLine + '\n])' + m[3];
    } else {
      const closing = m[2].replace(/\]\)$/, pkLine + '\n])');
      replacement = m[1] + closing + m[3];
    }
    schema = schema.replace(m[0], replacement);
    fixedMissingPks++;
  }
} else {
  console.warn('    skipped Fix 5 (composite PK injection): psql failed', psql.stderr);
}

// Fix 7: drizzle-kit truncates the PG default for epoch-ms timestamps at
// the `::numeric` type-cast colon, leaving unbalanced parens that break
// esbuild. Detect the specific known-broken pattern and rewrite. Same
// repair is applied to the SQL migration drizzle-kit emits alongside.
let fixedExtractDefaults = 0;
{
  const broken = ".default(sql`((EXTRACT(epoch FROM now()) * (1000)`)";
  const balanced = ".default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`)";
  const before = schema.length;
  while (schema.includes(broken)) {
    schema = schema.replace(broken, balanced);
    fixedExtractDefaults++;
  }
  // Also catch a variant where Fix 3 already wrapped the truncated
  // string (one less leading paren than the `default(` form above).
  const brokenInner = "sql`((EXTRACT(epoch FROM now()) * (1000)`";
  while (schema.includes(brokenInner)) {
    schema = schema.replace(brokenInner, "sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`");
    fixedExtractDefaults++;
  }
  void before;
}

// Repair the SQL migration drizzle-kit drops next to the schema (same
// truncation; `psql -f` would error if the broken text were ever applied
// to a fresh DB). The migration filename is timestamped — find by glob.
{
  const migDir = SCHEMA_DIR;
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(migDir)) {
    if (!/^\d{4}_.*\.sql$/.test(entry)) continue;
    const p = join(migDir, entry);
    let txt = readFileSync(p, 'utf8');
    const before = txt;
    txt = txt
      .replace(/DEFAULT \(\(EXTRACT\(epoch FROM now\(\)\) \* \(1000\) NOT NULL/g,
               'DEFAULT ((EXTRACT(epoch FROM now()) * 1000))::bigint NOT NULL');
    if (txt !== before) writeFileSync(p, txt);
  }
}

// Fix 6: rewrite relations import path from "./schema" to "./generated".
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
console.log(`    injected ${fixedMissingPks} missing primary keys`);
console.log(`    repaired ${fixedExtractDefaults} truncated EXTRACT defaults`);

// Promote: schema.ts → generated.ts, relations.ts → generated-relations.ts
copyFileSync(schemaPath, join(SCHEMA_DIR, 'generated.ts'));
if (existsSync(relationsPath)) {
  copyFileSync(relationsPath, join(SCHEMA_DIR, 'generated-relations.ts'));
}

console.log('==> done. generated.ts + generated-relations.ts updated.');
console.log('    Inspect with: git diff src/schema/generated.ts');
