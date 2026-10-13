/**
 * agent-session-context-tier.ts — the ONE source of the response-payload tier (`?ctx_tier=`)
 * that every agent MCP URL asks for.
 *
 * The MCP host reads `ctx_tier` as the session's default `payloadTier`; with no tier a call
 * resolves to the unshaped 'full' payload (resolvePayloadTier: callTier ?? ctxTier ?? 'full').
 *
 * The rule is the one psu-launcher's contextTrimmingEnv records: TRIMMED for every launch,
 * every agent [owner 2026-08-10]. Two builders write agent MCP URLs, in separate processes:
 *   - the operator's role-launch-spec.ts (su homes, role-scoped spawns such as judges), and
 *   - this package's spawn-mcp.ts (fleet/pipeline worker spawns, the superuser spawn door).
 * Before WI-6554700010009993 / WI-6554700010010138 neither sent a tier. Measured 2026-10-13
 * over 3h: 46K untiered su calls (594MB) and 2.9K untiered judge calls, versus 8.5K tiered su
 * calls. The value lives here (not in operator-core) because operator-core already imports
 * `@papercusp/orchestrator/*`, while the orchestrator cannot import the operator app.
 *
 * `ctx_tier` is NOT in the signed-param allowlist (spawn-signing-core.ts), so like `tools` it
 * rides a signed spawn URL without changing the signature.
 *
 * Pure constant, no I/O.
 */
export const AGENT_SESSION_CONTEXT_TIER = 'trimmed' as const;
