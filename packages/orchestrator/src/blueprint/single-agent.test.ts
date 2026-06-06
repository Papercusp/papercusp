/**
 * The `single-agent` blueprint — the ABSTRACT parent for single-role
 * run-to-done launches (unify-agent-spawn-chokepoint-2026-06-06 P-014, D-006).
 * It `extends: base` and adds the shared single-role spine (the trivial
 * DONE/ESCALATE/IDLE edges + an inline planner) that `implement` / `scan` /
 * `merge-resolution` / `deploy` used to re-declare verbatim. Like `base`, it is
 * NEVER runnable standalone (it declares no `workItem` and no `spine.decider`); it
 * only ever appears as a parent in an `extends` merge.
 *
 * `launch-blueprints.test.ts` proves the four concrete children load + validate
 * after the migration; this file pins single-agent's OWN contract — the
 * abstract-not-loadable property and the spine/planner contribution through a
 * minimal child (the inheritance nothing else covers directly).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint, resolveBlueprint } from './loader.js';

test('single-agent is abstract — loading it standalone throws (no workItem)', () => {
  // BlueprintSchema requires workItem; single-agent supplies only the shared
  // spine shape, so a direct load must fail rather than produce a runnable shell.
  assert.throws(() => loadBuiltinBlueprint('single-agent'), /workItem|invalid|single-agent/i);
});

test('a child `extends: single-agent` inherits the single-role spine edges + inline planner', () => {
  const { blueprint, validation } = resolveBlueprint({
    id: 'tmp-single-agent-child',
    extends: 'single-agent',
    workItem: { kind: 'feature' },
    // the child supplies ONLY the decider role; edges + planner come from the parent
    spine: { decider: 'worker' },
    roles: [{ id: 'worker', description: 'run one role to done' }],
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(blueprint.spine.decider, 'worker');
  // the trivial run-to-done edges are inherited from single-agent
  assert.deepEqual(blueprint.spine.edges.DONE, { to: 'done' });
  assert.deepEqual(blueprint.spine.edges.ESCALATE, { to: 'escalate', reasonFrom: 'arg' });
  assert.deepEqual(blueprint.spine.edges.IDLE, { to: 'idle' });
  assert.deepEqual(blueprint.spine.default, { to: 'idle' });
  // inline planner inherited
  assert.equal(blueprint.planner.kind, 'inline');
  // base knobs still flow through the two-level chain (single-agent extends base)
  assert.equal(blueprint.knobs.logRetention, 500);
  // `extends` is consumed by the merge, not carried into the resolved blueprint
  assert.equal(blueprint.extends, undefined);
});

test('a child overrides the inherited maxTurns (deep-merge: child wins on the leaf, parent edges survive)', () => {
  const { blueprint } = resolveBlueprint({
    id: 'tmp-single-agent-maxturns',
    extends: 'single-agent',
    workItem: { kind: 'scan-run' },
    spine: { decider: 'scanner', maxTurns: 30 },
    roles: [{ id: 'scanner', description: 'sweep' }],
  });
  assert.equal(blueprint.spine.maxTurns, 30); // child override
  assert.deepEqual(blueprint.spine.edges.DONE, { to: 'done' }); // parent edges survive the merge
  assert.equal(blueprint.planner.kind, 'inline');
});
