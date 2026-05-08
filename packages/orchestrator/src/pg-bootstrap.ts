/**
 * Optional PG client bootstrap for orchestrator CLI mode (activation
 * step 2). Reads connection config from env, attempts to connect, and
 * returns either a working client or `null` (in which case the
 * orchestrator falls back to the existing FS path — every dormant
 * Phase 1-7 module already handles `ctx.pg=undefined` gracefully).
 *
 * Activation is **opt-in**:
 *   - PAPERCUSP_USE_PG_STATE=1  → enable PG path; require connection
 *   - unset / 0                 → FS path (default; no connection attempt)
 *
 * Connection config:
 *   - PAPERCUSP_DATABASE_URL    → standard postgres URL
 *   - default: postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp
 *     (matches the operator's getOrgPg defaults — orchestrator runs on
 *     the same machine as the operator in CLI mode, same DB)
 *
 * The client is verified with a 1-second-timeout `SELECT 1` before
 * being returned. Connection failure → log + null → FS fallback.
 */
import postgres from 'postgres';
import type { OrchestratorPg } from './invoke';

const DEFAULT_DSN =
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

export interface BootstrapResult {
  pg: OrchestratorPg | null;
  /** When non-null, holds the underlying postgres-js handle for cleanup. */
  cleanup: (() => Promise<void>) | null;
  reason: 'opted-out' | 'connected' | 'connection-failed' | 'verification-failed';
}

/**
 * Attempt to bootstrap a PG client for the orchestrator. Returns null
 * for `pg` whenever the orchestrator should fall back to FS — never
 * throws.
 */
export async function bootstrapOrchestratorPg(
  log: (m: string) => void,
): Promise<BootstrapResult> {
  if (process.env.PAPERCUSP_USE_PG_STATE !== '1') {
    return { pg: null, cleanup: null, reason: 'opted-out' };
  }
  const dsn = process.env.PAPERCUSP_DATABASE_URL ?? DEFAULT_DSN;
  let client: ReturnType<typeof postgres>;
  try {
    client = postgres(dsn, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 5,
      // Disable postgres-js's process-exit refusal; orchestrator owns
      // its own lifecycle.
      onnotice: () => {},
    });
  } catch (e) {
    log(`PG bootstrap: connection setup failed: ${(e as Error).message} — falling back to FS`);
    return { pg: null, cleanup: null, reason: 'connection-failed' };
  }
  try {
    await client`SELECT 1 AS ok`;
  } catch (e) {
    log(`PG bootstrap: verification SELECT 1 failed: ${(e as Error).message} — falling back to FS`);
    try { await client.end({ timeout: 1 }); } catch { /* ignore */ }
    return { pg: null, cleanup: null, reason: 'verification-failed' };
  }
  log('PG bootstrap: connected; orchestrator running with ctx.pg active');
  // postgres-js's tagged-template signature satisfies OrchestratorPg
  return {
    pg: client as unknown as OrchestratorPg,
    cleanup: async () => {
      try { await client.end({ timeout: 5 }); } catch { /* ignore */ }
    },
    reason: 'connected',
  };
}
