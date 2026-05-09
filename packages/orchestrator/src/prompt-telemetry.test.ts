import { test } from 'vitest';
import assert from 'node:assert/strict';
import { recordPromptComposition } from './prompt-telemetry';

function capturingPg() {
  const calls: Array<{ values: unknown[] }> = [];
  const fn = ((_tpl: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ values });
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof recordPromptComposition>[0];
  return { pg: fn, calls };
}

function failingPg() {
  return ((_tpl: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.reject(new Error('pg blew up'))) as unknown as Parameters<typeof recordPromptComposition>[0];
}

test('recordPromptComposition — passes values to pg in correct positions', async () => {
  const { pg, calls } = capturingPg();
  recordPromptComposition(pg, {
    workspaceId: 'default',
    harnessSlug: 'sheets',
    featureId: 'F-001',
    role: 'worker',
    runId: 'run-abc',
    totalChars: 12345,
    substrateChars: 1000,
    historyChars: 500,
  });
  // Wait a tick for the void-async to fire.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  const v = calls[0].values;
  assert.equal(v[0], 'default');
  assert.equal(v[1], 'sheets');
  assert.equal(v[2], 'F-001');
  assert.equal(v[3], 'worker');
  assert.equal(v[4], 'run-abc');
  // values[5] is Date.now() — variable, just check it's positive.
  assert.ok(typeof v[5] === 'number' && v[5] > 0);
  assert.equal(v[6], 12345);
  assert.equal(v[7], 1000);
  assert.equal(v[8], 500);
  // Optional fields default null.
  assert.equal(v[9], null);
  assert.equal(v[10], null);
  assert.equal(v[11], null);
  assert.equal(v[12], null);
});

test('recordPromptComposition — null featureId for non-feature roles', async () => {
  const { pg, calls } = capturingPg();
  recordPromptComposition(pg, {
    workspaceId: 'default',
    harnessSlug: 'sheets',
    featureId: null,
    role: 'orchestrator',
    runId: 'run-xyz',
    totalChars: 100,
    substrateChars: 50,
    historyChars: 0,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls[0].values[2], null);
});

test('recordPromptComposition — pg failure is swallowed (no throw)', async () => {
  const pg = failingPg();
  // If this throws, the test fails. Synchronous return is the
  // fire-and-forget contract.
  recordPromptComposition(pg, {
    workspaceId: 'x', harnessSlug: 'y', featureId: null, role: 'r', runId: 'rid',
    totalChars: 1, substrateChars: 0, historyChars: 0,
  });
  await new Promise((r) => setTimeout(r, 5));
  // No assertion; getting here at all is the assertion.
  assert.ok(true);
});

test('recordPromptComposition — optional per-section fields propagate', async () => {
  const { pg, calls } = capturingPg();
  recordPromptComposition(pg, {
    workspaceId: 'default',
    harnessSlug: 'sheets',
    featureId: 'F-001',
    role: 'worker',
    runId: 'r',
    totalChars: 1000,
    substrateChars: 100,
    historyChars: 200,
    rolePromptChars: 300,
    memoryChars: 50,
    identityChars: 75,
    runtimeChars: 25,
  });
  await new Promise((r) => setTimeout(r, 5));
  const v = calls[0].values;
  assert.equal(v[9], 300);
  assert.equal(v[10], 50);
  assert.equal(v[11], 75);
  assert.equal(v[12], 25);
});
