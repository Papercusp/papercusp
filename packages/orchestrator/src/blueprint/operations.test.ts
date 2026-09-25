import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BlueprintSchema, type BlueprintOperation } from './schema.js';
import { validateBlueprint } from './validate.js';

const hash = 'a'.repeat(64);
const inputSchema = {
  type: 'object',
  properties: { itemId: { type: 'string' } },
  required: ['itemId'],
  additionalProperties: false,
};
const resultSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
};
const directOperation = (): BlueprintOperation => ({
  id: 'extract',
  version: '1',
  target: { kind: 'work-item', itemKind: 'task' },
  execution: { kind: 'agent', role: 'worker' },
  inputSchema,
  acceptance: { resultSchema },
  policy: {
    requiredTools: ['demo:read'],
    model: { mode: 'exact', models: ['gpt-6-sol'], onUnavailable: 'fail' },
  },
  artifacts: [{ kind: 'artifact', ref: 'spec-extractor', revision: '1', contentHash: hash }],
  signals: { review: { payloadSchema: { type: 'object' } } },
  waits: { approval: { responseSchema: { type: 'object' } } },
});
const raw = (operations: unknown = [directOperation()]) => ({
  id: 'operation-fixture',
  workItem: { kind: 'task' },
  roles: [{ id: 'director' }, { id: 'worker' }],
  spine: { edges: { NEXT_WORKER: { to: 'role', role: 'worker' }, DONE: { to: 'done' } } },
  dependencies: { tools: ['demo:read'] },
  operations,
});

test('legacy blueprint bytes gain no implicit operations manifest', () => {
  const { operations: _operations, ...legacy } = raw();
  const parsed = BlueprintSchema.parse(legacy);
  assert.equal(parsed.operations, undefined);
  assert.deepEqual(BlueprintSchema.parse(parsed), parsed);
});

test('direct and explicit-plan operations carry typed interfaces and exact pins', () => {
  const plan = {
    id: 'batch',
    version: '1',
    target: { kind: 'plan', template: { kind: 'plan-template', ref: 'batch-template', revision: '7', contentHash: hash } },
    inputSchema,
    acceptance: { resultSchema },
  };
  const recipe = {
    ...directOperation(),
    id: 'summarize',
    execution: { kind: 'recipe', recipe: { kind: 'recipe', ref: 'summary-recipe', revision: '4', contentHash: hash } },
    policy: { requiredTools: ['demo:read'] },
  };
  const blueprint = BlueprintSchema.parse(raw([directOperation(), plan, recipe]));
  assert.equal(validateBlueprint(blueprint).ok, true);
  assert.deepEqual(blueprint.operations?.map((operation) => operation.target.kind), ['work-item', 'plan', 'work-item']);
  assert.equal(blueprint.operations?.[0]?.policy.model?.mode, 'exact');
  assert.equal(blueprint.operations?.[1]?.target.kind, 'plan');
  assert.equal(blueprint.operations?.[2]?.execution?.kind, 'recipe');
  assert.deepEqual(BlueprintSchema.parse(blueprint), blueprint);
});

test('operation manifests reject unpinned references and untyped input or result', () => {
  const op = directOperation();
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, inputSchema: {} }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, inputSchema: { type: 'object', anyOf: [] } }])).success, true);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, acceptance: { resultSchema: {} } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, acceptance: { resultSchema: { anyOf: [] } } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, inputSchema: { type: 'unrecognized' } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, acceptance: { resultSchema: { type: 'unrecognized', enum: ['x'] } } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, artifacts: [{ kind: 'artifact', ref: 'a', revision: '1' }] }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, execution: { kind: 'recipe', recipe: { kind: 'recipe', ref: 'r', revision: '1' } } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, policy: { model: { mode: 'exact', models: ['a', 'b'] } } }])).success, false);
  const plan = { ...op, target: { kind: 'plan', template: {
    kind: 'plan-template', ref: 'batch-template', revision: '7', contentHash: hash } } };
  assert.equal(BlueprintSchema.safeParse(raw([plan])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, execution: { kind: 'program' } }])).success, false);
  assert.equal(BlueprintSchema.safeParse(raw([{ ...op, execution: { kind: 'recipe', recipe: {
    kind: 'recipe', ref: 'summary-recipe', revision: '4', contentHash: hash } } }])).success, false);
});

test('operation validation refuses duplicate, incompatible and authority-widening declarations', () => {
  const op = directOperation();
  const withoutModel = { ...op, policy: { requiredTools: ['demo:read'] } };
  const errors = (operations: unknown) => validateBlueprint(BlueprintSchema.parse(raw(operations))).errors.map((issue) => issue.code);
  assert.ok(errors([op, op]).includes('duplicate-operation'));
  assert.ok(errors([{ ...op, execution: { kind: 'agent', role: 'missing' } }]).includes('operation-unknown-role'));
  assert.ok(errors([{ ...op, policy: { requiredTools: ['undeclared:write'] } }]).includes('operation-undeclared-tool'));
  assert.ok(errors([{ ...withoutModel, execution: undefined }]).includes('work-item-operation-executor'));
  assert.ok(errors([{ ...withoutModel, execution: { kind: 'program' } }]).includes('operation-no-program'));
  assert.ok(errors([{ ...op, signals: { approval: { payloadSchema: { type: 'object' } } } }]).includes('operation-channel-collision'));
  const plan = {
    ...withoutModel,
    target: { kind: 'plan', template: { kind: 'plan-template', ref: 'batch', revision: '1', contentHash: hash } },
  };
  assert.ok(errors([plan]).includes('plan-operation-executor'));
});
