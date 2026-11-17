import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BlueprintSourceDocumentSchema,
  IdentitySourceDocumentSchema,
  ResolvedAgentSpecificationSchema,
  RunnableBlueprintSchema,
  SessionActivationSchema,
  parseBlueprintSourceDocument,
} from './schema.js';

const sha = (char: string) => char.repeat(64);
const runnableInput = {
  id: 'runtime',
  workItem: { kind: 'feature' as const },
  spine: { edges: { DONE: { to: 'done' } } },
};

test('authored source schemas separate identity contributions from runnable blueprint fields', () => {
  const identity = { id: 'researcher', extends: 'identity-root', slots: [{ slot: 'domain' }] };
  assert.equal(IdentitySourceDocumentSchema.safeParse(identity).success, true);
  assert.equal(parseBlueprintSourceDocument(identity).kind, 'identity');
  assert.equal(BlueprintSourceDocumentSchema.safeParse({ id: 'abstract', knobs: { maxDepth: 2 } }).success, true);
  assert.equal(parseBlueprintSourceDocument({ id: 'abstract', knobs: { maxDepth: 2 } }).kind, 'blueprint');
  assert.equal(
    IdentitySourceDocumentSchema.safeParse({ ...identity, ...runnableInput }).success,
    false,
    'authored identities cannot carry runnable workspace fields',
  );
  assert.throws(
    () => parseBlueprintSourceDocument({ ...identity, undeclaredAuthority: true }),
    /Unrecognized key.*undeclaredAuthority/,
    'a contribution outside the schema-derived field vocabulary fails instead of disappearing',
  );
});

test('runnable blueprints and resolved specifications are separate validated, immutable contracts', () => {
  const configuration = RunnableBlueprintSchema.parse(runnableInput);
  const specification = ResolvedAgentSpecificationSchema.parse({
    schemaVersion: 1,
    specificationRevision: sha('a'),
    compilerVersion: '1.0.0',
    source: { id: 'runtime', kind: 'blueprint', contentHash: sha('b') },
    configuration,
    inputs: [
      { kind: 'blueprint-layer', ref: 'base', revision: '0.1.0', contentHash: sha('c'), sourceKind: 'blueprint' },
      { kind: 'prompt-file', ref: 'prompts/runtime.md', contentHash: sha('d'), bytes: 'act carefully\n' },
      { kind: 'addressed-document', ref: 'workspace:guide', revision: '17', contentHash: sha('e') },
      { kind: 'setting', ref: 'mode:auto', revision: '7', value: { enabled: true } },
    ],
    provenance: [{ path: 'configuration.knobs', sourceRef: 'base', sourceRevision: '0.1.0' }],
  });
  assert.equal(Object.isFrozen(specification), true);
  assert.equal(Object.isFrozen(specification.inputs), true);
  assert.equal(Object.isFrozen(specification.configuration), true);
  assert.equal(specification.configuration.id, 'runtime');
  assert.equal(
    ResolvedAgentSpecificationSchema.safeParse({ ...specification, schemaVersion: 2 }).success,
    false,
    'schema changes require an explicit version bump and reader migration',
  );
});

test('session activation revisions can change without changing accountable actor/principal/session attribution', () => {
  const attribution = { actorId: 'su-b6351', principalId: 'aviynw3@gmail.com', sessionId: 'session-1' };
  const initial = SessionActivationSchema.parse({
    schemaVersion: 1,
    attribution,
    desired: { specificationRevision: sha('a'), stateRevision: '41' },
    prepared: null,
    applied: { specificationRevision: sha('a'), stateRevision: '41' },
    status: 'applied',
  });
  const switched = SessionActivationSchema.parse({
    ...initial,
    desired: { specificationRevision: sha('b'), stateRevision: '42' },
    prepared: { specificationRevision: sha('b'), stateRevision: '42' },
    status: 'prepared',
  });
  assert.deepEqual(switched.attribution, initial.attribution);
  assert.equal(Object.isFrozen(switched), true);
  assert.equal(Object.isFrozen(switched.attribution), true);
  assert.equal(switched.applied?.specificationRevision, sha('a'), 'old applied truth remains explicit until acknowledgement');
});
