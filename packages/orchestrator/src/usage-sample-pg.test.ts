/**
 * Tests for the pure usage-sample classifiers (backend→provider, model→class).
 * Run with: npx vitest run packages/orchestrator/src/usage-sample-pg.test.ts
 */
import { describe, expect, it } from 'vitest';
import { providerForBackend, modelClassForRun } from './usage-sample-pg';

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
