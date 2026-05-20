import { defineConfig } from 'drizzle-kit';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Resolve PG URL: env > discovery file (~/.papercusp/embedded-pg.json,
// written by the desktop's Rust main on embedded-PG ready) > native
// :5432 fallback. Lets `drizzle-kit pull` introspect the embedded PG
// when the desktop is running, instead of always hitting native :5432.
function resolveDbUrl(): string {
  if (process.env.HARNESS_ADMIN_DATABASE_URL) return process.env.HARNESS_ADMIN_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1') {
    try {
      const raw = fs.readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
      const parsed = JSON.parse(raw) as { url?: string };
      if (parsed?.url) return parsed.url;
    } catch { /* fall through */ }
  }
  return 'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

/**
 * Drizzle config — INTROSPECTION ONLY.
 *
 * The `.sql` files in ./sql/ are the source of truth for DDL. This
 * config exists so `drizzle-kit pull` (alias: introspect) can regenerate
 * `src/schema/generated.ts` and `src/schema/generated-relations.ts`
 * from the live `papercusp` database after any new `.sql` migration.
 *
 * **Never run `drizzle-kit generate` or `drizzle-kit push` in this repo.**
 * They would produce broken DDL for tsvector generated columns, RLS
 * policies, the `ALTER PUBLICATION` calls, and the BEFORE INSERT
 * triggers. The `.sql` files cover all of those; Drizzle just mirrors.
 *
 * See PHASE0-AUDIT.md for known introspection quirks in v0.31.10.
 */
export default defineConfig({
  dialect: 'postgresql',
  schemaFilter: ['harness_shared', 'papercup_shared'],
  out: './src/schema',
  dbCredentials: {
    url: resolveDbUrl(),
  },
  introspect: {
    casing: 'camel',
  },
});
