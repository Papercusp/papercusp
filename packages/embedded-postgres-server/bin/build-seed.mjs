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
  // PG_VERSION at <dataDir>/PG_VERSION. Exclude the pid lock (should already be
  // gone after a clean stop) defensively.
  await mkdir(dirname(outPath), { recursive: true });
  await rm(outPath, { force: true }).catch(() => {});
  log(`archiving seed → ${outPath}`);
  execFileSync('tar', ['-c', '-z', '-f', outPath, '--exclude', './postmaster.pid', '-C', dataDir, '.'], { stdio: 'inherit' });

  const { size } = await stat(outPath);
  log(`seed built: ${(size / 1024 / 1024).toFixed(1)} MB`);
} catch (e) {
  console.error(`[build-seed] FAILED: ${e?.stack ?? e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  if (handle) await handle.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
