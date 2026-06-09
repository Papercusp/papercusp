/**
 * session-launch-dirs.test.ts — the ONE keying contract every launch path AND
 * the wake-executor resume leg share (unify-launch-mechanics-2026-06-09 P-003).
 *
 * EI-153 was a launch↔resume key-DRIFT bug: the launch leg and the resume leg
 * each computed the per-session config dir from their own string literal, so a
 * drift between them (or two agents colliding on one shared dir) silently bled
 * conversation transcripts across agents. These helpers are the fix — every path
 * imports them, so:
 *   (a) two distinct owners get DISTINCT dirs (cross-agent isolation), and
 *   (b) the SAME owner gets the IDENTICAL dir no matter who computes it
 *       (launch == resume), by construction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sessionClaudeConfigDir,
  sessionMcpDir,
  sessionMcpJsonPath,
  codexHomeForSessionKey,
} from './session-launch-dirs';

const SAVED = {
  claude: process.env.PAPERCUSP_SESSION_CLAUDE_DIR,
  mcp: process.env.PAPERCUSP_SESSION_MCP_DIR,
  codex: process.env.PAPERCUSP_SU_CODEX_HOMES_DIR,
};

beforeEach(() => {
  process.env.PAPERCUSP_SESSION_CLAUDE_DIR = '/tmp/t-session-claude';
  process.env.PAPERCUSP_SESSION_MCP_DIR = '/tmp/t-session-mcp';
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = '/tmp/t-codex-homes';
});
afterEach(() => {
  for (const [k, v] of [
    ['PAPERCUSP_SESSION_CLAUDE_DIR', SAVED.claude],
    ['PAPERCUSP_SESSION_MCP_DIR', SAVED.mcp],
    ['PAPERCUSP_SU_CODEX_HOMES_DIR', SAVED.codex],
  ] as const) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('session-launch-dirs — cross-agent isolation (EI-153 keying contract)', () => {
  it('two DISTINCT owners → DISTINCT claude config dirs (no transcript bleed)', () => {
    const a = sessionClaudeConfigDir('role-aaa');
    const b = sessionClaudeConfigDir('s-bbb');
    expect(a).not.toBe(b);
    expect(a).toContain('role-aaa');
    expect(b).toContain('s-bbb');
  });

  it('the SAME owner → IDENTICAL dir however many times computed (launch == resume)', () => {
    // The launch leg and the resume leg both call this with the owner id off the
    // adv_sessions row; determinism per-owner is what makes them agree.
    expect(sessionClaudeConfigDir('owner-x')).toBe(sessionClaudeConfigDir('owner-x'));
    expect(sessionMcpDir('owner-x')).toBe(sessionMcpDir('owner-x'));
    expect(codexHomeForSessionKey(42)).toBe(codexHomeForSessionKey(42));
  });

  it('claude / mcp / codex dirs are distinct namespaces for one owner', () => {
    const claude = sessionClaudeConfigDir('owner-y');
    const mcp = sessionMcpDir('owner-y');
    const codex = codexHomeForSessionKey('owner-y');
    expect(new Set([claude, mcp, codex]).size).toBe(3);
  });

  it('sessionMcpJsonPath is the .mcp.json inside the owner mcp dir', () => {
    expect(sessionMcpJsonPath('owner-z')).toBe(`${sessionMcpDir('owner-z')}/.mcp.json`);
  });

  it('honors the env-root overrides (so the multi-session testbed + tests can isolate)', () => {
    expect(sessionClaudeConfigDir('o')).toBe('/tmp/t-session-claude/o');
    expect(sessionMcpDir('o')).toBe('/tmp/t-session-mcp/o');
    expect(codexHomeForSessionKey('o')).toBe('/tmp/t-codex-homes/session-o');
  });
});
