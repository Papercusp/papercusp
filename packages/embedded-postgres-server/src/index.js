/**
 * Boot a real Postgres (PG 18 via embedded-postgres) configured for
 * logical replication so Zero / pgoutput consumers can subscribe.
 *
 * Mirrors @papercusp/pglite-server's handle shape so consumers can swap
 * the two via env var. Notable differences:
 *   - Listens on TCP localhost:<port> (real PG can't expose a unix
 *     socket trivially across platforms; TCP is the cross-platform
 *     contract).
 *   - Spawns a real `postgres` child process.
 *   - Applies SQL migrations idempotently via a schema_migrations
 *     tracker (fixes the pglite-server first-boot-only bug).
 *
 * Roles: harness_app, harness_admin, harness_zero are pre-created with
 * the same passwords libs/db/src/connection.ts expects. The framework's
 * GRANT statements run during 001-shared.sql apply.
 *
 * Logical replication: the postmaster starts with
 *   wal_level=logical max_wal_senders=10 max_replication_slots=10
 * so zero-cache (or any pgoutput consumer) can CREATE_REPLICATION_SLOT.
 *
 * Discovery contract (added 2026-05-12):
 *   The desktop's Rust main writes the chosen port to
 *   ~/.papercusp/embedded-pg.json on PG ready (deletes on shutdown), so
 *   external processes (`apps/operator npm run dev`) can find the same
 *   PG. Operator code resolves via apps/operator/lib/embedded-pg-discovery.ts
 *   `getHarnessAdminUrl()`. Don't add new code that hardcodes
 *   `localhost:5432` or `:16534` — both are stale.
 *
 * Migration runner notes:
 *   - Strips lines starting with `\` before sending SQL to PG (psql
 *     metacommands like `\set ON_ERROR_STOP on` aren't valid SQL).
 *   - File `040-plugin-configs-backfill.sql` is in MANUAL_ONLY skip
 *     list — it requires `psql -v key=...` variable substitution.
 *   - Publication block (CREATE PUBLICATION zero_harness FOR TABLES IN
 *     SCHEMA harness_shared, papercusp_shared) MUST run AFTER migrations
 *     so the schemas exist on a fresh initdb.
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { mkdir, rm, cp, stat, chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyPendingMigrations } from './migration-runner.js';
export { applyPendingMigrations } from './migration-runner.js';

const DEFAULT_DB = 'papercusp';
const DEFAULT_OWNER = 'postgres';
const DEFAULT_OWNER_PWD = 'postgres';

/**
 * Ensure the `zero_harness` logical-replication publication exists and is
 * correctly configured, then fold in any per-harness schemas. Called at boot
 * AFTER migrations (the schemas it references must exist) and imported by the
 * fresh-migrate integration guard so the EXACT boot DDL is tested.
 *
 * Scoping: FOR TABLES IN SCHEMA (not FOR ALL TABLES) — the latter captured
 * zero-cache's own bookkeeping schemas (papercusp_0/cvr, papercusp_0/cdc, audit)
 * and OOMed initial replication on workspaces with accumulated history. FOR
 * TABLES IN SCHEMA auto-includes new tables in the listed schemas.
 *
 * Note (WI-2914): agent_facts DELETEs under this delete-publishing publication
 * are made safe by migration 505 (surrogate PK + REPLICA IDENTITY DEFAULT), NOT
 * by any publication-level setting here — a deliberately version-agnostic fix
 * (the PG18-only `publish_generated_columns` route would break the PG16 test
 * container and any non-PG18 server). See that migration for the full root cause.
 */
export async function ensureZeroHarnessPublication(sql) {
  await sql.unsafe(`
    DO $pg$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'zero_harness') THEN
        CREATE PUBLICATION zero_harness FOR TABLES IN SCHEMA harness_shared, papercusp_shared;
      END IF;
    END $pg$;
  `);
  // Add per-harness schemas to the publication. Idempotent — duplicates raise a
  // notice we ignore.
  const perHarnessSchemas = await sql.unsafe(`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'harness\\_%' ESCAPE '\\'
      AND schema_name <> 'harness_shared'
  `);
  for (const { schema_name } of perHarnessSchemas) {
    if (!/^harness_[a-z0-9_]+$/i.test(schema_name)) continue;
    try {
      await sql.unsafe(`ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA ${schema_name}`);
    } catch {
      // Already in publication — ignore.
    }
  }
}

