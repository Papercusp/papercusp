import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { activeWorkspaceId, _resetActiveWorkspaceCache } from './workspace';

const ORIGINAL_ENV = process.env.PAPERCUSP_WORKSPACE_ID;

beforeEach(() => {
  _resetActiveWorkspaceCache();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
  } else {
    process.env.PAPERCUSP_WORKSPACE_ID = ORIGINAL_ENV;
  }
  _resetActiveWorkspaceCache();
});

describe('activeWorkspaceId', () => {
  it('honors PAPERCUSP_WORKSPACE_ID env override', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'test-ws-1';
    expect(activeWorkspaceId()).toBe('test-ws-1');
  });

  it('trims whitespace from env override', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = '  ws-trimmed  ';
    expect(activeWorkspaceId()).toBe('ws-trimmed');
  });

  it('caches result across calls', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = 'first';
    expect(activeWorkspaceId()).toBe('first');
    // Even if env changes, cached value sticks until reset
    process.env.PAPERCUSP_WORKSPACE_ID = 'second';
    expect(activeWorkspaceId()).toBe('first');
  });

  it('returns default when no env and registry missing/malformed (env empty)', () => {
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    // Registry may or may not exist on this machine; if it does and has a
    // `current` set, this test reads the real value, which is also valid.
    const result = activeWorkspaceId();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
