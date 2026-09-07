/**
 * identities-v1-2026-08-30 P-001 — `validateBlueprint`'s identity checks:
 * slot registry membership / reserved layers / duplicates / cardinality
 * agreement (D-007), bundle duplicates (D-011), and the RESERVED grants refusal
 * (D-004 sequenced by D-014).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintSchema } from './schema.js';
import { validateBlueprint } from './validate.js';

const base = { id: 'ident', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };
const codes = (doc: Record<string, unknown>): string[] => validateBlueprint(BlueprintSchema.parse(doc)).errors.map((e) => e.code);

test('a well-formed identity validates with no errors', () => {
  const v = validateBlueprint(
    BlueprintSchema.parse({
      ...base,
      slots: [{ slot: 'domain' }, { slot: 'practice', cardinality: 'additive' }, { slot: 'autonomy', cardinality: 'exclusive' }],
      bundles: [{ kind: 'recipe', ref: 'r1' }, { kind: 'rubric', ref: 'r1' }],
      grants: {},
      publisher: { id: 'p' },
    }),
  );
  assert.deepEqual(v.errors, []);
});

test('slot-unknown — a slot not in the registry is an error that names the registry', () => {
  const v = validateBlueprint(BlueprintSchema.parse({ ...base, slots: [{ slot: 'risk-posture' }] }));
  const e = v.errors.find((x) => x.code === 'slot-unknown');
  assert.ok(e, JSON.stringify(v.errors));
  assert.match(e.message, /known: client, domain, fleet-posture/);
});

test('slot-reserved-layer — kernel and instance are layers, never declarable slots', () => {
  for (const slot of ['kernel', 'instance']) {
    assert.deepEqual(codes({ ...base, slots: [{ slot }] }), ['slot-reserved-layer'], slot);
  }
});

test('slot-duplicate — a slot declared twice in one document', () => {
  assert.deepEqual(codes({ ...base, slots: [{ slot: 'practice' }, { slot: 'practice' }] }), ['slot-duplicate']);
});

test('slot-cardinality-mismatch — a restated cardinality must agree with the registry (the registry is authoritative)', () => {
  assert.deepEqual(codes({ ...base, slots: [{ slot: 'domain', cardinality: 'additive' }] }), ['slot-cardinality-mismatch']);
  assert.deepEqual(codes({ ...base, slots: [{ slot: 'practice', cardinality: 'exclusive' }] }), ['slot-cardinality-mismatch']);
  assert.deepEqual(codes({ ...base, slots: [{ slot: 'domain', cardinality: 'exclusive' }] }), []);
  assert.deepEqual(codes({ ...base, slots: [{ slot: 'domain' }] }), [], 'omitting the restatement is always fine');
});

test('bundle-duplicate — the same (kind, ref) twice; the same ref under two kinds is distinct', () => {
  assert.deepEqual(codes({ ...base, bundles: [{ kind: 'recipe', ref: 'r' }, { kind: 'recipe', ref: 'r' }] }), ['bundle-duplicate']);
  assert.deepEqual(codes({ ...base, bundles: [{ kind: 'recipe', ref: 'r' }, { kind: 'rubric', ref: 'r' }] }), []);
});

test('grants require exact normalized class@version refs', () => {
  assert.deepEqual(codes({ ...base, grants: { requires: ['crm.email@1.0.0'] } }), []);
  assert.deepEqual(codes({ ...base, grants: { optional: ['crm.email'] } }), ['grant-class-ref-invalid']);
  assert.deepEqual(codes({ ...base, grants: { requires: ['CRM.email@1.0.0'] } }), ['grant-class-ref-invalid']);
  assert.deepEqual(
    codes({ ...base, grants: { suggestedProviders: { 'crm.email': 'acme' } } }),
    ['grant-class-ref-invalid'],
  );
});

test('grants reject duplicates, required/optional overlap and suggestions for undeclared classes', () => {
  assert.deepEqual(
    codes({ ...base, grants: { requires: ['crm.email@1.0.0', 'crm.email@1.0.0'] } }),
    ['grant-duplicate'],
  );
  assert.deepEqual(
    codes({
      ...base,
      grants: {
        requires: ['crm.email@1.0.0'],
        optional: ['crm.email@1.0.0'],
      },
    }),
    ['grant-required-optional-overlap'],
  );
  assert.deepEqual(
    codes({
      ...base,
      grants: {
        requires: ['crm.email@1.0.0'],
        suggestedProviders: { 'calendar.read@1.0.0': 'calendar-provider' },
      },
    }),
    ['grant-suggestion-undeclared'],
  );
  assert.deepEqual(
    codes({
      ...base,
      grants: {
        requires: ['crm.email@1.0.0'],
        suggestedProviders: { 'crm.email@1.0.0': 'acme-crm' },
      },
    }),
    [],
  );
});

test('a plain blueprint (no slots:) is untouched by the identity checks', () => {
  assert.deepEqual(codes(base), []);
});
