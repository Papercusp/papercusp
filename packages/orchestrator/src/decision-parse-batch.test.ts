import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseDecisions } from './decision-parse.js';

test('no envelope falls back to single-decision wrapped in array', () => {
  const r = parseDecisions('Some thinking…\nNEXT_WORKER F-001\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].verb, 'NEXT_WORKER');
  assert.equal(r[0].arg, 'F-001');
});

test('no envelope, no decision → empty array', () => {
  assert.deepEqual(parseDecisions('I have nothing to say.\n'), []);
});

test('envelope with multiple NEXT_WORKER lines', () => {
  const out = `Plan:

DECISIONS
NEXT_WORKER F-AUTH-001
NEXT_WORKER F-PAY-007
NEXT_WORKER F-DOCS-012
END

That's the batch.`;
  const r = parseDecisions(out);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((d) => d.arg), ['F-AUTH-001', 'F-PAY-007', 'F-DOCS-012']);
  assert.deepEqual(r.map((d) => d.verb), ['NEXT_WORKER', 'NEXT_WORKER', 'NEXT_WORKER']);
});

test('envelope with single decision is accepted (allows solo verbs in envelope)', () => {
  const out = `DECISIONS
NEXT_VALIDATOR F-AUTH-001
END`;
  const r = parseDecisions(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].verb, 'NEXT_VALIDATOR');
});

test('envelope with mixed solo + batch verbs is rejected (returns [])', () => {
  // Solo verbs (NEXT_VALIDATOR, FEATURE_FREEZE, etc.) must not appear
  // in a batch with other decisions — they imply state changes others
  // would race against.
  const out = `DECISIONS
NEXT_WORKER F-AUTH-001
NEXT_VALIDATOR F-PAY-007
END`;
  assert.deepEqual(parseDecisions(out), []);
});

test('envelope rejects duplicate feature ids', () => {
  const out = `DECISIONS
NEXT_WORKER F-AUTH-001
NEXT_WORKER F-AUTH-001
END`;
  assert.deepEqual(parseDecisions(out), []);
});

test('empty envelope returns []', () => {
  assert.deepEqual(parseDecisions('DECISIONS\nEND'), []);
  assert.deepEqual(parseDecisions('DECISIONS\n\n\nEND'), []);
});

test('envelope handles N= adaptive worker count per line', () => {
  const out = `DECISIONS
NEXT_WORKER F-AUTH-001
NEXT_WORKER F-PAY-007 N=2
NEXT_WORKER F-DOCS-012 N=4
END`;
  const r = parseDecisions(out);
  assert.equal(r.length, 3);
  assert.equal(r[0].n, null);
  assert.equal(r[1].n, 2);
  assert.equal(r[2].n, 4);
});

test('envelope tolerates blank lines and comments inside body', () => {
  const out = `DECISIONS

NEXT_WORKER F-AUTH-001
# this is a comment line that doesn't parse as a decision

NEXT_WORKER F-PAY-007
END`;
  const r = parseDecisions(out);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((d) => d.arg), ['F-AUTH-001', 'F-PAY-007']);
});

test('envelope tolerates markdown emphasis (matches single-decision behavior)', () => {
  const out = `DECISIONS
**NEXT_WORKER F-AUTH-001**
\`NEXT_WORKER F-PAY-007\`
END`;
  const r = parseDecisions(out);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((d) => d.arg), ['F-AUTH-001', 'F-PAY-007']);
});

test('text after END is ignored', () => {
  const out = `DECISIONS
NEXT_WORKER F-AUTH-001
END

But also maybe NEXT_WORKER F-NOPE-99 — this should NOT be parsed.`;
  const r = parseDecisions(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].arg, 'F-AUTH-001');
});

test('envelope with garbage between DECISIONS and END returns [] (no parseable decisions)', () => {
  const out = `DECISIONS
not a decision
this is just text
neither is this
END`;
  assert.deepEqual(parseDecisions(out), []);
});
