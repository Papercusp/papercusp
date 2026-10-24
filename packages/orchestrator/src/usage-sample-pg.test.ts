/**
 * Tests for the pure usage-sample classifiers (backend→provider, model→class).
 * Run with: npx vitest run packages/orchestrator/src/usage-sample-pg.test.ts
 */
import { describe, expect, it } from 'vitest';
import { PRICE_TABLE_VERSION, costFromTokens } from '@papercusp/model-pricing';
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

// WI-10004517 / D-018: an estimate is stamped with the table version it was priced under, so
// the operator's repricer can tell it is stale after a price change. Provider cost is never
// stamped (it is an observation and is never re-priced). Values 10..13 are
// cost_usd, model, cost_source, price_table_version.
describe('recordUsageSamplePg — price-table version stamp', () => {
  it('stamps an estimated row with the running PRICE_TABLE_VERSION', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'codex', model: 'gpt-5.5', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    );
    const v = values();
    expect(v[10]).toBeCloseTo(costFromTokens('gpt-5.5', { inputTokens: 1_000_000, outputTokens: 0 }).usd, 12);
    expect(v[12]).toBe('estimated');
    expect(v[13]).toBe(PRICE_TABLE_VERSION);
  });

  it('stamps an unpriceable row too, so it is re-tried when its model gains a price', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'codex', model: 'gpt-not-in-the-table', usage: { inputTokens: 10, outputTokens: 5 } },
    );
    const v = values();
    expect(v[10]).toBeNull();
    expect(v[12]).toBeNull();
    expect(v[13]).toBe(PRICE_TABLE_VERSION);
  });

  it('leaves provider-reported cost unstamped', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'claude-code', model: 'claude-opus-4-8', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.42 } },
    );
    const v = values();
    expect(v[10]).toBe(0.42);
    expect(v[12]).toBe('provider');
    expect(v[13]).toBeNull();
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

  it('persists actual-model provenance and keeps a requested-only model unverified', async () => {
    const { pg, values } = capturingPg();
    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      {
        backend: 'claude-code',
        model: 'opus',
        usage: {
          inputTokens: 10,
          model: 'claude-sonnet-4-6',
          requestedModel: 'opus',
          observedModels: ['claude-opus-4-8', 'claude-sonnet-4-6'],
          modelProvenance: 'turn',
        },
        runId: 'run-actual',
      },
    );
    expect(values()).toContain('claude-sonnet-4-6');
    expect(values()).toContain('sonnet'); // model class follows the reported turn, not the opus request
    expect(values()).toContainEqual({
      modelSource: 'turn', requestedModel: 'opus',
      actualModels: ['claude-opus-4-8', 'claude-sonnet-4-6'], backend: 'claude-code', costBound: null,
    });

    await recordUsageSamplePg(
      { pg, workspaceId: 'ws-1' },
      { backend: 'codex', model: 'gpt-5.5', usage: { inputTokens: 10, model: 'gpt-5.5', modelProvenance: 'request' } },
    );
    expect(values()).toContainEqual({
      modelSource: 'request', requestedModel: 'gpt-5.5', actualModels: [], backend: 'codex', costBound: null,
    });
  });

  // D-020: a run aggregate has no request size. A long-context model used to persist NULL here;
  // it now prices at the standard-tier floor and says so, matching the operator's repricer.
  it('prices a long-context aggregate at its floor and records the lower bound', async () => {
    const { pg, values } = capturingPg();
    const usage = { inputTokens: 366_710, outputTokens: 9_444, cacheReadTokens: 7_333_632 };
    await recordUsageSamplePg({ pg, workspaceId: 'ws-1' }, { backend: 'codex', model: 'gpt-6-astra', usage });
    const v = values();
    expect(costFromTokens('gpt-6-astra', usage).priced).toBe(false);
    expect(v[10]).toBeCloseTo(11.472932, 9);
    expect(v[12]).toBe('estimated');
    expect(v[13]).toBe(PRICE_TABLE_VERSION);
    expect(values()).toContainEqual({
      modelSource: 'request', requestedModel: 'gpt-6-astra', actualModels: [], backend: 'codex', costBound: 'lower',
    });
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
