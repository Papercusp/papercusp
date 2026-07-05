import { describe, expect, it } from 'vitest';
import { NO_SUBAGENT_TOOLS_DENY, noSubagentToolsDenyFlag } from './no-subagent-deny';

describe('noSubagentToolsDenyFlag', () => {
  it('is one `=` token (the variadic space form would eat a trailing positional prompt)', () => {
    const flag = noSubagentToolsDenyFlag();
    expect(flag.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(flag)).toBe(false);
  });

  it('carries the subagent-tool names AND the Workflow orchestrator (2026-07-05)', () => {
    // Task: pre-rename name, verified against claude 2.1.158. Agent: current
    // name as of claude 2.1.198 — re-verifying live found the `Task`-only
    // deny had become a silent no-op (a spawned Agent-tool subagent still ran).
    // Workflow: the SEPARATE multi-agent orchestration tool — a subagents-denied
    // session was still fanning out through it because the deny listed only Task/Agent.
    expect(NO_SUBAGENT_TOOLS_DENY).toContain('Task');
    expect(NO_SUBAGENT_TOOLS_DENY).toContain('Agent');
    expect(NO_SUBAGENT_TOOLS_DENY).toContain('Workflow');
    const flag = noSubagentToolsDenyFlag();
    for (const t of NO_SUBAGENT_TOOLS_DENY) expect(flag).toContain(t);
  });

  it('keeps every entry space-free so the comma join stays one token', () => {
    for (const t of NO_SUBAGENT_TOOLS_DENY) expect(/\s/.test(t)).toBe(false);
  });
});
