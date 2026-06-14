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
  it('maps claude-code and anthropic-direct to anthropic', () => {
    expect(providerForBackend('claude-code')).toBe('anthropic');
    expect(providerForBackend('anthropic-direct')).toBe('anthropic');
  });

  it('maps codex to openai', () => {
    expect(providerForBackend('codex')).toBe('openai');
  });

  it('maps omp and unknown backends to "unknown" (model-agnostic)', () => {
    expect(providerForBackend('omp')).toBe('unknown');
    expect(providerForBackend('something-else')).toBe('unknown');
  });
});

describe('modelClassForRun', () => {
  it('collapses self-pacing omp to the "self" bucket regardless of model', () => {
    expect(modelClassForRun('omp', 'claude-opus-4-8')).toBe('self');
    expect(modelClassForRun('omp', '')).toBe('self');
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
        role: 'bee',
        sessionId: 'sess-abc',
      },
    );
    const v = values();
    // session_id is the LAST interpolated value in the INSERT.
    expect(v[v.length - 1]).toBe('sess-abc');
    expect(v).toContain('opspawn-1'); // run_id still flows
    expect(v).toContain('bee'); // role still flows
    expect(v).toContain(5000); // cache_read_tokens (the carry signal)
  });

  it('null-safes session_id for backends with no native session id (omp/codex)', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'codex', model: 'gpt-5', usage: { inputTokens: 50 }, runId: 'r', role: 'bee' },
    );
    const v = values();
    expect(v[v.length - 1]).toBeNull(); // sessionId undefined -> NULL, never a fabricated value
  });

  it('no-ops (no INSERT) on an empty usage so an unparseable run never fabricates a row', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'claude-code', model: 'm', usage: {}, runId: 'r', role: 'bee', sessionId: 's' },
    );
    expect(values()).toEqual([]); // pg was never called
  });
});
