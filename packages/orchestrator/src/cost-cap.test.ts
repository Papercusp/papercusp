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
    costUsd: 0.042,
  });
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
