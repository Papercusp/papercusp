/**
 * Tests for env-resolution helpers.
 * Run with: npx vitest run libs/papercusp/packages/orchestrator/src/env.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeModelForBackend } from './env.js';

// --- normalizeModelForBackend: claude --model rejects the provider prefix ---

test('normalizeModelForBackend — claude-code strips a leading provider/ segment', () => {
  assert.equal(
    normalizeModelForBackend('anthropic/claude-opus-4-7', 'claude-code'),
    'claude-opus-4-7',
  );
});

test('normalizeModelForBackend — claude-code leaves a bare id untouched', () => {
  assert.equal(normalizeModelForBackend('claude-opus-4-7', 'claude-code'), 'claude-opus-4-7');
});

test('normalizeModelForBackend — claude-code leaves an alias untouched', () => {
  assert.equal(normalizeModelForBackend('opus', 'claude-code'), 'opus');
});

test('normalizeModelForBackend — claude-code strips any provider, not just anthropic', () => {
  assert.equal(normalizeModelForBackend('openai-codex/gpt-5', 'claude-code'), 'gpt-5');
});

test('normalizeModelForBackend — codex strips provider and normalizes chatgpt aliases', () => {
  assert.equal(normalizeModelForBackend('openai-codex/gpt-5.5', 'codex'), 'gpt-5.5');
  assert.equal(normalizeModelForBackend('chatgpt:5.5', 'codex'), 'gpt-5.5');
  assert.equal(normalizeModelForBackend('chatgpt:5.5:high', 'codex'), 'gpt-5.5');
});

test('normalizeModelForBackend — claude-code does not rewrite chatgpt aliases', () => {
  assert.equal(normalizeModelForBackend('chatgpt:5.5', 'claude-code'), 'chatgpt:5.5');
});

test('normalizeModelForBackend — omp keeps the provider/model form verbatim', () => {
  assert.equal(
    normalizeModelForBackend('anthropic/claude-opus-4-7', 'omp'),
    'anthropic/claude-opus-4-7',
  );
});

test('normalizeModelForBackend — empty in → empty out (both backends)', () => {
  assert.equal(normalizeModelForBackend('', 'claude-code'), '');
  assert.equal(normalizeModelForBackend('', 'omp'), '');
});
