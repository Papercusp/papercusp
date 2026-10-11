/**
 * Refuse to pull the schema from a database that lags the armed migrations
 * (WI-6554700010008404).
 *
 * pull-schema.mjs introspects whatever database resolveAdminUrlWithSource()
 * returns. On a dev box with the desktop running, that is the desktop's
 * embedded PG (source: discovery-file). The embedded PG only receives
 * migrations when the desktop boots, while db:migrate writes the native
 * operator DB. Measured 2026-10-11: the pull exited 0 against the embedded PG
 * and wrote a generated.ts missing four applied tables. The connectivity
 * precheck passed because the DB was reachable, and Fix 14's fingerprint
 * compares the ledger with itself, so neither could see the lag.
 *
 * The cheap witness: every armed sql/NNN-*.sql file must appear in the resolved
 * database's harness_shared.schema_migrations. A missing one means generated.ts
 * would not describe the schema the migrations define, so the pull refuses and
 * names the files.
 *
 * "Armed" is the migration runner's own definition (applyPendingMigrations):
 * `*.sql` files the default skip predicate does not exclude. `.DRAFT` files are
 * therefore never armed. Kept separate from the CLI so it can be
 * regression-tested without a live DB.
 */
import { defaultSkipFile } from '@papercusp/embedded-postgres-server/src/migration-runner.js';

/** One psql statement listing applied migration filenames, one per line under `-tA`. */
export const APPLIED_MIGRATIONS_SQL =
  'SELECT filename FROM harness_shared.schema_migrations ORDER BY filename';

/** Env var that downgrades the refusal to a warning. */
export const ALLOW_LAGGING_LEDGER_ENV = 'PULL_SCHEMA_ALLOW_LAGGING_LEDGER';

/**
 * Parse psql `-tA` output of APPLIED_MIGRATIONS_SQL.
 *
 * @param {unknown} stdout
 * @returns {Set<string> | null} null when the output is empty. An empty ledger
 *   cannot be told apart from a failed read, so callers must treat null as
 *   "lag detection unavailable", never as "nothing applied".
 */
export function parseAppliedMigrations(stdout) {
  const names = String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (names.length === 0) return null;
  return new Set(names);
}

/**
 * Armed migration files the database has not applied, in directory-listing order.
 *
 * @param {readonly string[]} filenames  Entries of the sql/ directory.
 * @param {ReadonlySet<string>} applied  Filenames recorded in schema_migrations.
 * @param {(file: string) => boolean} [skipFile]  Defaults to the runner's predicate.
 * @returns {string[]}
 */
export function findUnappliedMigrations(filenames, applied, skipFile = defaultSkipFile) {
  return filenames
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !skipFile(f))
    .filter((f) => !applied.has(f));
}

/**
 * Refusal message for a lagging ledger.
 *
 * @param {{ unapplied: readonly string[], source: string, redactedUrl: string, sample?: number }} args
 * @returns {string}
 */
export function describeLaggingLedger({ unapplied, source, redactedUrl, sample = 10 }) {
  const shown = unapplied.slice(0, sample);
  const more = unapplied.length - shown.length;
  return (
    `the resolved database has not applied ${unapplied.length} armed migration(s) ` +
    `(source: ${source}):\n    ${redactedUrl}\n` +
    shown.map((f) => `      - ${f}\n`).join('') +
    (more > 0 ? `      … and ${more} more\n` : '') +
    '  A pull from this database would write a generated.ts that omits what those ' +
    'migrations create.\n' +
    '  Fix: point HARNESS_ADMIN_DATABASE_URL at the database db:migrate applies to ' +
    '(the native operator DB on a dev box), or apply the migrations to this one.\n' +
    `  To pull anyway, set ${ALLOW_LAGGING_LEDGER_ENV}=1.`
  );
}
