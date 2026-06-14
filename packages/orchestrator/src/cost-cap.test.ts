import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCostCap, sumJsonlCost } from './cost-cap.js';

function makeFixture(): { logDir: string; stateDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-cost-'));
  const stateDir = join(root, '.papercusp');
  const logDir = join(stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  return { logDir, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('sumJsonlCost — empty dir returns 0', () => {
  const fx = makeFixture();
  try {
    assert.equal(sumJsonlCost(fx.logDir), 0);
  } finally {
    fx.cleanup();
  }
});

test('sumJsonlCost — sums total_cost_usd from result events', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1700000000-worker.jsonl'), [
    { type: 'system', message: 'start' },
    { type: 'result', result: 'NEXT_VALIDATOR F-001', total_cost_usd: 0.012 },
  ]);
  writeJsonl(join(fx.logDir, '1700000100-validator.jsonl'), [
    { type: 'result', result: 'PASSED', total_cost_usd: 0.008 },
  ]);
  try {
    assert.equal(sumJsonlCost(fx.logDir), 0.012 + 0.008);
  } finally {
    fx.cleanup();
  }
});

test('sumJsonlCost — only LAST result per file (matches bash)', () => {
  const fx = makeFixture();
  // Bash takes the LAST result event per file. (In practice claude only
  // emits one terminal "result" per invocation, but our parser must match.)
  writeJsonl(join(fx.logDir, '1700000000-worker.jsonl'), [
    { type: 'result', result: 'first', total_cost_usd: 0.05 },
    { type: 'result', result: 'second', total_cost_usd: 0.10 },
  ]);
  try {
    assert.equal(sumJsonlCost(fx.logDir), 0.10);
  } finally {
    fx.cleanup();
  }
});

