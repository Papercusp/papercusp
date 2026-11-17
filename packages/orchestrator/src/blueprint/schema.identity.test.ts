/**
 * identities-v1-2026-08-30 P-001 — the identity extension of BlueprintSchema:
 * `slots:` as the D-013 discriminator, the D-011 uniform `bundles:` list, the
 * RESERVED D-004 grants shape, publisher, and attestation.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AttestationSchema,
  BlueprintSchema,
  BundleRefSchema,
  IdentitySourceDocumentSchema,
  RunnableBlueprintSchema,
  SlotDeclarationSchema,
  isIdentityDocument,
  isIdentitySourceDocument,
  parseBlueprintSourceDocument,
} from './schema.js';
import { BUNDLE_KINDS } from './slots.js';

const minimal = { id: 'mini', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };

test('new identity classification is source-wrapper-only; the old shape helper remains a finite compatibility adapter (D-028)', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.slots, undefined, 'no default may be applied to slots — it would erase the discriminator');
  assert.equal(isIdentityDocument(bp), false);
  assert.deepEqual(bp.bundles, [], 'bundles defaults to the empty uniform list');
  assert.equal(bp.grants, undefined);
  assert.equal(bp.publisher, undefined);
  assert.equal(bp.attestation, undefined);
  const source = { id: 'identity', extends: 'identity-root', slots: [] };
  const parsedSource = parseBlueprintSourceDocument(source);
  assert.equal(isIdentitySourceDocument(parsedSource), true);
  assert.equal(isIdentityDocument(source), true, 'legacy helper still reads the raw slots shape');
  const runnable = RunnableBlueprintSchema.parse({ ...minimal, slots: [] });
  assert.deepEqual(runnable.slots, []);
  assert.equal(isIdentityDocument(runnable), true, 'legacy helper remains shape-only until its documented removal');
});

test('a portable identity source parses contributions, grants, publisher and attestation; bundles remain a workspace field', () => {
  const doc = {
    id: 'papercusp-engineer',
    extends: 'identity-root',
    version: '1.0.0',
    slots: [{ slot: 'domain', cardinality: 'exclusive' }, { slot: 'practice' }],
    contributions: [
      { id: 'core', purpose: 'resource', source: 'fixed', refresh: 'source-change', inputKind: 'package', ref: 'knowledge-pack:papercusp-core' },
      { id: 'ship-rubric', purpose: 'resource', source: 'fixed', refresh: 'source-change', inputKind: 'package', ref: 'rubric:plan-class-feature-ship' },
    ],
    grants: {},
    publisher: { id: 'papercusp', name: 'Papercusp', url: 'https://papercusp.dev' },
    attestation: { contentHash: 'a'.repeat(64), signedBy: 'papercusp' },
  };
  const source = IdentitySourceDocumentSchema.parse(doc);
  const bp = BlueprintSchema.parse({ ...minimal, ...doc });
  assert.equal(isIdentitySourceDocument(parseBlueprintSourceDocument(doc)), true);
  assert.deepEqual(bp.slots, [{ slot: 'domain', cardinality: 'exclusive' }, { slot: 'practice' }]);
  assert.equal(source.contributions?.length, 2);
  assert.throws(() => IdentitySourceDocumentSchema.parse({ ...doc, bundles: [] }), /Unrecognized key.*bundles/);
  assert.deepEqual(bp.bundles, []);
  assert.deepEqual(
    bp.grants,
    { requires: [], optional: [], suggestedProviders: {} },
    'grants fills to the empty reserved shape',
  );
  assert.equal(bp.publisher?.id, 'papercusp');
  assert.equal(bp.attestation?.signedBy, 'papercusp');
  assert.equal(isIdentityDocument(source), true);
  assert.equal(isIdentityDocument(bp), true, 'legacy helper cannot tell source from resolved; loader sourceKind can');
  assert.deepEqual(BlueprintSchema.parse(bp), bp);
});

test('a slot id is an OPEN string at the schema (the registry check is validateBlueprint’s); a bundle kind is the CLOSED D-011 vocabulary', () => {
  assert.equal(
    SlotDeclarationSchema.safeParse({ slot: 'risk-posture' }).success,
    true,
    'unknown slot parses — validate.ts reports slot-unknown',
  );
  assert.equal(SlotDeclarationSchema.safeParse({ slot: '' }).success, false);
  assert.equal(SlotDeclarationSchema.safeParse({ slot: 'domain', cardinality: 'sometimes' }).success, false);
  for (const kind of BUNDLE_KINDS) assert.equal(BundleRefSchema.safeParse({ kind, ref: 'x' }).success, true, kind);
  assert.equal(
    BundleRefSchema.safeParse({ kind: 'skill', ref: 'x' }).success,
    false,
    'no skill kind — owner ruling 2026-09-02',
  );
  assert.equal(BundleRefSchema.safeParse({ kind: 'recipe', ref: '' }).success, false);
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      version: '2',
      versionOverride: { replaces: ['1'], reason: 'approved migration' },
    }).success,
    true,
  );
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      versionOverride: { replaces: ['1'], reason: 'missing target' },
    }).success,
    false,
  );
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      version: '2',
      versionOverride: { replaces: ['2'], reason: 'self' },
    }).success,
    false,
  );
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      version: '2',
      versionOverride: { replaces: ['1', '1'], reason: 'duplicate' },
    }).success,
    false,
  );
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      version: '2',
      versionOverride: { replaces: ['1'], reason: '' },
    }).success,
    false,
  );
  assert.equal(
    BundleRefSchema.safeParse({
      kind: 'recipe',
      ref: 'x',
      version: '2',
      versionOverride: { replaces: ['1'], reason: 'ok', untracked: true },
    }).success,
    false,
  );
});

test('attestation.contentHash must be a lowercase sha256 hex; signedBy is required', () => {
  assert.equal(AttestationSchema.safeParse({ contentHash: 'f'.repeat(64), signedBy: 'p' }).success, true);
  assert.equal(
    AttestationSchema.safeParse({ contentHash: 'F'.repeat(64), signedBy: 'p' }).success,
    false,
    'lowercase only',
  );
  assert.equal(
    AttestationSchema.safeParse({ contentHash: 'f'.repeat(40), signedBy: 'p' }).success,
    false,
    'sha256 length',
  );
  assert.equal(AttestationSchema.safeParse({ contentHash: 'f'.repeat(64) }).success, false, 'signedBy required');
});
