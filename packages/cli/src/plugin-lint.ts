/**
 * `papercusp plugin lint` — Batch E2.
 *
 * Runs the same manifest validation the loader runs at runtime, but at
 * build time so plugin authors see schema errors before publishing.
 * Covers Rust-port-feedback item 8 (the "papercup plugin build"
 * equivalent for the TS side).
 *
 * Exit codes:
 *   0 — no issues
 *   1 — invalid manifest or missing entry point
 *   2 — usage error
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateManifest } from '@papercusp/plugin-loader/dist/manifest-validate.js';

const ENTRY_CANDIDATES = [
  'index.cjs', 'dist/index.cjs',
  'index.js', 'index.mjs', 'dist/index.js',
  'index.ts', 'src/index.ts',
];

export async function cmdPluginLint(args: string[]): Promise<void> {
  const dirArg = args.find((a) => !a.startsWith('--')) ?? '.';
  const dir = resolve(dirArg);
  const manifestPath = join(dir, 'papercusp.json');

  if (!existsSync(manifestPath)) {
    console.error(`✗ no papercusp.json found at ${manifestPath}`);
    process.exit(1);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(`✗ papercusp.json is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  // Schema validation (mirrors loader.readManifest).
  let result;
  try {
    result = validateManifest(manifest);
  } catch (e) {
    // Fallback: try the source path under the workspace, in case the
    // dist build hasn't been produced yet.
    const fallback = await import('../../../../packages/plugin-loader/src/manifest-validate.ts')
      .catch(() => null);
    if (!fallback) throw e;
    result = fallback.validateManifest(manifest);
  }

  let exit = 0;

  if (!result.ok) {
    console.error('✗ manifest invalid:');
    for (const issue of result.issues) {
      console.error(`  ${issue.path} — ${issue.message}`);
    }
    exit = 1;
  } else {
    console.log('✓ manifest schema OK');
  }

  // Entry-point sanity check — the loader rejects plugins whose entry
  // file isn't found, so flag that at lint time too.
  const entry = ENTRY_CANDIDATES.find((c) => existsSync(join(dir, c)));
  if (!entry) {
    console.error(
      `✗ no entry point found (looked for ${ENTRY_CANDIDATES.join(', ')})`,
    );
    exit = 1;
  } else {
    console.log(`✓ entry point: ${entry}`);
  }

  // capabilities[] sanity — declared caps must be non-empty strings; the
  // loader's hasCapability is forgiving but this catches typos before
  // runtime denials.
  const m = manifest as { capabilities?: unknown };
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      console.error('✗ capabilities must be an array');
      exit = 1;
    } else {
      const bad = m.capabilities.filter(
        (c) => typeof c !== 'string' || c.length === 0 || !c.includes(':'),
      );
      if (bad.length > 0) {
        console.error(`✗ capabilities contains invalid entries: ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
        exit = 1;
      } else {
        console.log(`✓ ${m.capabilities.length} capability declaration(s) look well-formed`);
      }
    }
  }

  process.exit(exit);
}
