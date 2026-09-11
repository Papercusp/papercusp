import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_SEARCH_DENY, nativeToolSearchDenyFlag } from './native-tool-search-deny';

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
