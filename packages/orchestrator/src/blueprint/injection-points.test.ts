/**
 * P-010 — a contribution's declared injection point is validated where every
 * blueprint is parsed (compile and pinned replay both parse through the schema),
 * so an undeliverable declaration is refused at compile, never at a live sink.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintContributionSchema, BlueprintSchema } from './schema.js';

const injection = {
  sinks: ['turn-start'], trigger: 'every-turn', tokenBudget: 100, priority: 50, overBudget: 'truncate',
} as const;

const provider = {
  id: 'live-notes', purpose: 'prompt', source: 'provider', refresh: 'turn',
  inputKind: 'prompt-file', ref: 'live-notes', producerRef: 'papercusp.turn-start-orientation@1', verb: 'render',
} as const;

function issuesAt(input: unknown, path: string): string[] {
  const parsed = BlueprintContributionSchema.safeParse(input);
  assert.equal(parsed.success, false, `expected ${JSON.stringify(input)} to be refused`);
  return parsed.error!.issues.filter((issue) => issue.path.join('.') === path).map((issue) => issue.message);
}

test('a deliverable injection point parses and is kept on the contribution', () => {
  const parsed = BlueprintContributionSchema.parse({ ...provider, injection });
  assert.deepEqual(parsed.injection, injection);
  assert.equal(BlueprintContributionSchema.parse(provider).injection, undefined);
});

test('fixed content cannot declare an injection point', () => {
  const fixed = { id: 'rules', purpose: 'prompt', source: 'fixed', refresh: 'source-change',
    inputKind: 'prompt-file', ref: 'fixed:rules', injection: { ...injection, trigger: 'every-turn' } };
  assert.match(issuesAt(fixed, 'injection').join('\n'), /only provider output is injected/);
});

test('a structured sink is refused for a package class', () => {
  const messages = issuesAt({ ...provider, injection: { ...injection, sinks: ['leader-brief'] } }, 'injection.sinks.0');
  assert.match(messages.join('\n'), /structured sink/);
});

test('the trigger must match the declared refresh cadence', () => {
  const messages = issuesAt({ ...provider, injection: { ...injection, trigger: 'on-demand' } }, 'injection.trigger');
  assert.match(messages.join('\n'), /evaluated on refresh 'on-demand'/);
});

test('an output with no text cannot be injected', () => {
  const setting = { id: 'knob', purpose: 'operational', source: 'provider', refresh: 'turn',
    inputKind: 'setting', ref: 'knob', producerRef: 'papercusp.mode-state@1', verb: 'read', injection };
  assert.match(issuesAt(setting, 'injection').join('\n'), /has no text to inject/);
});

test('a shape error is reported once, by the field, without cross-field noise', () => {
  const parsed = BlueprintContributionSchema.safeParse({ ...provider, injection: { ...injection, tokenBudget: 5_000 } });
  assert.equal(parsed.success, false);
  const injectionIssues = parsed.error!.issues.filter((issue) => issue.path[0] === 'injection');
  assert.deepEqual(injectionIssues.map((issue) => issue.path.join('.')), ['injection.tokenBudget']);
  assert.notEqual(injectionIssues[0]!.code, 'custom');
});

test('the full blueprint schema refuses an undeliverable contribution', () => {
  const blueprint = {
    id: 'mini', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
    contributions: [{ ...provider, injection: { ...injection, sinks: ['carry-brief'] } }],
  };
  const parsed = BlueprintSchema.safeParse(blueprint);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error!.issues.some((issue) => issue.path.join('.') === 'contributions.0.injection.sinks.0'));
  assert.equal(BlueprintSchema.safeParse({ ...blueprint, contributions: [{ ...provider, injection }] }).success, true);
});
