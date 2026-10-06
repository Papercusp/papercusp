/**
 * Detect a migration that commits WHILE pull-schema.mjs runs (WI-10006614).
 *
 * pull-schema reads the live catalog more than once: drizzle-kit introspects
 * first, then the script re-reads pg_policies, primary keys and index operator
 * classes through psql as the authoritative source for its repairs. On this
 * fleet migrations auto-apply concurrently with agents' pull runs several times
 * an hour, so a migration can commit between those reads. The repairs then see
 * catalog objects the introspection never saw.
 *
 * Measured 2026-10-06: migration 1375 committed mid-pull. Introspection saw the
 * pre-1375 catalog, the pg_policies read saw the three new policies, and the
 * run refused with "unresolved pgPolicy predicates ... authoritative policy has
 * no generated call". Refusing was correct, but that message names the
 * projector, so a peer spent an investigation cycle on a projector defect that
 * did not exist (EI-25203957510863463).
 *
 * The applied-migration ledger is the cheap witness: fingerprint it before
 * introspection, re-read it before any refusal or promotion, and when it moved,
 * say what actually happened — the catalog changed mid-run, re-run the pull.
 *
 * Kept separate from the CLI so it can be regression-tested without a live DB.
 */

/**
 * One psql-friendly statement returning a JSON object that fingerprints the
 * applied-migration ledger. `count` is what catches a migration whose
 * `applied_at` (transaction start time) predates the first fingerprint but
 * whose COMMIT landed after it — max(applied_at) alone would miss that case.
 */
export const MIGRATION_FINGERPRINT_SQL = [
  'SELECT json_build_object(',
  "'count', (SELECT count(*) FROM harness_shared.schema_migrations),",
  "'latestFilename', (SELECT filename FROM harness_shared.schema_migrations",
  'ORDER BY applied_at DESC, filename DESC LIMIT 1),',
  "'latestAppliedAt', (SELECT max(applied_at) FROM harness_shared.schema_migrations)",
  ');',
].join(' ');

/**
 * Parse psql `-tA` output of MIGRATION_FINGERPRINT_SQL.
 *
 * @param {unknown} stdout
 * @returns {{count: number, latestFilename: string|null, latestAppliedAt: string|null} | null}
 *   null when the output is not a usable fingerprint (drift detection is then
 *   unavailable for the run; callers must not treat null as "no drift").
 */
export function parseMigrationFingerprint(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const count = Number(value.count);
  if (!Number.isInteger(count) || count < 0) return null;
  return {
    count,
    latestFilename: typeof value.latestFilename === 'string' ? value.latestFilename : null,
    latestAppliedAt: value.latestAppliedAt == null ? null : String(value.latestAppliedAt),
  };
}

/**
 * Compare two ledger fingerprints.
 *
 * @param {ReturnType<typeof parseMigrationFingerprint>} before taken before introspection
 * @param {ReturnType<typeof parseMigrationFingerprint>} after taken at the check point
 * @param {{stage?: string}} [options] where the drift was detected, for the message
 * @returns {string|null} a refusal message when the ledger moved, otherwise null.
 *   Also null when either fingerprint is unavailable: an unmeasured comparison
 *   is not evidence of drift, and callers already warned that detection is off.
 */
export function describeCatalogDrift(before, after, { stage } = {}) {
  if (before == null || after == null) return null;
  if (
    before.count === after.count &&
    before.latestFilename === after.latestFilename &&
    before.latestAppliedAt === after.latestAppliedAt
  ) {
    return null;
  }
  const which =
    after.latestFilename != null && after.latestFilename !== before.latestFilename
      ? `migration ${after.latestFilename}`
      : 'a migration';
  const where = stage ? `, detected ${stage}` : '';
  return (
    `catalog changed during pull (${which} applied mid-run; ` +
    `schema_migrations rows ${before.count} → ${after.count}${where}). ` +
    'drizzle-kit introspected the catalog BEFORE that change, so this run mixes two ' +
    'catalog states. This is NOT a projector defect — re-run pull-schema.'
  );
}
