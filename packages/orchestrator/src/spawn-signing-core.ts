/**
 * spawn-signing-core.ts — the ONE source of the spawn-URL signing PRIMITIVES:
 * the signed-param allowlist, the canonicalization rule, and the HMAC.
 *
 * Background (unify-launch-mechanics follow-on — signing dedup): the signer
 * (`apps/operator` → `packages/operator-core/lib/spawn-signing.ts`) and the
 * orchestrator's spawn-time signer (`spawn-mcp.ts`) run in SEPARATE processes, so
 * the orchestrator can't import the operator app. The allowlist + canonicalization
 * + HMAC were therefore DUPLICATED in both, with a "keep in lockstep or signatures
 * mismatch" comment — a real drift hazard (add a param on one side only → every
 * spawned agent's signed MCP URL fails to verify).
 *
 * The fix: both processes CAN import this orchestrator-package module (operator-core
 * already imports `@papercusp/orchestrator/*`; spawn-mcp imports it as a sibling),
 * so the primitives live here ONCE. Per-process KEY LOADING stays in each file
 * (they read the key from PG via genuinely different clients/caches) — only the
 * pure crypto rule is shared, which is exactly the part that must never drift.
 *
 * Pure (crypto + string math), no I/O, no PG, no domain coupling beyond the
 * papercusp param names.
 */
import { createHmac } from 'node:crypto';

/**
 * Params that are part of the signed envelope. Order doesn't matter — the
 * canonicalization sorts them. A param NOT in this set is ignored by the
 * canonicalizer, so a forger can't sneak an extra signed param in, and the
 * verifier can't be tricked by reordering or appending.
 */
export const SIGNED_PARAM_ALLOWLIST: ReadonlySet<string> = new Set([
  'harness',
  'workspace',
  'role',
  'run',
  'spawn',
  'feature',
  'chunk',
  'parent_spawn',
  'client',
  'exp',
]);

export type CanonicalizeResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: string };

/**
 * Canonical string built from the signed-allowlist params (sorted by name, joined
 * with `&`, values `encodeURIComponent`-encoded). Ignores `sig` itself and any
 * param not in the allowlist. Rejects duplicate keys — otherwise a forger could
 * append `&role=operator` AFTER the signed one and have the parser pick the later
 * value (reason `duplicate_param:<key>`).
 */
export function canonicalizeSpawnParams(params: URLSearchParams): CanonicalizeResult {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) return { ok: false, reason: `duplicate_param:${k}` };
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ok: true,
    canonical: pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'),
  };
}

/** HMAC-SHA256 of a canonical string with the given key → raw bytes. The signer
 *  formats it (`.toString('base64url')`); the verifier compares raw bytes via
 *  `timingSafeEqual`. */
export function hmacSpawnBytes(key: Buffer, canonical: string): Buffer {
  return createHmac('sha256', key).update(canonical).digest();
}
