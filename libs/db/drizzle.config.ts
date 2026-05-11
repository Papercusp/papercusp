import { defineConfig } from 'drizzle-kit';

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
    url:
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
  },
  introspect: {
    casing: 'preserve',
  },
});