/**
 * The initdb flags used for EVERY fresh cluster this package creates — the
 * seedless first-boot fallback AND the pre-migrated seed (build-seed.mjs boots
 * through startEmbeddedPostgresServer, so the shipped seed's postgresql.conf
 * inherits these). SINGLE SOURCE OF TRUTH — do not inline a divergent locale.
 *
 * Pinning an explicit UNIVERSAL locale here is load-bearing. initdb otherwise
 * derives lc_* from the build/runtime host's LANG, so a seed built on a
 * full-locale host (LANG=en_US.UTF-8) bakes lc_*='en_US.UTF-8' into
 * postgresql.conf — which then FATALs at first boot on the minimal Windows WSL
 * rootfs (papercup-runtime ships only C / C.utf8 / POSIX — no en_US.UTF-8):
 * "configuration file contains errors: invalid value for parameter lc_numeric:
 * en_US.UTF-8". Found live 2026-07-04 (WI-2649): the seed extracted fine but
 * postgres refused to start.
 *
 * The locale MUST be `C`, not `C.UTF-8`. `C.UTF-8` is a glibc-ism: it exists on
 * every Linux/WSL host but macOS's BSD libc has NO such locale, so `initdb
 * --locale=C.UTF-8` FATALs OUTRIGHT on macOS — "initdb: error: invalid locale
 * name \"C.UTF-8\"" — before any conf is even written (found live on the mac
 * build VM 2026-07-05: the seed build aborted and the DMG shipped an EMPTY
 * db-seed.tar.gz, AND the runtime seedless fallback below would identically
 * FATAL on a fresh user Mac, leaving the app unable to initialise its DB at
 * all). `C` is the ONE locale POSIX guarantees on every libc (glibc, musl,
 * macOS, Windows) and every PG version. Its collation is byte-order (memcmp) —
 * BIT-IDENTICAL to glibc `C.UTF-8`'s collation, so sort/index order is
 * unchanged; the only delta is lc_ctype (ASCII-only upper/lower vs UTF-8-aware),
 * immaterial for this control-plane DB and already the accepted trade for the
 * runtime lc_* (normalized to `C` too — see UNIVERSAL_LC_VALUES). `--encoding=UTF8`
 * keeps UTF-8 STORAGE regardless of the C ctype. Only affects a FRESH initdb
 * (seed build + the seedless fallback); existing data dirs are untouched.
 *
 * `--lc-messages=C` is NOT redundant with `--locale`: the bundled
 * `embedded-postgres` package hard-injects `--lc-messages=<getBestLocale()>`
 * into initdb BEFORE these flags (it greps the initdb readiness banner, so it
 * forces a known-locale), and getBestLocale() prefers `en_US.UTF-8` when the
 * BUILD host has it. A per-category `--lc-messages` overrides `--locale` for
 * that one category regardless of `--locale`, so without pinning it explicitly
 * (later, so initdb's last-duplicate-wins picks ours) the seed baked
 * `lc_messages='en_US.utf8'` while every other lc_* was C — and THAT one
 * param FATALed first boot on the lean rootfs (WI-2749, follow-on to WI-2649).
 * normalizeConfLc() below is the deterministic belt-and-suspenders.
 */
export const SEED_INITDB_FLAGS = ['--locale=C', '--lc-messages=C', '--encoding=UTF8'];

/**
 * The runtime-settable lc_* GUCs that live in postgresql.conf and are VALIDATED
 * against the OS locale set at postmaster startup — a non-portable value here
 * (e.g. en_US.utf8 on a C/C.utf8/POSIX-only rootfs) is the exact "invalid value
 * for parameter <lc_*>" FATAL of WI-2649 / WI-2749. (lc_collate / lc_ctype are
 * initdb-fixed in pg_database, not re-validated at start, so they are not here.)
 */
