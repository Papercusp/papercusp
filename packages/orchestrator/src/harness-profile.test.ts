/**
 * harness-profile.test.ts — the cross-backend CONFORMANCE test.
 *
 * Ported from yc-software/qm's `test/harness-adapter.test.ts`, which asserts every
 * adapter's declared transport + capability matrix in ONE place. The point is not
 * to re-state the registry: it is that adding an `AgentBackend` member without
 * declaring its profile FAILS HERE, at the moment of the add, instead of silently
 * inheriting some other backend's spawn behavior and being discovered later as a
 * rotted path (invoke.ts's claude-code leg, 2026-05-31).
 *
 * So the first test is the load-bearing one — the rest pin the matrix that the
 * ~20 former inline `agentBackend === '…'` branches in invoke.ts now read from.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_BACKENDS } from './types';
import {
  allHarnessProfiles,
  harnessProfile,
  harnessSupports,
  type HarnessCapability,
} from './harness-profile';
import { backendUsesSrt, fleetSrtModelDomains } from './invoke';

describe('harness adapter profiles', () => {
  it('declares a profile for EVERY backend (adding one without a profile fails here)', () => {
    for (const backend of AGENT_BACKENDS) {
      expect(() => harnessProfile(backend), `backend '${backend}' has no declared profile`).not.toThrow();
      expect(harnessProfile(backend).id).toBe(backend);
    }
    expect(allHarnessProfiles()).toHaveLength(AGENT_BACKENDS.length);
  });

  it('pins each backend’s stream format', () => {
    expect(AGENT_BACKENDS.map((b) => harnessProfile(b).streamFormat)).toEqual([
      'claude-stream-json', // claude-code
      'omp-json', // omp
      'codex-json', // codex
    ]);
  });

  it('pins how the prompt reaches each child process', () => {
    expect(AGENT_BACKENDS.map((b) => harnessProfile(b).promptDelivery)).toEqual([
      'stdin', // claude-code — written to the child's stdin
      'argv-file', // omp — spilled to a temp file, trailing `@<path>` argv
      'stdin-dash', // codex exec — stdin, addressed by a trailing `-`
    ]);
  });

  it('pins the model-flag spelling (codex takes a bare -m)', () => {
    expect(harnessProfile('codex').modelFlag).toBe('-m');
    expect(harnessProfile('claude-code').modelFlag).toBe('--model');
    expect(harnessProfile('omp').modelFlag).toBe('--model');
  });

  it('pins the full capability matrix', () => {
    const matrix = Object.fromEntries(
      AGENT_BACKENDS.map((b) => [b, [...harnessProfile(b).capabilities].sort()]),
    );
    expect(matrix).toEqual({
      'claude-code': [
        'native-sandbox',
        'native-session-id',
        'resumable-config-dir',
        'subagent-tools',
        'system-prompt-override',
      ],
      omp: ['gateway-models-yml'],
      codex: ['resumable-config-dir'],
    });
  });

  it('every declared capability is claimed by at least one backend (no dead capability names)', () => {
    const declared: HarnessCapability[] = [
      'native-sandbox',
      'native-session-id',
      'resumable-config-dir',
      'subagent-tools',
      'system-prompt-override',
      'gateway-models-yml',
    ];
    for (const cap of declared) {
      expect(
        AGENT_BACKENDS.some((b) => harnessSupports(b, cap)),
        `capability '${cap}' is declared but no backend has it — invented for symmetry?`,
      ).toBe(true);
    }
  });
});

describe('invoke.ts predicates now read the profile (behavior preserved)', () => {
  // These pin the EXACT prior behavior of the inline conditionals the profile
  // replaced. A refactor that changed any of these would change spawn behavior.
  it('backendUsesSrt is still codex + omp — stated as "no native sandbox"', () => {
    expect(backendUsesSrt('codex')).toBe(true);
    expect(backendUsesSrt('omp')).toBe(true);
    expect(backendUsesSrt('claude-code')).toBe(false);
    // and it is genuinely derived, not a re-hardcoded list
    for (const b of AGENT_BACKENDS) {
      expect(backendUsesSrt(b)).toBe(!harnessSupports(b, 'native-sandbox'));
    }
  });

  it('fleetSrtModelDomains still returns codex’s OpenAI hosts and nothing for the others', () => {
    expect(fleetSrtModelDomains('codex')).toEqual([
      'api.openai.com',
      'chatgpt.com',
      'auth.openai.com',
      '*.openai.com',
    ]);
    expect(fleetSrtModelDomains('omp')).toEqual([]);
    expect(fleetSrtModelDomains('claude-code')).toEqual([]);
  });

  it('fleetSrtModelDomains returns a COPY — a caller cannot mutate the profile', () => {
    const first = fleetSrtModelDomains('codex');
    first.push('evil.example.com');
    expect(fleetSrtModelDomains('codex')).not.toContain('evil.example.com');
  });
});
