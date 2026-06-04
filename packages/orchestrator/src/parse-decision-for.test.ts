/**
 * parseDecisionFor — the vocabulary-generalized parser (P-017 runtime enablement).
 * Asserts it's behavior-preserving for the built-in coding verbs (so the live
 * pipeline is unchanged) and that it parses a blueprint's own vocabulary
 * (research verbs), including longest-first prefix disambiguation.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseDecision, parseDecisionFor, DECISION_VERBS } from './decision-parse.js';

const SAMPLES = [
  'DONE',
  'NEXT_WORKER F-001',
  'thinking…\n**NEXT_VALIDATOR F-002**',
  'NEXT_WORKER F-3 N=2',
  'NEXT_WORKER_CEO_MODE F-9',
  'ESCALATE blocked on X',
  'no verb here',
  '',
  'CHECKPOINT',
  'NEXT_TESTER VAL-7',
];

test('parseDecisionFor(DECISION_VERBS) === parseDecision (behavior-preserving)', () => {
  for (const s of SAMPLES) {
    const viaFor = parseDecisionFor(DECISION_VERBS, s);
    const viaStd = parseDecision(s);
    // parseDecision returns the same value (verb just narrowed to DecisionVerb).
    assert.deepEqual(viaFor, viaStd === null ? null : { ...viaStd }, `mismatch for: ${JSON.stringify(s)}`);
  }
});

test('parseDecisionFor parses a blueprint custom vocabulary (research verbs)', () => {
  const VERBS = ['NEXT_RESEARCHER', 'NEXT_SEARCHER', 'NEXT_VERIFIER', 'DONE', 'ESCALATE', 'IDLE'];
  assert.deepEqual(parseDecisionFor(VERBS, 'NEXT_RESEARCHER R-001'), {
    verb: 'NEXT_RESEARCHER',
    arg: 'R-001',
    n: null,
    raw: 'NEXT_RESEARCHER R-001',
  });
  assert.equal(parseDecisionFor(VERBS, '**DONE**')?.verb, 'DONE');
  // A coding verb is NOT in this vocabulary → no match.
  assert.equal(parseDecisionFor(VERBS, 'NEXT_WORKER F-1'), null);
});

test('parseDecisionFor disambiguates overlapping prefixes longest-first', () => {
  // SEARCH vs SEARCHER: the longer must win regardless of array order.
  const VERBS = ['SEARCH', 'SEARCHER'];
  assert.equal(parseDecisionFor(VERBS, 'SEARCHER x')?.verb, 'SEARCHER');
  assert.equal(parseDecisionFor([...VERBS].reverse(), 'SEARCHER x')?.verb, 'SEARCHER');
});
