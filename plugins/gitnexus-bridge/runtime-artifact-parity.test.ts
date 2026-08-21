/**
 * Recurrence guard for the gitnexus-bridge source/runtime drift.
 *
 * THE DEFECT THIS EXISTS TO CATCH: `index.cjs` — the artifact the plugin host
 * actually loads — was hand-maintained as a mirror of `index.ts`. It drifted:
 * the whole TOOL_OVERRIDES block (the agent-facing tool descriptions and
 * routing guidance) lived in the TypeScript source and never reached the
 * runtime, so agents saw upstream GitNexus's own descriptions and none of the
 * local corrective guidance. Nothing failed — both files parsed, both ran.
 *
 * `index.cjs` is now GENERATED. These tests fail if it is stale or hand-edited.
 *
 * Plan: code-intelligence-routing-lsp-gitnexus-2026-08-20, D-004 / P-005.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(PLUGIN_DIR, '../../../..');
const GENERATOR = join(REPO_ROOT, 'scripts/gen-gitnexus-bridge-runtime.mjs');
const ARTIFACT = join(PLUGIN_DIR, 'index.cjs');

describe('gitnexus-bridge runtime artifact', () => {
  it('is up to date with index.ts (regenerate with: npm run gen:gitnexus-bridge)', () => {
    // The generator's own --check is the single source of truth for staleness,
    // so this test cannot drift from the build step it guards.
    expect(() =>
      execFileSync('node', [GENERATOR, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    ).not.toThrow();
  });

  it('is marked generated so nobody hand-edits it again', () => {
    const artifact = readFileSync(ARTIFACT, 'utf8');
    expect(artifact).toContain('GENERATED runtime artifact. DO NOT EDIT');
    expect(artifact).toContain('npm run gen:gitnexus-bridge');
  });

  it('ships the agent-facing tool guidance that the hand-written mirror omitted', () => {
    // The original defect in its most direct form: overrides present in source,
    // absent from runtime. Assert on the runtime artifact specifically.
    const artifact = readFileSync(ARTIFACT, 'utf8');
    expect(artifact).toContain('TOOL_OVERRIDES');
    expect(artifact).toContain('notWhen');
  });

  it('spawns a resolved absolute executable, never a bare PATH name', () => {
    // The live outage (spawn gitnexus ENOENT under the operator's frozen PATH)
    // registered ZERO tools rather than raising — indistinguishable to an agent
    // from "gitnexus has nothing to say".
    const artifact = readFileSync(ARTIFACT, 'utf8');
    expect(artifact).toContain('resolveGitnexusExecutable');
    expect(artifact).not.toMatch(/spawn\(\s*['"]gitnexus['"]/);
  });

  it('exposes the export shape the plugin host loads', () => {
    // Load exactly the way the plugin host does — CommonJS require(). Going
    // through ESM import() here would assert on the test runner's CJS interop
    // rather than on this artifact's contract.
    const require = createRequire(import.meta.url);
    const plugin = require(ARTIFACT) as Record<string, unknown>;
    expect(plugin.name).toBe('@papercupai/gitnexus-bridge');
    expect(typeof plugin.getDynamicTools).toBe('function');
    expect(typeof plugin._resetChildrenForTests).toBe('function');
    expect(plugin.tools).toEqual({});
  });
});
