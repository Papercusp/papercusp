import { defineConfig } from 'vitest/config';

/**
 * EI-7836: this package's tests are `node:test` (`src/**\/*.test.ts`, run via
 * `npm test` → `node --test src/**\/*.test.ts` — see package.json), NOT Vitest.
 * Without this file, a Vitest invocation whose root/glob reaches this package
 * (e.g. an agent's bare `vitest run <file>` from the repo root — there is no
 * root-level vitest.config.ts, so that default-globs `**\/*.test.ts` — or any
 * broader sweep that isn't scoped to this package's own `npm test`) imports
 * these files under Vitest's collector. Vitest doesn't recognize the
 * `describe`/`it` registered via `node:test` as tests, AND merely importing
 * the file executes its real integration side effects (spawns the CLI binary,
 * mkdtemps, hits a bogus marketplace URL) as an uncontrolled import side
 * effect — then Vitest reports "No test suite found in file …", which the
 * red-test watchdog (harness_shared.test_runs) recorded as a repeatedly-failing
 * test file even though the suite is genuinely green under its own `npm test`.
 *
 * `include: []` makes this package an explicit, empty Vitest project: any
 * Vitest invocation that resolves to (or auto-discovers) THIS config reports
 * zero tests cleanly instead of misinterpreting node:test files as broken
 * Vitest suites.
 */
export default defineConfig({
  test: {
    include: [],
    // An intentionally-empty Vitest project (see above) must not exit non-zero
    // just because it found zero tests — that would still read as "this
    // workspace's test run failed" to any broader sweep/gate.
    passWithNoTests: true,
  },
});
