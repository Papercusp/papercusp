/**
 * Idempotent migration runner.
 *
 * Tracks applied SQL files in `harness_shared.schema_migrations` (filename
 * is the natural key). On every boot:
 *   1. Ensure schema_migrations exists.
 *   2. Read the SQL dir, filter to *.sql sorted by filename.
 *   3. For each file not already in schema_migrations, apply it inside a
 *      transaction and INSERT a row.
 *
 * This fixes the long-standing bug where pglite-server only applied SQL on
 * "first boot" (when harness_shared didn't exist), causing migrations
 * authored after the DB was first booted to silently never run. Found in
 * the wild on 2026-05-05 — the symptom was provisioning failing with
 * `column "kind" of relation "token_index" does not exist` because
 * 009-workspace-scoping.sql had never been applied.
 *
 * Per-harness templates ({{SCHEMA}}-substituted) are NOT tracked here —
 * those are scaffolded on demand by scaffold-harness-schema.sh and don't
 * have a single file path.
 */
export declare function defaultSkipFile(f: any): any;
/**
 * @param {object} args
 * @param {object} args.client    postgres-js client (sql tag) OR object with `.unsafe(text)` method.
 * @param {string} args.sqlDir    Directory of *.sql files.
 * @param {(s: string) => void} [args.log]
 * @param {(file: string) => boolean} [args.skipFile]   Optional filter; defaults to skipping the per-harness template.
 * @param {(file: string, raw: string) => void | Promise<void>} [args.beforeApply] Optional fail-closed guard run after the file is read and before its SQL executes.
 * @param {boolean} [args.continueOnError]   Default false (fail-loud — embedded-pg
 *   boot + the fresh-migrate gate rely on a broken migration HALTING). Pass true
 *   on the shared native-:5432 operator boot (handoff-coordination-dx-followups A1):
 *   a migration that fails to apply is logged + collected in the returned `failed`
 *   array and the boot CONTINUES (the bad file stays unrecorded → retried next
 *   boot), so one peer's broken migration can't wedge the dev-api for the fleet.
 */
export declare function applyPendingMigrations({ client, sqlDir, log, skipFile, beforeApply, continueOnError }: {
    client: object;
    sqlDir: string;
    log?: (s: string) => void;
    skipFile?: (file: string) => boolean;
    beforeApply?: (file: string, raw: string) => void | Promise<void>;
    continueOnError?: boolean;
}): Promise<{
    appliedCount: number;
    totalKnown: number;
    failed: {
        file: string;
        error: string;
    }[];
}>;
