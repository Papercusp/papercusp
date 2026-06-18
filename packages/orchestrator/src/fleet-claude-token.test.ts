/**
 * fleet-claude-token.test.ts — the box-local background-fleet OAuth token reader.
 * Security-relevant: a wrong read either leaks an interactive-family token onto
 * fleet children or silently mis-auths them. The load-bearing properties: the
 * path honors the PAPERCUSP_CLAUDE_TOKEN_PATH override (else ~/.papercusp/...),
 * and readFleetClaudeToken FAIL-SOFTs to null on missing/empty/implausible
 * content while accepting (trimmed) only `sk-ant-` tokens.
 *
 * Submodule unit test (orchestrator) — tab-NEUTRAL, genuine "entire app" coverage.
 * Run: cd libs/papercusp/packages/orchestrator && npx vitest run src/fleet-claude-token.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetClaudeTokenPath, readFleetClaudeToken } from './fleet-claude-token';

const dir = mkdtempSync(join(tmpdir(), 'fleet-tok-'));
const tokenFile = join(dir, 'claude-token');
const savedEnv = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;

beforeEach(() => {
  process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = tokenFile;
});
afterEach(() => {
  try { rmSync(tokenFile); } catch { /* may not exist */ }
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
  else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('fleetClaudeTokenPath', () => {
  it('honors the PAPERCUSP_CLAUDE_TOKEN_PATH override', () => {
    expect(fleetClaudeTokenPath()).toBe(tokenFile);
  });

  it('defaults to ~/.papercusp/claude-token when the override is unset', () => {
    delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    expect(fleetClaudeTokenPath().endsWith(join('.papercusp', 'claude-token'))).toBe(true);
  });
});

describe('readFleetClaudeToken', () => {
  it('returns a valid sk-ant- token, trimmed of surrounding whitespace', () => {
    writeFileSync(tokenFile, '  sk-ant-oat01-abc123\n');
    expect(readFleetClaudeToken()).toBe('sk-ant-oat01-abc123');
  });

  it('returns null for content that is not an sk-ant- token', () => {
    writeFileSync(tokenFile, 'not-a-real-token');
    expect(readFleetClaudeToken()).toBeNull();
  });

  it('returns null for an empty file', () => {
    writeFileSync(tokenFile, '   \n');
    expect(readFleetClaudeToken()).toBeNull();
  });

  it('fails soft to null when the token file does not exist', () => {
    // afterEach removed it; nothing written this test
    expect(readFleetClaudeToken()).toBeNull();
  });
});
