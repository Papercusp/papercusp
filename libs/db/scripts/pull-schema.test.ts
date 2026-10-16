/**
 * Locks down the main-guard fix for EI-18786840446203185: `pull-schema.mjs`
 * runs at MODULE SCOPE (live DB introspection + rewrites
 * src/schema/*.ts in the shared tree), so a bare `import()` of it — the
 * ordinary way to check that a module loads/parses — used to EXECUTE it.
 * That accident happened for real: `node -e "import('./…/pull-schema.mjs')"`,
 * intended as a read-only load check, connected to the live papercusp DB and
 * clobbered the shared tree's generated schema file.
 *
 * The fix is a main-guard comparing `import.meta.url` to
 * `pathToFileURL(process.argv[1]).href` and throwing when they differ. Under
 * THIS test file, `process.argv[1]` is vitest's own entry — never
 * pull-schema.mjs — so importing it here exercises exactly the accident path
 * safely (the guard throws before any DB connection or fs write is reached).
 *
 * Deliberately NOT covered: the "run as the actual CLI entrypoint" success
 * path. That requires `process.argv[1]` to literally be this script, which
 * only happens via `node scripts/pull-schema.mjs` — at which point the guard
 * passes and the script goes on to hit a live DB and rewrite tree files. That
 * is exactly the side effect this file exists to keep OUT of a unit test; the
 * positive path is exercised by hand per the script's own doc comment
 * ("Run after any new .sql migration") and by CI's drift check, not here.
 */