export const RUNTIME_LC_PARAMS = ['lc_messages', 'lc_monetary', 'lc_numeric', 'lc_time'];

/**
 * Locales acceptable as the INITDB --locale pin (lc_collate/lc_ctype, baked
 * into pg_database at initdb time) on EVERY platform this package ships to.
 *
 * ⚠ `C.UTF-8` is deliberately NOT here. It is glibc-only: valid at initdb on
 * Linux/WSL but REJECTED by macOS's BSD libc ("initdb: error: invalid locale
 * name \"C.UTF-8\"", mac build VM 2026-07-05). Since a desktop build targets
 * macOS too, the only initdb locales portable across ALL targets are exactly the
 * POSIX-guaranteed `C` / `POSIX` — which makes this set identical to
 * UNIVERSAL_LC_VALUES now. (It was ['C','POSIX','C.UTF-8',…] pre-macOS, when
 * C.UTF-8's UTF-8 ctype looked worth the glibc-only bet — that bet is what
 * bricked the mac build. Do NOT re-add C.UTF-8: it re-arms the macOS FATAL.)
 * initdb-time and runtime lc_* now share one universal set: `C` / `POSIX`.
 */
export const PORTABLE_INITDB_LOCALES = ['C', 'POSIX'];

/**
 * Locale values valid for the RUNTIME_LC_PARAMS on EVERY libc a desktop build
 * ships to — glibc (Linux/WSL), musl, **macOS BSD libc**, and Windows. This is
 * exactly the POSIX-guaranteed set: `C.UTF-8` is a glibc-ism that macOS
 * setlocale() REJECTS, so a conf carrying lc_messages='C.UTF-8' FATALs the
 * postmaster on macOS ("invalid value for parameter lc_messages", found live on
 * the mac VM 2026-07-05, WI-2945 fallout — the WI-2749 normalizer itself had
 * stamped it there). The runtime lc_* params control message/number/date
 * FORMATTING only (never collation/ctype), so plain 'C' loses nothing.
 */
export const UNIVERSAL_LC_VALUES = ['C', 'POSIX'];

/** True when `value` is a runtime lc_* value valid on EVERY target libc (incl. macOS). Pure. */
export function localeIsUniversal(value) {
  return typeof value === 'string'
    && UNIVERSAL_LC_VALUES.some((p) => p.toLowerCase() === value.toLowerCase());
}

/**
 * Extract the `--locale=<value>` an initdb flag list requests, or null if none.
 * Pure. Handles both the `--locale=X` and the split `--locale X` spellings.
 */
export function initdbLocale(flags = []) {
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (typeof f !== 'string') continue;
    if (f.startsWith('--locale=')) return f.slice('--locale='.length);
    if (f === '--locale' && typeof flags[i + 1] === 'string') return flags[i + 1];
  }
  return null;
}

/**
 * True when `flags` pin an EXPLICIT, portable initdb locale — i.e. the resulting
 * cluster's postgresql.conf lc_* will name a locale present on a lean host, never
 * a host-specific one like en_US.UTF-8. A MISSING `--locale` is NOT portable: it
 * makes initdb inherit the build host's LANG, which is the exact WI-2649
 * regression. Pure — the WI-2649 recurrence guard asserts on this.
 */
export function initdbLocaleIsPortable(flags = []) {
  const loc = initdbLocale(flags);
  if (loc == null) return false;
  return PORTABLE_INITDB_LOCALES.some((p) => p.toLowerCase() === loc.toLowerCase());
}

/** True when `value` names a locale present on every lean target rootfs. Pure. */
export function localeIsPortable(value) {
  return typeof value === 'string'
    && PORTABLE_INITDB_LOCALES.some((p) => p.toLowerCase() === value.toLowerCase());
}

