/**
 * WI-832: the org-pool DEFAULT statement_timeout seam — the source-level fix for the
 * unbounded admin-pool interactive-write class (follow-on to WI-766 / pg-bounded-txn).
 *
 * connection.ts is a PURE low-level lib and must NOT read operator-core runtime config
 * (layering). The boot path INJECTS a provider via setAdminPoolStatementTimeoutProvider;
 * buildClient reads it at connection-construction and, ONLY when > 0, sets the
 * `statement_timeout` connection GUC (right beside idle_in_transaction_session_timeout).
 * Default `() => 0` ⇒ the GUC is omitted ⇒ byte-identical to the pre-WI-832 connection
 * opts (the admin pool stays deliberately unbounded; migrations share it).
 *
 * Source-level contract (same approach as connection-connect-timeout.test.ts): the GUC
 * wiring is asserted against the source — exercising a real per-statement cap would need
 * a live DB + a deliberately-slow query, and the postgres-js connection-GUC mechanism
 * itself is already proven live by idle-in-tx-timeout.integration.test.ts (identical
 * shape). The behavior of the provider/guard is exercised below against the real exports.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectionOptions, setAdminPoolStatementTimeoutProvider } from './connection';

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'connection.ts'),
  'utf8',
);

function buildClientBody(): string {
  const m = SRC.match(/function buildClient\([^)]*\)[^{]*\{([\s\S]+?)^\}/m);
  expect(m, 'buildClient() must exist').toBeTruthy();
  return m![1];
}

describe('connection: org-pool default statement_timeout seam (WI-832)', () => {
  it('exports an injectable provider (the layering-safe seam) — connection.ts reads it, never operator-core config', () => {
    expect(typeof setAdminPoolStatementTimeoutProvider).toBe('function');
    // The module-level provider DEFAULTS to () => 0 (off) — no GUC, today's behavior.
    // (Non-greedy across the `: () => number` type annotation to the `= () => 0` assignment.)
    expect(SRC).toMatch(/let _adminStatementTimeoutMsProvider[\s\S]*?=\s*\(\)\s*=>\s*0/);
  });

  it('adminStatementTimeoutMs() guards: a throwing provider can never break connection construction, and only a positive value is honored', () => {
    const m = SRC.match(/function adminStatementTimeoutMs\(\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'adminStatementTimeoutMs() must exist').toBeTruthy();
    const body = m![1];
    expect(body, 'must be wrapped in try/catch → 0').toMatch(/catch[\s\S]*=\s*0/);
    expect(body, 'must floor to 0 unless strictly positive').toMatch(/v\s*>\s*0\s*\?\s*v\s*:\s*0/);
  });

  it('buildClient computes stmtTimeoutMs from the injected provider', () => {
    expect(buildClientBody()).toMatch(/stmtTimeoutMs\s*=\s*adminStatementTimeoutMs\(\)/);
  });

  it('buildConnectionOptions emits statement_timeout ONLY when bounded (>0) AND the connection is DIRECT — default 0, or pooled, ⇒ omitted', () => {
    // WI-832's per-statement cap is a libpq STARTUP param under postgres-js. A transaction
    // pooler (PgBouncer) rejects it ("unsupported startup parameter: statement_timeout"), and
    // a startup GUC does not survive transaction pooling anyway — so when pooled it is OMITTED
    // and enforced per-tx via SET LOCAL instead. Direct connections keep the >0 cap.
    const base = { searchPath: '"harness_shared", "public"', applicationName: 'pcusp:org:p1', idleInTxMs: 60000 };
    // bounded + DIRECT → present
    expect(buildConnectionOptions({ ...base, stmtTimeoutMs: 30000, pooled: false }).statement_timeout).toBe('30000');
    // unset (0) + DIRECT → omitted (admin pool stays unbounded for migrations until the owner flips a value)
    expect(buildConnectionOptions({ ...base, stmtTimeoutMs: 0, pooled: false })).not.toHaveProperty('statement_timeout');
    // bounded but POOLED → omitted (the PgBouncer-safety fix; enforced per-tx via SET LOCAL)
    expect(buildConnectionOptions({ ...base, stmtTimeoutMs: 30000, pooled: true })).not.toHaveProperty('statement_timeout');
  });

  it('the setter is null-safe — a non-function argument falls back to the () => 0 no-op (never an unset/throwing provider)', () => {
    const m = SRC.match(/function setAdminPoolStatementTimeoutProvider\([^)]*\)[^{]*\{([\s\S]+?)^\}/m);
    expect(m, 'setAdminPoolStatementTimeoutProvider() must exist').toBeTruthy();
    expect(m![1]).toMatch(/typeof fn === 'function'\s*\?\s*fn\s*:\s*\(\)\s*=>\s*0/);
    // Calling it with a bad value must not throw (defensive boot wiring).
    expect(() => setAdminPoolStatementTimeoutProvider(undefined as unknown as () => number)).not.toThrow();
    // Restore the no-op default so the process/other tests keep today's behavior.
    setAdminPoolStatementTimeoutProvider(() => 0);
  });
});
