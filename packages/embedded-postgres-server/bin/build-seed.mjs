#!/usr/bin/env node
/**
 * Build a pre-migrated PGDATA seed for the desktop first-boot fast path.
 *
 * Boots embedded-postgres into a throwaway data dir via the SAME
 * `startEmbeddedPostgresServer` code path the runtime uses (initdb + framework
 * roles + extensions + apply ALL migrations + publication), then cleanly stops
 * and archives the resulting data dir into a single `.tar.gz`. The desktop
 * bundle ships this archive; on a fresh install the Server extracts it INSTEAD
 * of running the ~11s "initdb + full migration replay" (see
 * `src/index.js` seedPath handling — measured ~42x faster first-boot).
 *
 * The seed is byte-compatible ONLY with the SAME embedded-postgres binary /
 * platform that built it, so this MUST run during each platform's own
 * packaging (the Mac build produces a darwin seed, etc.).
 *
 * Usage:
 *   node build-seed.mjs --data <tmp-pgdata> --sql <migrations-dir> --out <seed.tar.gz> [--port 5544]
 * Env fallbacks: PAPERCUSP_PG_DATA_DIR, PAPERCUSP_PG_SQL_DIR, PAPERCUSP_PG_SEED_OUT, PAPERCUSP_PG_PORT
 */
import { startEmbeddedPostgresServer, confLcNonPortable } from '../src/index.js';
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { rm, mkdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function arg(flag, envKey, def) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envKey] ?? def;
}

const dataDir = arg('--data', 'PAPERCUSP_PG_DATA_DIR');
const sqlDir = arg('--sql', 'PAPERCUSP_PG_SQL_DIR');
const outPath = arg('--out', 'PAPERCUSP_PG_SEED_OUT');
const port = Number(arg('--port', 'PAPERCUSP_PG_PORT', '5544'));

if (!dataDir || !sqlDir || !outPath) {
  console.error('build-seed: --data, --sql and --out (or their PAPERCUSP_PG_* env vars) are required');
  process.exit(2);
}
if (!existsSync(sqlDir)) {
  console.error(`build-seed: migrations dir not found at ${sqlDir}`);
  process.exit(2);
}

// Force a from-scratch initdb+migrate for the snapshot; never seed-from-seed.
process.env.PAPERCUSP_PG_DISABLE_SEED = '1';

const log = (m) => console.log(`[build-seed] ${m}`);
let handle = null;
let ok = true;
try {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  log(`booting embedded-pg into ${dataDir} (initdb + apply migrations from ${sqlDir}) ...`);
  const t = Date.now();
  handle = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir, onLog: () => {} });

  // Sanity: the seed must have the full schema, else shipping it would mask a build break.
  const sql = postgres({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'papercusp', max: 1, onnotice: () => {} });
  let migCount = 0;
  try {
    const r = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.schema_migrations');
    migCount = r[0].n;
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
  if (migCount < 100) {
    throw new Error(`seed sanity check failed: only ${migCount} migrations recorded (expected the full set)`);
  }
  log(`built schema in ${Date.now() - t} ms — ${migCount} migrations recorded`);

  // WI-2749 recurrence guard: the shipped seed's postgresql.conf must name ONLY
  // portable lc_* — a host-specific locale (en_US.utf8) baked here FATALs the
  // postmaster on the lean Windows WSL rootfs at first boot. startEmbeddedPostgresServer
  // normalizes on boot, but assert on the actual on-disk artifact so a future
  // regression (removed normalizer, changed package) fails the BUILD, not the user.
  const conf = await readFile(join(dataDir, 'postgresql.conf'), 'utf8');
  const badLc = confLcNonPortable(conf);
  if (badLc.length) {
    throw new Error(
      `seed postgresql.conf carries NON-PORTABLE locale(s): ${badLc.join(', ')} — `
      + `would FATAL first boot on a C/C.utf8/POSIX-only rootfs (WI-2749)`,
    );
  }
  log('seed locale portability check passed (all lc_* portable)');

  // Clean shutdown BEFORE archiving so the snapshot is consistent + carries no
  // postmaster.pid / recovery state (a fast, quiet startup on the target).
  log('stopping postgres cleanly ...');
  await handle.stop();
  handle = null;

  // Archive the PGDATA contents at archive-root so `tar -x -C <dataDir>` restores
  // PG_VERSION at <dataDir>/PG_VERSION.
  //
  // BOTH postmaster files are excluded because BOTH record BUILD-BOX ABSOLUTE PATHS,
  // and this archive ships inside the public desktop bundle:
  //   • postmaster.pid  — data-directory path (already excluded; defensive, a clean
  //                       stop removes it).
  //   • postmaster.opts — the full postmaster ARGV, including the absolute path to
  //                       the binary on the machine that built the seed. Measured
  //                       2026-08-08 in the shipping sidecar (P-012): the one
  //                       leaking member of 3,836 was postmaster.opts, carrying
  //                       /home/<builder>/…/src-tauri/sidecar.tmp.<pid>/node_modules/…
  //                       — the builder's username, home layout and workspace path.
  // Neither is needed to restore a seed: PG rewrites both on next start, and
  // postmaster.opts only exists to let `pg_ctl restart` recall prior options.
  // This was invisible for so long because the release identity scan used
  // `grep -rIlE`, and -I skips binary files, so it never opened the archive at all.
  await mkdir(dirname(outPath), { recursive: true });
  await rm(outPath, { force: true }).catch(() => {});
  log(`archiving seed → ${outPath}`);
  //
  // --owner=0 --group=0 --numeric-owner is LOAD-BEARING, not tidiness (WI-39458).
  // Without it `tar` stamps the BUILDING USER's account name into every member's
  // uid/gid NAME fields, and this archive ships inside the public desktop bundle.
  // Those fields are metadata — not a member's payload and not a member's path —
  // so they were invisible to the release identity gate's content grep AND to its
  // member-name manifest: measured 2026-08-16, a PGDATA seed whose contents were
  // clean expanded through the gate and certified `✓ CLEAN` exit 0 while carrying
  // the build-box username on every one of its members. The gate now reads
  // uname/gname too (audit-release-bundle.py `_expand_tar_memberwise`), which is
  // the backstop; this is the fix that stops producing the leak in the first
  // place. Numeric ownership is also strictly more correct for a seed that is
  // extracted as whatever user the target machine happens to run as.
  execFileSync(
    'tar',
    ['-c', '-z', '-f', outPath,
     '--owner=0', '--group=0', '--numeric-owner',
     '--exclude', './postmaster.pid', '--exclude', './postmaster.opts',
     '-C', dataDir, '.'],
    { stdio: 'inherit' },
  );

  const { size } = await stat(outPath);
  log(`seed built: ${(size / 1024 / 1024).toFixed(1)} MB`);
} catch (e) {
  console.error(`[build-seed] FAILED: ${e?.stack ?? e?.message ?? e}`);
  ok = false;
} finally {
  if (handle) await handle.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
// A failed seed build MUST be a red build. `process.exitCode = 1` alone was
// observed to exit 0 anyway — embedded-pg's own cleanup on the failure path
// resets the code — so the packaging wrapper's `if node build-seed.mjs; then`
// took the SUCCESS branch and shipped a bundle with NO seed. First boot then
// falls back to initdb + full migration replay, which re-hits the very
// migration failure that broke the seed (e.g. a view migration that can't
// apply on a fresh DB) and CRASHES the operator before it can serve — the
// exact WI-2902 first-boot failure. Exit hard + explicitly so a broken
// migration set is caught at BUILD time, never shipped.
if (!ok) process.exit(1);
