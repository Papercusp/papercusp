/**
 * Tests for the env resolvers not covered by env.test.ts: agent-backend
 * inference, agent-cmd resolution, and path derivation.
 * Run with: npx vitest run packages/orchestrator/src/env-resolve.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentBackend, resolveAgentCmd, resolvePaths } from './env';

const KEYS = ['AGENT_BACKEND', 'AGENT_CMD', 'CLAUDE', 'PROJECT_DIR'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveAgentBackend', () => {
  it('honors an explicit AGENT_BACKEND (with aliases)', () => {
    for (const [v, expected] of [
      ['omp', 'omp'], ['pi', 'omp'], ['claude-code', 'claude-code'], ['claude', 'claude-code'], ['codex', 'codex'],
    ] as const) {
      process.env.AGENT_BACKEND = v;
      expect(resolveAgentBackend('whatever')).toBe(expected);
    }
  });

  it('infers from the agent command binary when no env var is set', () => {
    expect(resolveAgentBackend('omp run')).toBe('omp');
    expect(resolveAgentBackend('/usr/local/bin/pi --x')).toBe('omp');
    expect(resolveAgentBackend('codex -m gpt-5')).toBe('codex');
    expect(resolveAgentBackend('claude -p')).toBe('claude-code');
    expect(resolveAgentBackend('')).toBe('claude-code'); // default
  });

  it('lets the explicit env var win over command inference', () => {
    process.env.AGENT_BACKEND = 'omp';
    expect(resolveAgentBackend('claude -p')).toBe('omp');
  });
});

describe('resolveAgentCmd', () => {
  it('prefers AGENT_CMD, then CLAUDE, then the default', () => {
    process.env.AGENT_CMD = 'myagent --flag';
    expect(resolveAgentCmd()).toBe('myagent --flag');
    delete process.env.AGENT_CMD;
    process.env.CLAUDE = 'claude-legacy';
    expect(resolveAgentCmd()).toBe('claude-legacy');
    delete process.env.CLAUDE;
    expect(resolveAgentCmd()).toBe('claude -p');
  });

  it('ignores a blank AGENT_CMD and falls through', () => {
    process.env.AGENT_CMD = '   ';
    process.env.CLAUDE = 'claude-x';
    expect(resolveAgentCmd()).toBe('claude-x');
  });
});

describe('resolvePaths', () => {
  it('derives the state + log dirs from PROJECT_DIR', () => {
    process.env.PROJECT_DIR = '/proj';
    const p = resolvePaths();
    expect(p.projectDir).toBe('/proj');
    expect(p.stateDir).toBe('/proj/.papercusp');
    expect(p.logDir).toBe('/proj/.papercusp/logs');
    expect(typeof p.harnessDir).toBe('string');
  });

  it('defaults projectDir to cwd when PROJECT_DIR is unset', () => {
    const p = resolvePaths();
    expect(p.projectDir).toBe(process.cwd());
  });
});
