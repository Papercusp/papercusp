/**
 * Native client tool-search lockout for agent sessions (owner request,
 * 2026-09-11).
 *
 * Papercusp owns a tool-discovery pair — `tools:find` (search the ~550-tool
 * catalog by intent) and `tools:invoke` (call any catalog tool by name). Every
 * CLIENT also ships its own: claude-code's `ToolSearch`, omp's
 * `search_tool_bm25`. Routing discovery through the client's version is
 * expensive in a way that is invisible to every guard we own, so agent
 * launches deny it and the papercusp pair becomes the only route.
 *
 * WHY — measured 2026-09-11 on a live su session (WI-10001033):
 *   • ONE `ToolSearch` call loading SIX tool schemas cost **+67,045 tokens** —
 *     17% of that session's entire context budget, in a single hop. Steady
 *     state for every other call that turn was ~5k.
 *   • It bypasses `applyResultDoor`, which caps every tool result at ~1,500
 *     tokens and spills the remainder to scratch. That door is applied in
 *     exactly one dispatch path — `endpoint-route/routes/transport/_mcp-host.ts`
 *     (papercusp's MCP transport) — and `ToolSearch` is a client built-in that
 *     never transits it. Measured overshoot: ~45x the cap.
 *   • The per-tool prompt-weight budget cannot see it either: `promptWeight()`
 *     in `agent-tools/tool-guidance-budget.ts` takes `{ description, guidance }`
 *     and is STRUCTURALLY unable to receive `inputSchema`, where nearly all of a
 *     schema's bytes live. BUDGET is 1500 chars against ~40k chars actually
 *     injected per tool, so ~96% of the real weight is outside the guard.
 *   • `tools:find` for the same job measured ~4k/tool (vs ~11k), AND self-bounded
 *     (`{ count:3, totalMatches:8, truncated:true }`) because the door applies.
 *     `tools:invoke` costs ZERO schema tokens — it dispatches server-side, so the
 *     schema never enters context at all.
 *
 * ⚠ THE OBVIOUS FEAR IS WRONG — VERIFIED EMPIRICALLY, TWICE. The natural
 * objection is that denying `ToolSearch` strands the session: claude-code
 * DEFERS mcp tool schemas and tells the agent to use `ToolSearch` to load
 * them, so on a normal session even `tools:invoke` itself arrives deferred.
 * Denying the only retrieval tool therefore looks like it leaves an agent with
 * zero reachable papercusp tools. It does not — the deferral is CONDITIONAL ON
 * `ToolSearch` EXISTING. Measured 2026-09-11 with `claude --disallowedTools=ToolSearch -p`:
 *   1. self-report: `{"has_toolsearch": false, "papercusp_tool_count": 63,
 *      "can_reach_tools_invoke": true}` — the client stopped deferring and
 *      loaded a working set directly; and
 *   2. REAL DISPATCH (a model's self-report about its own toolset is not
 *      evidence, so this is the load-bearing check): the same denied session was
 *      instructed to actually CALL `mcp__papercusp-su__tools_invoke`, and it
 *      returned `CALL_OK:{"query":"ping","count":3,"totalMatches":8,...}` — a
 *      genuine server round-trip.
 * Re-run both arms before trusting this claim against a new claude build; the
 * deferral policy is closed-source and can change under us, exactly as the
 * subagent tool's NAME did (see no-subagent-deny.ts).
 *
 * ⚠ CLIENT-SIDE DENY, SO NATIVE TOOLS ONLY. `--disallowedTools` is enforced by
 * the client, and `ToolSearch` is a NATIVE claude tool, which is why this works.
 * Do NOT extend this list with an `mcp__*` entry expecting confinement: an MCP
 * tool executes server-side and the permitted `tools:invoke { name, args }`
 * re-reaches it by name without the server ever seeing the client's deny list.
 * An `mcp__*` deny buys discovery friction, not a boundary. Full write-up:
 * /internal/docs/agent-insights/disallowed-tools-cannot-withhold-an-mcp-tool
 *
 * OTHER CLIENTS. omp already does this by a different mechanism and needs no
 * flag here: `su-session-rpc-engine.ts` builds its session config with
 * `writeOmpSessionConfigDir({ discoveryOff: true, toolsAllowlist: ompCoreToolNames(env) })`,
 * which turns omp's native `search_tool_bm25` discovery off AND pins the
 * papercusp fallback in the allowlist.
 *
 * ⚠ CODEX IS NOT COVERED AND IS A KNOWN OPEN GAP — do not read this module as
 * "all clients handled". An earlier revision of this comment claimed codex had
 * "nothing of this shape to deny"; that was WRONG, inferred from the absence of
 * OUR config on its launch path rather than from codex itself, and is retracted.
 * Codex ships the SAME mechanism as claude — deferred MCP tool schemas plus a
 * search tool that loads them. Evidence, read out of the codex binary
 * (@openai/codex-linux-x64 .../bin/codex) on 2026-09-11, with a positive control
 * confirming the search could see known builtins (shell=266, apply_patch=88):
 *   • `tool_search_output` and `tool_search_call` are first-class ResponseItem
 *     variants, siblings of `web_search_call` / `function_call`;
 *   • the literal parameter description "Search query for deferred tools.";
 *   • `DynamicToolFunctionSpec { description, inputSchema, deferLoading }`;
 *   • `tools.deferred_namespaces`, "Added/Removed deferred tool namespaces";
 *   • flag-shaped names `tool_search` and `tool_search_always_defer_mcp_tools`.
 * `--disallowedTools` cannot carry this: it is a claude flag, and codex is
 * launched as `codex … app-server` and configured through `-c key=value` /
 * config.toml instead (see su-session-rpc-engine.ts, the codex branch).
 *
 * THE LEVER IS NOT YET KNOWN — do NOT guess it. `[features] tool_search = false`
 * (mirroring the existing `codexManagedFeaturesToml()` block in
 * codex-gateway-config.ts, which already sets `memories` and
 * `remote_compaction_v2`) is the OBVIOUS candidate and is UNVERIFIED. It was not
 * shipped because the check that would confirm it came back inconclusive: codex
 * SILENTLY ACCEPTS unknown feature keys — a deliberately fake
 * `features.definitely_not_a_real_flag_xyz` produced output byte-identical to a
 * known-good key, so a startup probe cannot tell a real lever from a no-op, and
 * writing the config anyway would buy false confidence rather than a deny.
 * Settle it by enumerating a LIVE codex session's actual tool surface with and
 * without the candidate key (blocked 2026-09-11: the codex account pool was
 * fully walled — 0 of 7 serviceable, and the default route was also usage-capped
 * — so no model turn could be obtained on any route).
 *
 * A SEPARATE `--disallowedTools=` token from the other deny flags (claude unions
 * repeated occurrences — verified live), so this stays independently revertible
 * and cannot disturb their lockstep-pinned literals. MUST stay one `=` token:
 * the flag is variadic and the space form greedily eats every following argv
 * element, including a trailing positional prompt.
 *
 * psu-launcher.mjs (plain-node, can't import TS) duplicates the rendered
 * literal; the lockstep test in apps/operator/lib/psu-launcher.test.ts pins the
 * two copies together — mirrors the native-scheduler-deny + no-subagent-deny
 * pattern.
 */

/** The client's own catalog-search tool, denied so discovery routes through
 *  papercusp's `tools:find` / `tools:invoke`. Disallowing a name absent from a
 *  given CLI build is a harmless no-op, so a future client's equivalent can be
 *  added here defensively — but verify a NEW name live before trusting it, the
 *  way Task/Agent had to be (a deny is observably IDENTICAL to a never-seeded
 *  tool, so never confirm one without a same-server, same-tier control). */
export const NATIVE_TOOL_SEARCH_DENY = ['ToolSearch'] as const;

/** The ready-to-append argv token (claude CLI). Single `=` token — see the
 *  greed-guard note above. */
export function nativeToolSearchDenyFlag(): string {
  return `--disallowedTools=${NATIVE_TOOL_SEARCH_DENY.join(',')}`;
}
