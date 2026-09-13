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
import { readFileSync } from 'node:fs';

describe('pull-schema.mjs main-guard (EI-18786840446203185)', () => {
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
});
