import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, DECISION_VERBS } from './decision-parse.js';

test('parseDecision — bare verb on its own line', () => {
  const out = parseDecision('DONE');
  assert.deepEqual(out, { verb: 'DONE', arg: null, raw: 'DONE' });
});

test('parseDecision — verb + arg', () => {
  const out = parseDecision('NEXT_WORKER F-001');
  assert.deepEqual(out, { verb: 'NEXT_WORKER', arg: 'F-001', raw: 'NEXT_WORKER F-001' });
});

test('parseDecision — strips markdown emphasis (**bold**)', () => {
  const out = parseDecision('thinking…\n**NEXT_VALIDATOR F-002**\n');
  assert.equal(out?.verb, 'NEXT_VALIDATOR');
  assert.equal(out?.arg, 'F-002');
});

test('parseDecision — strips backticks (code/inline)', () => {
  const out = parseDecision('decision: `NEXT_WORKER F-007`');
  assert.equal(out?.verb, 'NEXT_WORKER');
  assert.equal(out?.arg, 'F-007');
});

test('parseDecision — strips code fences (```...```)', () => {
  const out = parseDecision('```\nNEXT_VALIDATOR F-LANE-1\n```');
  assert.equal(out?.verb, 'NEXT_VALIDATOR');
  assert.equal(out?.arg, 'F-LANE-1');
});

test('parseDecision — picks the LAST match when multiple verbs appear', () => {
  const out = parseDecision('first NEXT_WORKER F-001\nthen NEXT_VALIDATOR F-002');
  assert.equal(out?.verb, 'NEXT_VALIDATOR');
  assert.equal(out?.arg, 'F-002');
});

test('parseDecision — returns null when no verb appears', () => {
  assert.equal(parseDecision(''), null);
  assert.equal(parseDecision('just thinking, no decision yet'), null);
  // Lowercase is rejected (matches bash behavior — verbs must be UPPERCASE).
  assert.equal(parseDecision('done'), null);
});

test('parseDecision — NEXT_WORKER_CEO_MODE matches before NEXT_WORKER', () => {
  // Without the longer-prefix-first ordering this would wrongly match
  // NEXT_WORKER and leave _CEO_MODE as garbage.
  const out = parseDecision('NEXT_WORKER_CEO_MODE F-003');
  assert.equal(out?.verb, 'NEXT_WORKER_CEO_MODE');
  assert.equal(out?.arg, 'F-003');
});

test('parseDecision — argument allows dotted/dashed/numeric values', () => {
  const out = parseDecision('NEXT_HARNESS papercup.demo-1');
  assert.equal(out?.verb, 'NEXT_HARNESS');
  assert.equal(out?.arg, 'papercup.demo-1');
});

test('parseDecision — argument-less verbs return null arg', () => {
  for (const verb of ['DONE', 'IDLE', 'ESCALATE', 'CHECKPOINT'] as const) {
    const out = parseDecision(`${verb}`);
    assert.equal(out?.verb, verb);
    assert.equal(out?.arg, null);
  }
});

test('DECISION_VERBS — every verb is listed', () => {
  // Sanity: keep this list in sync with bash's regex group.
  assert.equal(DECISION_VERBS.length, 19);
  assert.ok(DECISION_VERBS.includes('DONE'));
  assert.ok(DECISION_VERBS.includes('NEXT_WORKER'));
  assert.ok(DECISION_VERBS.includes('NEXT_WORKER_CEO_MODE'));
});