test('sumJsonlCost — ignores non-jsonl files', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.logDir, 'run.log'), '[2026-04-27] some text\n');
  writeFileSync(join(fx.logDir, '1700000000-worker.out'), 'NEXT_VALIDATOR F-001\n');
  writeJsonl(join(fx.logDir, '1700000000-worker.jsonl'), [
    { type: 'result', total_cost_usd: 0.5 },
  ]);
  try {
    assert.equal(sumJsonlCost(fx.logDir), 0.5);
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — no cap configured returns total only', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 1.5 }]);
  try {
    const r = evaluateCostCap({}, fx.logDir, fx.stateDir);
    assert.equal(r.total, 1.5);
    assert.equal(r.cap, null);
    assert.equal(r.overCap, false);
    assert.equal(r.warned, false);
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — total >= cap → overCap=true', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 5.0 }]);
  try {
    const r = evaluateCostCap({ maxCostUsd: 5.0 }, fx.logDir, fx.stateDir);
    assert.equal(r.overCap, true);
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — soft warn at 80% by default + sentinel created', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 4.0 }]);
  try {
    const r = evaluateCostCap({ maxCostUsd: 5.0 }, fx.logDir, fx.stateDir);
    assert.equal(r.warned, true);
    assert.equal(r.overCap, false);
    assert.ok(existsSync(join(fx.stateDir, '.cost-warn-fired')));
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — soft warn fires only ONCE per mission (sentinel)', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 4.0 }]);
  try {
    const first = evaluateCostCap({ maxCostUsd: 5.0 }, fx.logDir, fx.stateDir);
    assert.equal(first.warned, true);
    const second = evaluateCostCap({ maxCostUsd: 5.0 }, fx.logDir, fx.stateDir);
    assert.equal(second.warned, false, 'sentinel should suppress repeat warn');
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — autoPause flag set when configured + warn fires', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 4.0 }]);
  try {
    const r = evaluateCostCap(
      { maxCostUsd: 5.0, maxCostUsdAutoPause: true },
      fx.logDir,
      fx.stateDir,
    );
    assert.equal(r.shouldPause, true);
  } finally {
    fx.cleanup();
  }
});

test('evaluateCostCap — custom warn threshold honored', () => {
  const fx = makeFixture();
  writeJsonl(join(fx.logDir, '1.jsonl'), [{ type: 'result', total_cost_usd: 0.5 }]);
  try {
    const r = evaluateCostCap(
      { maxCostUsd: 5.0, maxCostUsdWarnThreshold: 0.1 },
      fx.logDir,
      fx.stateDir,
    );
    // 0.5 / 5.0 = 10% — equal to the threshold, fires.
    assert.equal(r.warned, true);
  } finally {
    fx.cleanup();
  }
});

// --- extractRunUsage (rate-limit-layer-v2 D-002, capture point 2) ------------------------------
import { extractRunUsage } from './cost-cap.js';

test('extractRunUsage — Claude Code result event (snake_case usage + total_cost_usd)', () => {
  const jsonl = [
    JSON.stringify({ type: 'system', message: 'start' }),
    JSON.stringify({
      type: 'result',
      total_cost_usd: 0.042,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000 },
    }),
  ].join('\n');
  assert.deepEqual(extractRunUsage(jsonl), {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 9000,
    cacheCreationTokens: undefined,
    costUsd: 0.042,
    durationMs: undefined,
    turns: undefined,
    backend: 'claude-code',
  });
});

test('extractRunUsage — Claude result num_turns → turns (queen-brief-cache P-010 Win-2)', () => {
  const jsonl = JSON.stringify({
    type: 'result',
    num_turns: 7,
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 8000 },
  });
  const u = extractRunUsage(jsonl);
  assert.equal(u?.turns, 7);
  assert.equal(u?.cacheReadTokens, 8000);
});

test('extractRunUsage — OpenAI-style aliases (prompt/completion/cached tokens)', () => {
  const jsonl = JSON.stringify({
    type: 'result',
    usage: { prompt_tokens: 500, completion_tokens: 80, cached_tokens: 100 },
  });
  const u = extractRunUsage(jsonl);
  assert.equal(u?.inputTokens, 500);
  assert.equal(u?.outputTokens, 80);
  assert.equal(u?.cacheReadTokens, 100);
  assert.equal(u?.costUsd, undefined);
});

test('extractRunUsage — last result event wins (matches sumJsonlCost)', () => {
  const jsonl = [
    JSON.stringify({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 1 } }),
    JSON.stringify({ type: 'assistant', message: 'mid-run' }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.05, usage: { input_tokens: 99 } }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  assert.equal(u?.costUsd, 0.05);
  assert.equal(u?.inputTokens, 99);
});

test('extractRunUsage — null on no result event / malformed lines / usage-less result', () => {
  assert.equal(extractRunUsage(''), null);
  assert.equal(extractRunUsage('not json\n{"type":"system"}'), null);
  assert.equal(extractRunUsage(JSON.stringify({ type: 'result', result: 'DONE' })), null);
});

// --- extractRunUsage cross-backend shapes (cross-backend-cost-capture D-005) -------------------

test('extractRunUsage — codex turn.completed: sums turns, subtracts cached subset, backend codex', () => {
  const jsonl = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 30 } }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  // turn 1: 1000 includes 400 cached → 600 uncached; turn 2: 200 uncached
  assert.equal(u?.inputTokens, 800);
  assert.equal(u?.outputTokens, 80);
  assert.equal(u?.cacheReadTokens, 400);
  assert.equal(u?.costUsd, undefined); // codex reports no cost
  assert.equal(u?.backend, 'codex');
});