import { describe, it, expect } from 'vitest';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('pull-schema.mjs main-guard (EI-18786840446203185)', () => {
  it('the real CLI refuses missing runtime policies before rewriting either mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'pull-schema-policies-'));
    try {
      // The CLI may write only inside this disposable tree, even if its guard
      // regresses. psql is a deterministic catalog fixture; no DB is contacted.
      const db = join(root, 'libs/papercusp/libs/db');
      const script = join(db, 'scripts/pull-schema.mjs');
      mkdirSync(dirname(script), { recursive: true });
      cpSync(new URL('../src/', import.meta.url), join(db, 'src'), {
        recursive: true,
        filter: (path) => statSync(path).isDirectory() || path.endsWith('.mjs'),
      });
      copyFileSync(new URL('./pull-schema.mjs', import.meta.url), script);
      symlinkSync(realpathSync(new URL('../../../../../node_modules', import.meta.url)),
        join(root, 'node_modules'), 'dir');
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(join(root, 'scripts/lib/fs-mutex.mjs'),
        'export async function withFsMutex(_name, run) { return run(); }');
      mkdirSync(join(db, 'sql'));
      writeFileSync(join(db, 'sql/000-baseline.sql'), '-- fixture');
      const schema = [
        'export const tenantRows = harnessShared.table("tenant_rows", {',
        '  id: text(),',
        '}, (table) => [',
        '  pgPolicy("tenant_rows_workspace_isolation", { for: "all" }),',
        ']);',
      ].join('\n');
      const schemaPath = join(db, 'src/schema/generated.ts');
      const relationsPath = join(db, 'src/schema/generated-relations.ts');
      writeFileSync(schemaPath, schema);
      writeFileSync(relationsPath, '// original relations');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'psql'), [
        '#!/usr/bin/env node',
        'const query = process.argv.at(-1);',
        'if (query.includes("pg_policies")) console.log("[]");',
        'else if (query.includes("json_build_object")) console.log(JSON.stringify({count:1,latestFilename:"000-baseline.sql",latestAppliedAt:null}));',
        'else if (query.includes("schema_migrations")) console.log("000-baseline.sql");',
        'else if (query === "SELECT 1") console.log("1");',
        'else process.exitCode = 2;',
      ].join('\n'), { mode: 0o755 });

      const result = spawnSync(process.execPath, [script], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, NODE_OPTIONS: '', PATH: `${bin}:${process.env.PATH}`,
          HARNESS_ADMIN_DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/fixture' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('REFUSING TO PULL: target lacks 1 policy/policies');
      expect(result.stderr).toContain('harness_shared.tenant_rows.tenant_rows_workspace_isolation');
      expect(readFileSync(schemaPath, 'utf8')).toBe(schema);
      expect(readFileSync(relationsPath, 'utf8')).toBe('// original relations');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses to run its side effects when merely IMPORTED, not executed as the CLI entrypoint', async () => {
    await expect(import('./pull-schema.mjs')).rejects.toThrow(
      /IMPORTED rather than run\. Refusing to execute/,
    );
  });

  it('the guard message names the safe alternative (`node --check`) so the fix is self-documenting', async () => {
    await expect(import('./pull-schema.mjs')).rejects.toThrow(/node --check/);
  });

  it('captures drizzle-kit stdout only for non-TTY runs before forwarding normalized output', () => {
    const source = readFileSync(new URL('./pull-schema.mjs', import.meta.url), 'utf8');

    expect(source).toContain('const captureDrizzleKitOutput = !process.stdout.isTTY;');
    expect(source).toContain('createSchemaCliSpawnOptions({');
    expect(source).toContain('normalizeSchemaCliOutput(result.stdout)');
  });

  it('holds the shared filesystem mutex across introspection and intermediate-file promotion', () => {
    const source = readFileSync(new URL('./pull-schema.mjs', import.meta.url), 'utf8');
    const runStart = source.indexOf('async function runPullSchema() {');
    const lockCall = source.indexOf('await withFsMutex(');
    const runBody = source.slice(runStart, lockCall);
    const lockTail = source.slice(lockCall);

    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(lockCall).toBeGreaterThan(runStart);
    expect(runBody).toContain("console.log('==> running drizzle-kit pull");
    expect(runBody).toContain('promoteGeneratedSchemaArtifacts({');
    expect(runBody).toContain('process.exitCode = result.status ?? 1;');
    expect(runBody).not.toMatch(/\bprocess\.exit\s*\(/);
    expect(lockTail).toMatch(
      /await withFsMutex\(\s*`papercusp-db-pull-schema:\$\{REAL_DB_ROOT\}`\s*,\s*runPullSchema\s*,/,
    );
  });

  it('fingerprints schema_migrations before introspection and re-checks it before the policy refusal and promotion (WI-10006614)', () => {
    const source = readFileSync(new URL('./pull-schema.mjs', import.meta.url), 'utf8');
    const fingerprint = source.indexOf('const catalogBefore = readMigrationFingerprint();');
    const introspect = source.indexOf('const introspectArgs = [');
    const policyRefusal = source.indexOf("'refusing to promote generated schema with unresolved pgPolicy predicates");
    const policyDriftCheck = source.indexOf("if (refuseOnCatalogDrift('at the pg_policies check')) return;");
    const promote = source.indexOf('promoteGeneratedSchemaArtifacts({ schemaPath');
    const promoteDriftCheck = source.indexOf("if (refuseOnCatalogDrift('before promotion')) return;");

    for (const at of [fingerprint, introspect, policyRefusal, policyDriftCheck, promote, promoteDriftCheck]) {
      expect(at).toBeGreaterThanOrEqual(0);
    }
    // The ledger is read before drizzle-kit can see the catalog...
    expect(fingerprint).toBeLessThan(introspect);
    // ...drift is diagnosed before the projector-blaming refusal prints...
    expect(policyDriftCheck).toBeLessThan(policyRefusal);
    // ...and a run that straddled a commit never promotes a mixed-catalog schema.
    expect(promoteDriftCheck).toBeLessThan(promote);
  });

  it('refuses a database that lags the armed migrations before any introspection (WI-6554700010008404)', () => {
    const source = readFileSync(new URL('./pull-schema.mjs', import.meta.url), 'utf8');
    const precheck = source.indexOf("spawnSync('psql', [dbUrl, '-tAc', 'SELECT 1']");
    const lagRead = source.indexOf("spawnSync('psql', [dbUrl, '-tA', '-c', APPLIED_MIGRATIONS_SQL]");
    const lagRefusal = source.indexOf('REFUSING TO PULL: ${message}');
    const fingerprint = source.indexOf('const catalogBefore = readMigrationFingerprint();');
    const introspect = source.indexOf('const introspectArgs = [');

    for (const at of [precheck, lagRead, lagRefusal, fingerprint, introspect]) {
      expect(at).toBeGreaterThanOrEqual(0);
    }
    // Only a reachable database is checked for lag...
    expect(precheck).toBeLessThan(lagRead);
    // ...and a lagging one is refused before drizzle-kit or any schema write runs.
    expect(lagRefusal).toBeLessThan(fingerprint);
    expect(lagRefusal).toBeLessThan(introspect);
    // The refusal sets a failing exit code and stops the run.
    const refusalBlock = source.slice(lagRefusal, lagRefusal + 200);
    expect(refusalBlock).toMatch(/process\.exitCode = 1;\s*return;/);
  });

  it('excludes drizzle-kit intermediate TypeScript files from the database package typecheck', () => {
    const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));

    expect(tsconfig.include).toContain('src/**/*.ts');
    expect(tsconfig.exclude).toEqual(
      expect.arrayContaining(['src/schema/schema.ts', 'src/schema/relations.ts']),
    );
  });
});
