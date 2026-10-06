/**
 * Tests for env-resolution helpers.
 * Run with: npx vitest run libs/papercusp/packages/orchestrator/src/env.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { claudeModelFlagArgs, normalizeModelForBackend } from './env.js';
import { ROLE_MODEL_DEFAULTS } from './role-models.js';

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

// --- claudeModelFlagArgs: claude takes effort as its own flag (WI-10006244) ---

test('claudeModelFlagArgs — splits a recognized effort suffix into --effort', () => {
  assert.deepEqual(claudeModelFlagArgs('sonnet[1m]:high'), ['--model', 'sonnet[1m]', '--effort', 'high']);
  assert.deepEqual(claudeModelFlagArgs('claude-sonnet-5:LOW'), ['--model', 'claude-sonnet-5', '--effort', 'low']);
});

test('claudeModelFlagArgs — maps Opus 5 xhigh to its supported max', () => {
  assert.deepEqual(claudeModelFlagArgs('opus:xhigh'), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(claudeModelFlagArgs('opus[1m]:xhigh'), ['--model', 'opus[1m]', '--effort', 'max']);
  // A family that still accepts xhigh keeps it.
  assert.deepEqual(claudeModelFlagArgs('claude-opus-4-8:xhigh'), ['--model', 'claude-opus-4-8', '--effort', 'xhigh']);
});

test('claudeModelFlagArgs — a spec without an effort suffix stays one --model', () => {
  assert.deepEqual(claudeModelFlagArgs('opus'), ['--model', 'opus']);
  assert.deepEqual(claudeModelFlagArgs('chatgpt:5.5'), ['--model', 'chatgpt:5.5']);
});

test('claudeModelFlagArgs — no committed claude role default reaches claude as a suffixed --model', () => {
  for (const [role, spec] of Object.entries(ROLE_MODEL_DEFAULTS)) {
    const model = normalizeModelForBackend(spec, 'claude-code');
    const args = claudeModelFlagArgs(model);
    assert.equal(args[0], '--model', role);
    assert.doesNotMatch(args[1] ?? '', /:(low|medium|high|xhigh|max)$/i, `${role}: ${spec}`);
    // Opus 5 rejects xhigh: an opus default must never reach claude as --effort xhigh.
    if (/^opus(\[1m\])?$/i.test(args[1] ?? '')) assert.notEqual(args.at(-1), 'xhigh', role);
  }
});