test('extractRunUsage — omp message_end: sums assistant turns, reads cost.total + model', () => {
  const jsonl = [
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input: 5000, output: 200, cacheRead: 1000, cacheWrite: 300, totalTokens: 6500, cost: { total: 0.031 } },
      },
    }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input: 100, output: 40, cost: { total: 0.004 } },
      },
    }),
    JSON.stringify({ type: 'agent_end', messages: [
      { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 5000, output: 200, cost: { total: 0.031 } } },
      { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 100, output: 40, cost: { total: 0.004 } } },
    ] }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  // message_end sums win; agent_end is a fallback only (no double count)
  assert.equal(u?.inputTokens, 5100);
  assert.equal(u?.outputTokens, 240);
  assert.equal(u?.cacheReadTokens, 1000);
  assert.equal(u?.cacheCreationTokens, 300);
  assert.ok(Math.abs((u?.costUsd ?? 0) - 0.035) < 1e-9);
  assert.equal(u?.model, 'claude-opus-4-8');
  assert.equal(u?.backend, 'omp');
});

test('extractRunUsage — omp agent_end fallback when no message_end carried usage', () => {
  const jsonl = JSON.stringify({ type: 'agent_end', messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', model: 'qwen2.5-coder:14b', usage: { input: 900, output: 120, cost: { total: 0 } } },
  ] });
  const u = extractRunUsage(jsonl);
  assert.equal(u?.inputTokens, 900);
  assert.equal(u?.outputTokens, 120);
  assert.equal(u?.model, 'qwen2.5-coder:14b');
  assert.equal(u?.backend, 'omp');
});

test('extractRunUsage — stream-derived model (actual) wins over run_meta (requested alias)', () => {
  const jsonl = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 10 } }),
    JSON.stringify({ type: 'papercusp.run_meta', backend: 'claude-code', model: 'opus', role: 'worker' }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  assert.equal(u?.model, 'claude-opus-4-8'); // actual id from the stream, not the 'opus' alias
  assert.equal(u?.backend, 'claude-code');
});

test('extractRunUsage — run_meta model covers codex (stream names no model)', () => {
  const jsonl = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }),
    JSON.stringify({ type: 'papercusp.run_meta', backend: 'codex', model: 'gpt-5.5', role: 'worker' }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  assert.equal(u?.model, 'gpt-5.5');
  assert.equal(u?.backend, 'codex');
});

test('extractRunUsage — claude model falls back to system:init when no run_meta', () => {
  const jsonl = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7' }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 5 } }),
  ].join('\n');
  const u = extractRunUsage(jsonl);
  assert.equal(u?.model, 'claude-opus-4-7');
  assert.equal(u?.backend, 'claude-code');
});

test('sumJsonlCost — prices codex tokens from run_meta model; omp cost.total reported directly', () => {
  const fx = makeFixture();
  // claude: provider-reported cost
  writeJsonl(join(fx.logDir, '1700000000-worker.jsonl'), [
    { type: 'result', result: 'DONE', total_cost_usd: 0.012 },
  ]);
  // codex: tokens only + run_meta model → estimated at list price
  // 1M uncached in × $2.50 + 100k out × $20 = 2.5 + 2 = 4.5 (gpt-5.5)
  writeJsonl(join(fx.logDir, '1700000100-validator.jsonl'), [
    { type: 'turn.completed', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
    { type: 'papercusp.run_meta', backend: 'codex', model: 'gpt-5.5', role: 'validator' },
  ]);
  // omp: provider-reported cost.total
  writeJsonl(join(fx.logDir, '1700000200-scoper.jsonl'), [
    { type: 'message_end', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 10, output: 5, cost: { total: 0.003 } } } },
  ]);
  // codex with NO model derivable → contributes 0 (never a fabricated estimate)
  writeJsonl(join(fx.logDir, '1700000300-reviewer.jsonl'), [
    { type: 'turn.completed', usage: { input_tokens: 999_999, output_tokens: 999 } },
  ]);
  try {
    const total = sumJsonlCost(fx.logDir);
    assert.ok(Math.abs(total - (0.012 + 4.5 + 0.003)) < 1e-9, `got ${total}`);
  } finally {
    fx.cleanup();
  }
});
