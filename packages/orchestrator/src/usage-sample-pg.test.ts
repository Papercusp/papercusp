/**
 * Tests for the pure usage-sample classifiers (backend→provider, model→class).
 * Run with: npx vitest run packages/orchestrator/src/usage-sample-pg.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  providerForBackend,
  modelClassForRun,
  recordUsageSamplePg,
  type UsageSamplePgContext,
} from './usage-sample-pg';
import { AGENT_BACKENDS } from './types';
import { harnessProfile } from './harness-profile';

/** A fake `pg` tagged-template that captures the interpolated VALUES of the one
 *  INSERT recordUsageSamplePg issues, so we can assert what gets persisted
 *  without a database. */
function capturingPg(): { pg: UsageSamplePgContext['pg']; values: () => unknown[] } {
  let captured: unknown[] = [];
  const pg = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    captured = vals;
    return Promise.resolve([] as unknown[]);
  }) as unknown as UsageSamplePgContext['pg'];
  return { pg, values: () => captured };
}

describe('providerForBackend', () => {
  it('derives every declared backend from its runtime adapter profile', () => {
    for (const backend of AGENT_BACKENDS) {
      expect(providerForBackend(backend)).toBe(harnessProfile(backend).provider);
    }
  });

  it('fails closed to "unknown" for an undeclared backend', () => {
    expect(providerForBackend('something-else')).toBe('unknown');
  });
});

describe('modelClassForRun', () => {
  it('derives self-pacing collapse from the runtime adapter profile', () => {
    for (const backend of AGENT_BACKENDS) {
      expect(modelClassForRun(backend, 'claude-opus-4-8')).toBe(
        harnessProfile(backend).selfPacing ? 'self' : 'opus',
      );
    }
  });

  it('buckets by model family (case-insensitive)', () => {
    expect(modelClassForRun('claude-code', 'claude-opus-4-8')).toBe('opus');
    expect(modelClassForRun('claude-code', 'CLAUDE-SONNET-4-6')).toBe('sonnet');
    expect(modelClassForRun('claude-code', 'claude-haiku-4-5')).toBe('haiku');
  });

  it('falls back to "default" for an unrecognized model', () => {
    expect(modelClassForRun('codex', 'gpt-5')).toBe('default');
    expect(modelClassForRun('claude-code', '')).toBe('default');
  });
});

describe('recordUsageSamplePg — session attribution (bee-context-efficiency P-001)', () => {
  it('persists session_id alongside run_id/role so warm-inject samples group by session', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      {
        backend: 'claude-code',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheCreationTokens: 0 },
        harnessSlug: 'h',
        runId: 'opspawn-1',
        role: 'cup',
        sessionId: 'sess-abc',
      },
    );
    const v = values();
    // INSERT tail order is …session_id, tool_name, turn_trigger, account_id.
    expect(v[v.length - 4]).toBe('sess-abc'); // session_id
    expect(v).toContain('opspawn-1'); // run_id still flows
    expect(v).toContain('cup'); // role still flows
    expect(v).toContain(5000); // cache_read_tokens (the carry signal)
  });

  it('persists tool_name + turn_trigger + account_id attribution as the tail values', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      {
        backend: 'claude-code',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 100, outputTokens: 20 },
        runId: 'opspawn-2',
        role: 'cup',
        sessionId: 'sess-xyz',
        toolName: 'accounts:set-egress',
        turnTrigger: 'coord-wake',
        accountId: 'acct-claude-a',
      },
    );
    const v = values();
    // …session_id, tool_name, turn_trigger, account_id — the last four values.
    expect(v[v.length - 4]).toBe('sess-xyz'); // session_id
    expect(v[v.length - 3]).toBe('accounts:set-egress'); // tool_name
    expect(v[v.length - 2]).toBe('coord-wake'); // turn_trigger (B-TOK-4)
    expect(v[v.length - 1]).toBe('acct-claude-a'); // account_id (P-015)
  });

  it('null-safes tool_name + turn_trigger + account_id when a run supplies none', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'claude-code', model: 'm', usage: { inputTokens: 1 }, runId: 'r', role: 'cup', sessionId: 's' },
    );
    const v = values();
    expect(v[v.length - 3]).toBeNull(); // tool_name → NULL
    expect(v[v.length - 2]).toBeNull(); // turn_trigger → NULL (B-TOK-4)
    expect(v[v.length - 1]).toBeNull(); // account_id → NULL
  });

  it('null-safes session_id for backends with no native session id (omp/codex)', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'codex', model: 'gpt-5', usage: { inputTokens: 50 }, runId: 'r', role: 'cup' },
    );
    const v = values();
    expect(v[v.length - 4]).toBeNull(); // session_id undefined -> NULL, never a fabricated value
  });

  it('no-ops (no INSERT) on an empty usage so an unparseable run never fabricates a row', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'claude-code', model: 'm', usage: {}, runId: 'r', role: 'cup', sessionId: 's' },
    );
    expect(values()).toEqual([]); // pg was never called
  });
});