/**
 * Return the list of `param='value'` for every ACTIVE (uncommented) RUNTIME_LC_PARAMS
 * assignment in a postgresql.conf whose value is not UNIVERSAL — empty means the
 * conf will boot on every target libc (lean WSL rootfs AND macOS). Pure; the
 * WI-2749 recurrence guard asserts empty. Judged against UNIVERSAL_LC_VALUES,
 * not PORTABLE_INITDB_LOCALES: `C.UTF-8` passes the glibc-only initdb set but
 * FATALs macOS's postmaster (2026-07-05).
 */
export function confLcNonPortable(confText) {
  const bad = [];
  for (const param of RUNTIME_LC_PARAMS) {
    const m = confText.match(new RegExp(`^\\s*${param}\\s*=\\s*'([^']*)'`, 'm'));
    if (m && !localeIsUniversal(m[1])) bad.push(`${param}='${m[1]}'`);
  }
  return bad;
}

/**
 * Rewrite every ACTIVE RUNTIME_LC_PARAMS assignment whose value is not universal
 * to `portableLocale`, preserving the trailing comment + surrounding formatting.
 * Pure — returns { text, changed }. Idempotent: a conf already universal is a
 * no-op. Default 'C' — the only spelling (with POSIX) every libc accepts; the
 * previous default C.UTF-8 was itself the macOS FATAL (see UNIVERSAL_LC_VALUES).
 */
export function normalizeConfLc(confText, portableLocale = 'C') {
  let changed = false;
  let out = confText;
  for (const param of RUNTIME_LC_PARAMS) {
    const re = new RegExp(`^(\\s*${param}\\s*=\\s*)'([^']*)'`, 'm');
    out = out.replace(re, (full, lhs, val) => {
      if (localeIsUniversal(val)) return full;
      changed = true;
      return `${lhs}'${portableLocale}'`;
    });
  }
  return { text: out, changed };
}

/**
 * Force every runtime-settable lc_* GUC in <dataDir>/postgresql.conf to a
 * PORTABLE locale, on disk, before the postmaster starts. Run on EVERY boot
 * (fresh initdb, extracted seed, AND a reused/possibly-pre-fix data dir) so an
 * already-installed broken cluster self-heals on update rather than staying
 * wedged. Idempotent + best-effort: a missing conf (no initdb yet) is a no-op.
 * See SEED_INITDB_FLAGS / normalizeConfLc for the why (WI-2749).
 */
export async function normalizePortableLocaleConf(dataDir, log = () => {}) {
  const confPath = join(dataDir, 'postgresql.conf');
  let conf;
  try {
    conf = await readFile(confPath, 'utf8');
  } catch {
    return; // no conf on disk yet — nothing to normalize
  }
  const { text, changed } = normalizeConfLc(conf);
  if (changed) {
    await writeFile(confPath, text);
    log(`normalized non-universal lc_* in postgresql.conf → C (WI-2749; C.UTF-8 FATALs macOS)`);
  }
}

/**
 * Resolve the effective pre-built-seed path from opts + env (pure — the caller
 * checks existence). opts.seedPath wins, then PAPERCUSP_PG_SEED_PATH env;
 * PAPERCUSP_PG_DISABLE_SEED (any truthy value) forces null (always initdb).
 * Returns null when no seed is configured.
 */
export function resolveSeedPath(opts = {}, env = process.env) {
  if (env.PAPERCUSP_PG_DISABLE_SEED) return null;
  return opts.seedPath ?? env.PAPERCUSP_PG_SEED_PATH ?? null;
}

/**
 * Extract a pre-built PGDATA seed into `dataDir`. `seedPath` may be a directory
 * (raw PGDATA — recursively copied) or a `.tar`/`.tar.gz` archive whose ROOT is
 * the PGDATA contents (extracted with the system `tar`, gzip auto-detected;
 * present on macOS/Linux/Win10+). Postgres requires the data dir be mode 0700,
 * so we chmod it after (no-op on Windows). Throws on any failure so the caller
 * can wipe + fall back to a clean initdb — never boot a half-extracted dir.
 */
