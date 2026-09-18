import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOL_SEARCH_DENY,
  nativeDeferralEnv,
  nativeDeferralReachable,
  nativeToolSearchDenyFlag,
} from './native-tool-search-deny';

describe('nativeToolSearchDenyFlag', () => {
  it('is one `=` token (the variadic space form would eat a trailing positional prompt)', () => {
    const flag = nativeToolSearchDenyFlag();
    expect(flag.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(flag)).toBe(false);
  });

  it("carries claude's native catalog-search tool", () => {
    // ToolSearch is the claude-code built-in that loads deferred MCP tool
    // schemas. Measured 2026-09-11 (WI-10001033): ONE call loading six schemas
    // cost +67,045 tokens — 17% of a session's budget — and it bypasses
    // applyResultDoor entirely, because that door is applied only in papercusp's
    // own MCP transport (_mcp-host.ts) and ToolSearch is a client built-in.
    expect(NATIVE_TOOL_SEARCH_DENY).toContain('ToolSearch');
    const flag = nativeToolSearchDenyFlag();
    for (const t of NATIVE_TOOL_SEARCH_DENY) expect(flag).toContain(t);
  });

  it('keeps every entry space-free so the comma join stays one token', () => {
    for (const t of NATIVE_TOOL_SEARCH_DENY) expect(/\s/.test(t)).toBe(false);
  });

  it('denies only NATIVE tool names — an mcp__* entry here would be false confinement', () => {
    // A client-side deny cannot withhold an MCP tool: tools:invoke { name, args }
    // dispatches server-side by name, without the server ever seeing the client's
    // deny list. Listing an mcp__* entry here would look like a boundary while
    // buying only discovery friction, so the guard pins the list to native names.
    // See /internal/docs/agent-insights/disallowed-tools-cannot-withhold-an-mcp-tool
    for (const t of NATIVE_TOOL_SEARCH_DENY) expect(t.startsWith('mcp__')).toBe(false);
  });

  it('does not deny the papercusp replacements it exists to route traffic to', () => {
    // The whole point is to force discovery onto tools:find / tools:invoke.
    // Denying either would strand every session — and note this is exactly the
    // failure the empirical check in the module doc rules out: with ToolSearch
    // denied, a raw `claude -p` session loaded 63 papercusp tools directly and
    // genuinely dispatched tools:invoke (vs 0 tools with ToolSearch allowed).
    const flag = nativeToolSearchDenyFlag();
    expect(flag).not.toContain('tools:find');
    expect(flag).not.toContain('tools:invoke');
    expect(flag).not.toContain('tools_find');
    expect(flag).not.toContain('tools_invoke');
  });
});

describe('nativeDeferralReachable / nativeDeferralEnv (P-007)', () => {
  it('reports deferral UNREACHABLE while ToolSearch is denied, so ENABLE_TOOL_SEARCH is withheld', () => {
    // ENABLE_TOOL_SEARCH exists only to force claude's native schema deferral back on for
    // gateway-routed sessions, and that deferral is conditional on ToolSearch existing. Setting
    // it under the deny turns on nothing: MEASURED 2026-09-18 on real captured /v1/messages
    // bodies, the pair injects a `DeferredToolPlaceholder` (defer_loading: true) representing an
    // empty deferred set, with no ToolSearch able to resolve it (66 tools vs 65 without).
    expect(nativeDeferralReachable()).toBe(false);
    expect(nativeDeferralEnv()).toEqual({});
  });

  it('is a REAL derivation, not a constant — lifting the deny restores the env', () => {
    // The load-bearing check. Asserting only "the env is empty" would pass identically against
    // `return false`, which would strand ENABLE_TOOL_SEARCH forever if the 2026-09-11 owner
    // lockout is ever lifted — silently re-costing every gateway-routed session the whole
    // catalog inline, the exact regression WI-2140943 was opened for.
    expect(nativeDeferralReachable([])).toBe(true);
    expect(nativeDeferralReachable(['SomethingElse'])).toBe(true);
    expect(nativeDeferralEnv(['SomethingElse'])).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
    // And it must still see ToolSearch when it is one of several denied names.
    expect(nativeDeferralReachable(['A', 'ToolSearch', 'B'])).toBe(false);
    expect(nativeDeferralEnv(['A', 'ToolSearch', 'B'])).toEqual({});
  });

  it('derives from the deny LIST, so the two can never be edited out of agreement', () => {
    // The invariant that makes the contradiction unrepresentable rather than merely detected:
    // whatever the deny list says, the env follows from it by construction.
    expect(nativeDeferralReachable(NATIVE_TOOL_SEARCH_DENY)).toBe(
      !NATIVE_TOOL_SEARCH_DENY.includes('ToolSearch'),
    );
    expect(Object.keys(nativeDeferralEnv(NATIVE_TOOL_SEARCH_DENY)).length).toBe(
      nativeDeferralReachable(NATIVE_TOOL_SEARCH_DENY) ? 1 : 0,
    );
  });
});