export async function extractSeed(seedPath, dataDir) {
  const st = await stat(seedPath);
  await mkdir(dataDir, { recursive: true });
  if (st.isDirectory()) {
    // cp copies file modes; recursive handles the whole cluster tree.
    await cp(seedPath, dataDir, { recursive: true });
  } else {
    execFileSync('tar', ['-x', '-f', seedPath, '-C', dataDir], { stdio: 'ignore' });
  }
  if (process.platform !== 'win32') {
    await chmod(dataDir, 0o700).catch(() => {});
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.dataDir]      Postgres data dir. Default: ~/.papercusp/embedded-pg-data
 * @param {number} [opts.port]         TCP port. Default: 5532 (avoiding 5432 collision with system PG).
 * @param {string} [opts.dbName]       Database to create + connect to. Default: papercusp.
 * @param {boolean} [opts.debug]
 * @param {string} [opts.dbSqlDir]     Directory of *.sql migration files. If set, migrations apply on every boot.
 * @param {string} [opts.seedPath]     Path to a pre-built PGDATA seed — a directory OR a .tar/.tar.gz
 *        archive of a data dir already `initdb`'d + fully migrated at package time. On a FRESH data
 *        dir it is extracted INSTEAD of running initdb + the full migration replay (desktop first-boot
 *        fast path: ~11s → ~0.3s, measured). The idempotent runner still applies any migration DELTA
 *        afterwards, so a slightly-stale seed self-heals. Falls back to PAPERCUSP_PG_SEED_PATH env, or
 *        to a clean initdb if the seed is absent/unusable. Force-disable with PAPERCUSP_PG_DISABLE_SEED=1.
 * @param {Record<string,string>} [opts.extraPostgresSettings] Host-scaled server knobs
 *        (max_connections, shared_buffers, parallelism, …) the caller derived from
 *        resource-profile (`databaseTuningToSettings(getResourceProfile().database)`).
 *        Empty by default → stock PG defaults (backward compatible). Passing them is
 *        how the desktop's embedded PG autoadjusts to the machine instead of running
 *        on the laptop-sized stock `max_connections=100` / `shared_buffers=128MB`.
 * @param {(m: string) => void} [opts.onLog]
 */
export async function startEmbeddedPostgresServer(opts = {}) {
  const dataDir = opts.dataDir ?? join(homedir(), '.papercusp', 'embedded-pg-data');
  const port = opts.port ?? 5532;
  const dbName = opts.dbName ?? DEFAULT_DB;
  const debug = !!opts.debug;
  const log = opts.onLog ?? ((m) => debug && console.log(`[embedded-pg-server] ${m}`));

  await mkdir(dataDir, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    port,
    persistent: true,
    // Postgres refuses to run as root; on root-only hosts (cloud frames) the
    // lib can create + setuid a dedicated postgres OS user instead. Opt-in —
    // found live 2026-06-06 bootstrapping a frame.
    createPostgresUser: opts.createPostgresUser ?? false,
    onLog: (m) => log(`pg: ${typeof m === 'string' ? m : (m?.message ?? '')}`),
    onError: (m) => log(`pg-err: ${typeof m === 'string' ? m : (m?.message ?? m?.toString?.() ?? '')}`),
    // Initialise the cluster with a PORTABLE locale rather than inheriting the
    // build/runtime host's LANG — load-bearing for the pre-migrated seed's
    // cross-platform first boot (WI-2649). Single source of truth + full
    // rationale: SEED_INITDB_FLAGS above. Spread so nothing downstream mutates
    // the exported constant.
    initdbFlags: [...SEED_INITDB_FLAGS],
    // wal_level=logical is REQUIRED for Zero / any pgoutput consumer.
    // The two replication-slot/sender knobs are sized generously enough
    // for one zero-cache + a few diagnostic slots without bumping into
    // the postmaster start-up failure that happens at slots=0/senders=0.
    //
    // Host-scaled tuning (max_connections / shared_buffers / parallelism /
    // work_mem …) is appended from opts.extraPostgresSettings — these come last
    // so a caller's explicit value wins (PG honors the last `-c` for a key).
    // Replication knobs above are intentionally NOT in the tuning set, so there
    // is never a conflict.
    postgresFlags: [
      '-c', 'wal_level=logical',
      '-c', 'max_wal_senders=10',
      '-c', 'max_replication_slots=10',
      ...Object.entries(opts.extraPostgresSettings ?? {}).flatMap(
        ([k, v]) => ['-c', `${k}=${v}`],
      ),
    ],
  });

  // Pre-built PGDATA seed (desktop first-boot fast path). On a FRESH data dir,
  // if a pre-migrated snapshot is available, extract it INSTEAD of running
  // initdb + replaying the full migration set — this turns a clean install's
  // ~11s "initdb + 375 migrations" first-boot into a ~0.3s directory extract
  // (measured 42x). The seed is a physical snapshot produced by THIS package's
  // own fresh-boot path at package time, so it is byte-compatible with THIS
  // platform's embedded-postgres binary (the seed is built per-platform during
  // that platform's packaging). After extraction we fall through to the normal
  // "reuse existing data dir" path and applyPendingMigrations() STILL runs — it
  // finds every shipped migration already recorded and applies only the DELTA
  // (usually none), so a seed a few migrations behind self-heals. If the seed is
  // absent, corrupt, or extraction fails, we wipe any partial dir and fall back
  // to a clean initdb — never boot a half-extracted cluster.
  const seedPath = resolveSeedPath(opts);
  if (!existsSync(join(dataDir, 'PG_VERSION')) && seedPath && existsSync(seedPath)) {
    try {
      log(`seeding data dir from pre-built snapshot ${seedPath}`);
      await extractSeed(seedPath, dataDir);
      if (!existsSync(join(dataDir, 'PG_VERSION'))) {
        throw new Error('seed extracted but PG_VERSION missing');
      }
      log('seed applied — skipping initdb + full migration replay');
    } catch (e) {
      log(`seed failed (${e?.message ?? e}) — falling back to clean initdb`);
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(dataDir, { recursive: true });
    }
  }

  // initdb is idempotent: if the data dir is already initialized (including a
  // just-extracted seed), this is a no-op. Same for createDatabase below.
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    log(`initialising data dir at ${dataDir}`);
    await pg.initialise();
  } else {
    log(`reusing existing data dir at ${dataDir}`);
  }

  // Guarantee the cluster's lc_* GUCs are portable BEFORE every start. initdb
  // (via the bundled embedded-postgres) or a pre-fix seed may have baked a
  // host-specific locale like en_US.utf8 into postgresql.conf, which FATALs the
  // postmaster on the lean WSL rootfs (WI-2749). Running on every boot — not
  // just fresh initdb — self-heals an already-installed broken data dir.
  await normalizePortableLocaleConf(dataDir, log);

  log(`starting postgres on localhost:${port}`);
  await pg.start();

  // Create the target database if missing. embedded-postgres always
  // creates `postgres` as superuser; we add `papercusp` separately so
  // it has the same name across web + desktop deployments.
  const sysSql = postgres({
    host: 'localhost',
    port,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    database: 'postgres',
    max: 1,
  });
  try {
    const exists = await sysSql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      log(`creating database ${dbName}`);
      await sysSql.unsafe(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await sysSql.end({ timeout: 2 }).catch(() => {});
  }

  // Connect to the target DB to set up framework roles + apply migrations.
  const sql = postgres({
    host: 'localhost',
    port,
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    database: dbName,
    max: 1,
  });

  try {
    // Framework roles. Same passwords libs/db/src/connection.ts defaults to.
    // harness_zero needs CREATE on the database — zero-cache creates a
    // _zero_metadata_<app>_<shard>/cdc schema for change-streamer state on
    // first boot. Without the grant, change-streamer crashes with
    // "permission denied for database papercusp".
    await sql.unsafe(`
      DO $pg$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
          CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
          CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
          CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
        ELSE
          ALTER ROLE harness_zero SUPERUSER;
        END IF;
      END $pg$;
    `);

    // Extensions the baseline schema depends on, created BEFORE migrations.
    // The squashed 000-baseline.sql (self-contained-migration-baseline-2026-06-02)
    // is a schema-only dump of harness_shared + papercusp_shared: it references
    // gen_random_uuid()/digest() (pgcrypto), trigram ops (pg_trgm), and vector(N)
    // columns (vector) but does NOT itself CREATE EXTENSION. Previously these came
    // from migrations 027/039/059/060, now archived. pgcrypto + pg_trgm are trusted
    // and always succeed; vector needs the compiled .so — tolerated-if-missing
    // (mirrors the old 060), in which case mem0 degrades to its in-memory fallback.
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      DO LANGUAGE plpgsql $body$ BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector not available on this server (%); embedding features degrade to in-memory.', SQLERRM;
      END $body$;
    `);

    // Seed-restore RETIRED (self-contained-migration-baseline-2026-06-02, D-004): the
    // single idempotent 000-baseline.sql (+ 107+) is now the fresh-boot path, so the
    // PAPERCUSP_PG_SEED_DUMP_PATH pg_restore branch + its migration pre-marking are gone.
    // A fresh initdb now builds the full schema by applying migrations directly (below).

    // Apply migrations FIRST. The publication-creation block below
    // references schemas (harness_shared, papercusp_shared) that don't
    // exist on a fresh initdb until 001-shared.sql runs — moving
    // migrations ahead of the publication step prevents the
    // "schema does not exist" failure on first boot.
    if (opts.dbSqlDir && existsSync(opts.dbSqlDir)) {
      // Migrations are the single source of truth (self-contained-migration-baseline-2026-06-02).
      // The runner creates schema_migrations itself and applies 000-baseline.sql (+ 107+)
      // idempotently — no seed pre-marking, and role grants now live in migration 109
      // (not a boot-time re-grant), so a fresh initdb builds the complete, grant-correct
      // schema by applying migrations directly.
      const result = await applyPendingMigrations({
        client: sql,
        sqlDir: opts.dbSqlDir,
        log,
      });
      log(`migrations: ${result.appliedCount} applied this boot (${result.totalKnown} total known)`);

      // Zero replication publication. Extracted to ensureZeroHarnessPublication()
      // so the boot-path DDL (incl. the WI-2914 publish_generated_columns fix) is
      // exercised verbatim by the fresh-migrate integration guard — mirroring the
      // extract-a-shared-helper pattern this file already uses for migrations.
      // Runs AFTER migrations so the schemas it references exist on a fresh initdb.
      await ensureZeroHarnessPublication(sql);

      // Per-harness template application RETIRED (harness-state-storage-
      // unification-2026-06-01, D-007). Per-harness schemas now contain only
      // auto-updatable views over slug-keyed harness_shared.*_consolidated
      // tables — created by the migrations above (which loop over existing
      // harness_* schemas) and by scaffoldHarnessSchema() for new harnesses.
      // No boot-time per-harness DDL template is applied.
    } else if (opts.dbSqlDir) {
      log(`dbSqlDir=${opts.dbSqlDir} does not exist — skipping migrations`);
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  return {
    /** TCP port the postmaster is listening on. */
    port,
    /** Database name created/used. */
    dbName,
    /** Owner credentials. */
    user: DEFAULT_OWNER,
    password: DEFAULT_OWNER_PWD,
    /** Connection URLs for common roles (matches connection.ts expectations). */
    urls: {
      admin: `postgresql://harness_admin:harness_admin_pwd@localhost:${port}/${dbName}`,
      app:   `postgresql://harness_app:harness_app_pwd@localhost:${port}/${dbName}`,
      zero:  `postgresql://harness_zero:harness_zero_pwd@localhost:${port}/${dbName}`,
    },
    async stop() {
      log('stopping postgres');
      await pg.stop().catch((e) => log(`stop error: ${e?.message ?? e}`));
    },
  };
}
