/**
 * P-001 — BlueprintSchema is the validator-of-record. These tests pin the
 * default-filling, the discriminated spine-action union, the loose header
 * schema, and round-trip idempotence (parse(parse(x)) === parse(x)).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { builtinBlueprintPath, resolveBlueprintSource } from './loader.js';
import { stableStringify } from './merge.js';
import {
  BlueprintSchema,
  BlueprintSourceDocumentSchema,
  BlueprintHeaderSchema,
  SpineActionSchema,
  finalizeEntryRole,
  finalizeEntryExtras,
} from './schema.js';

test('R-1: built-in workspace blueprints parse unchanged', () => {
  // Preservation control pinned before the identity schema changes. Compare both
  // authored source parses and inherited source parses, including abstract base.
  const baseline = JSON.parse(readFileSync(new URL('./workspace-parse-baseline.fixture.json', import.meta.url), 'utf8')) as {
    schemaSourceSha256: string;
    workspaces: Record<string, { source: string; resolved: string }>;
  };
  const root = dirname(dirname(builtinBlueprintPath('base')));
  const actual: typeof baseline.workspaces = {};
  const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
  for (const id of readdirSync(root).sort()) {
    const file = join(root, id, 'blueprint.yaml');
    if (!existsSync(file)) continue;
    const raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (Object.hasOwn(raw, 'slots')) continue;
    const resolved = resolveBlueprintSource(raw, { sourcePath: file });
    actual[id] = {
      source: hash(BlueprintSourceDocumentSchema.parse(raw)),
      resolved: hash(BlueprintSourceDocumentSchema.parse(resolved.merged)),
    };
  }
  assert.match(baseline.schemaSourceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(actual, baseline.workspaces);
});

/** Smallest blueprint that satisfies the required fields (id, workItem.kind, spine.edges). */
const minimal = {
  id: 'mini',
  workItem: { kind: 'feature' },
  spine: {
    edges: {
      DONE: { to: 'done' },
      NEXT_WORKER: { to: 'role', role: 'worker', extras: ['FEATURE_ID={feature}'] },
    },
  },
};

test('BlueprintSchema — minimal blueprint parses and fills defaults', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.id, 'mini');
  assert.equal(bp.version, '0.1.0');
  // workItem default idPrefix.
  assert.equal(bp.workItem.kind, 'feature');
  assert.equal(bp.workItem.idPrefix, 'W');
  // spine defaults.
  assert.equal(bp.spine.decider, 'director');
  assert.equal(bp.spine.maxTurns, 200);
  assert.deepEqual(bp.spine.default, { to: 'idle' });
  // layer defaults.
  assert.deepEqual(bp.roles, []);
  assert.equal(bp.planner.kind, 'none');
  assert.deepEqual(bp.reactive, []);
  assert.deepEqual(bp.gates.approvals, []);
  assert.equal(bp.recursion.enabled, false);
  assert.equal(bp.recursion.strategy, 'escalate');
  assert.equal(bp.recursion.maxDepth, 1);
  // knobs default — coding-style requiresRepo defaults true.
  assert.equal(bp.knobs.requiresRepo, true);
});

test('BlueprintSchema — coordination-topology layer: claimModel + coordination defaults (additive)', () => {
  // Absent ⇒ today's behavior: decider-dispatch, no coordination section.
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.spine.claimModel, 'decider-dispatch', 'claimModel defaults to decider-dispatch (backward-compatible)');
  assert.equal(bp.coordination, undefined, 'no coordination section by default');
});

test('BlueprintSchema — a flat-DISTRIBUTED (self-claim, broadcast, no Queen) topology parses', () => {
  const dist = {
    id: 'dist-broadcast',
    workItem: { kind: 'feature' },
    spine: {
      claimModel: 'self-claim-fifo',
      edges: { DONE: { to: 'done' }, NEXT_WORKER: { to: 'role', role: 'worker' } },
    },
    coordination: { broadcast: 'topic', review: 'none', sharedState: 'both', team: 'per-backlog' },
  };
  const bp = BlueprintSchema.parse(dist);
  assert.equal(bp.spine.claimModel, 'self-claim-fifo');
  assert.equal(bp.coordination?.broadcast, 'topic');
  assert.equal(bp.coordination?.sharedState, 'both');
  assert.equal(bp.coordination?.team, 'per-backlog');
  // coordination inner defaults fill when the section is present but partial.
  const partial = BlueprintSchema.parse({ ...dist, coordination: { broadcast: 'topic' } });
  assert.equal(partial.coordination?.review, 'none');
  assert.equal(partial.coordination?.sharedState, 'both');
});

test('BlueprintSchema — coordination enums reject unknown values', () => {
  assert.throws(() => BlueprintSchema.parse({ ...minimal, coordination: { team: 'per-galaxy' } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, spine: { ...minimal.spine, claimModel: 'telepathy' } }));
});

test('BlueprintSchema — role spine action fills extras/rejectWhenParallel defaults', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    spine: { edges: { NEXT_SECURITY: { to: 'role', role: 'security-reviewer' } } },
  });
  // `spine.edges` is optional on the schema; this test supplied it, so its absence after
  // a parse would itself be the bug — assert that rather than casting the optionality away.
  const edges = bp.spine.edges ?? assert.fail('parsed spine.edges must survive the parse');
  const edge = edges.NEXT_SECURITY;
  assert.equal(edge.to, 'role');
  if (edge.to === 'role') {
    assert.deepEqual(edge.extras, []);
    assert.equal(edge.rejectWhenParallel, false);
  }
});

test('BlueprintRoleSchema — preserves an optional baseRole without granting capabilities', () => {
  const bp = BlueprintSchema.parse({ ...minimal,
    roles: [{ id: 'app-analyst', baseRole: 'worker' }] });
  assert.equal(bp.roles[0]!.baseRole, 'worker');
  assert.equal(bp.roles[0]!.capabilities, undefined);
  assert.equal(bp.fleet, undefined);
  assert.equal(BlueprintSchema.parse({ ...minimal, roles: [{ id: 'bare' }] }).roles[0]!.baseRole, undefined);
  assert.throws(() => BlueprintSchema.parse({ ...minimal, roles: [{ id: 'bad', baseRole: '' }] }));
});

test('BlueprintRoleSchema — role `isolation` is an optional worktree/none enum (BRIEF-demo-blueprints ②)', () => {
  // a role can declare worktree isolation (migration's transformer); it survives.
  const isolated = BlueprintSchema.parse({
    ...minimal,
    roles: [{ id: 'transformer', isolation: 'worktree' }],
  });
  assert.equal(isolated.roles[0]!.isolation, 'worktree');
  // omitted → undefined (default shared-tree behavior, no field invented).
  const bare = BlueprintSchema.parse({ ...minimal, roles: [{ id: 'discoverer' }] });
  assert.equal(bare.roles[0]!.isolation, undefined);
  // an invalid isolation value is rejected by the enum.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, roles: [{ id: 'x', isolation: 'sandbox' }] }));
});

test('SpineActionSchema — discriminated union rejects an unknown action kind', () => {
  assert.throws(() => SpineActionSchema.parse({ to: 'teleport' }));
  // valid arms parse.
  assert.deepEqual(SpineActionSchema.parse({ to: 'done' }), { to: 'done' });
  assert.equal(SpineActionSchema.parse({ to: 'escalate', reasonFrom: 'arg' }).to, 'escalate');
});

// ── kind: — the privileged-blueprint discriminator (local-hive D-009 / swarm D-018) ──

test("BlueprintSchema — kind defaults to 'harness' (additive, optional-with-default)", () => {
  // An existing blueprint with no `kind` parses unchanged as a general harness.
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.kind, 'harness');
});

test("BlueprintSchema — kind:'pot' parses (the privileged Mug blueprint; hive→pot, WI-2932)", () => {
  const pot = BlueprintSchema.parse({ ...minimal, kind: 'pot' });
  assert.equal(pot.kind, 'pot');
  // round-trips (validator-of-record).
  assert.deepEqual(BlueprintSchema.parse(pot), pot);
});

test('BlueprintSchema — kind is a closed enum (unknown AND pre-rename kinds are rejected)', () => {
  assert.throws(() => BlueprintSchema.parse({ ...minimal, kind: 'swarm' }));
  // The pre-rename 'hive' kind is NOT dual-accepted: built-ins are renamed in lockstep
  // and installed/workspace blueprints re-validate on load, so a stale kind fails loud.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, kind: 'hive' }));
});

test('BlueprintSchema — rejects a blueprint missing required fields', () => {
  assert.throws(() => BlueprintSchema.parse({ id: 'x' })); // no workItem / spine
  assert.throws(() => BlueprintSchema.parse({ id: 'x', workItem: { kind: 'feature' } })); // no spine
});

// ── dispatch: — the declared autoloop dispatch policy ───────────────────────
// autoloop-pot-operator-rebuild-2026-06-05 D-005 (P-005): the last "lift
// hardcoded → declarative" for the autoloop.

test('DispatchSchema — optional: an undeclared dispatch stays undefined (pot / launch blueprints)', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.dispatch, undefined);
});

test('DispatchSchema — a bare dispatch section fills the legacy-equivalent defaults', () => {
  const bp = BlueprintSchema.parse({ ...minimal, dispatch: {} });
  assert.ok(bp.dispatch);
  // priority defaults to the only implemented mode.
  assert.equal(bp.dispatch.priority, 'plan-order');
  // readiness defaults to the legacy needs-work set (todo/failing + the
  // pending/failed FeatureRecord aliases) — byte-equivalent to the hardcoded
  // NEEDS_WORK the orchestrator used pre-lift.
  assert.deepEqual(bp.dispatch.readiness, ['todo', 'failing', 'pending', 'failed']);
  // concurrency / costCapUsd / safetyCeiling stay undeclared (the orchestrator
  // then falls back to per-install config + imperative defaults).
  assert.equal(bp.dispatch.concurrency, undefined);
  assert.equal(bp.dispatch.costCapUsd, undefined);
  assert.equal(bp.dispatch.safetyCeiling, undefined);
});

test('DispatchSchema — a full coding-style policy parses + round-trips', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    dispatch: {
      concurrency: 4,
      priority: 'plan-order',
      readiness: ['todo', 'failing'],
      costCapUsd: 25,
      safetyCeiling: 8,
    },
  });
  assert.deepEqual(bp.dispatch, {
    concurrency: 4,
    priority: 'plan-order',
    readiness: ['todo', 'failing'],
    costCapUsd: 25,
    safetyCeiling: 8,
  });
  // idempotent (validator-of-record round-trips, like the rest of the schema).
  assert.deepEqual(BlueprintSchema.parse(bp), bp);
});

test('DispatchSchema — rejects degenerate values', () => {
  // concurrency must be a positive integer.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: 0 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: -1 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { concurrency: 2.5 } }));
  // priority is a closed enum — an unimplemented mode is rejected, not stored.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { priority: 'fifo' } }));
  // readiness must be a non-empty list of non-empty statuses.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { readiness: [] } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { readiness: [''] } }));
  // safetyCeiling / costCapUsd must be positive.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { safetyCeiling: 0 } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, dispatch: { costCapUsd: 0 } }));
});

test('Acceptance/Output/Affinity — optional domain-profile sections default to undefined', () => {
  const bp = BlueprintSchema.parse(minimal);
  // Additive + optional: a blueprint that declares none parses unchanged (no keys appear).
  assert.equal(bp.acceptance, undefined);
  assert.equal(bp.output, undefined);
  assert.equal(bp.affinity, undefined);
});

test('AcceptanceSchema — bare section defaults to none; judge reuses the gym rubric shape', () => {
  assert.equal(BlueprintSchema.parse({ ...minimal, acceptance: {} }).acceptance?.kind, 'none');
  const judged = BlueprintSchema.parse({
    ...minimal,
    acceptance: { kind: 'judge', rubric: { dimensions: { accuracy: 'is it right' }, weights: { accuracy: 1 } } },
  });
  assert.equal(judged.acceptance?.kind, 'judge');
  assert.equal(judged.acceptance?.rubric?.version, 'v1'); // GymRubricSchema default fills through
  assert.deepEqual(judged.acceptance?.rubric?.dimensions, { accuracy: 'is it right' });
  // closed enum — an unknown acceptance mode is rejected, not stored.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, acceptance: { kind: 'vibes' } }));
});

test('OutputSchema — bare section defaults to repo-commit; kind is a closed enum', () => {
  assert.equal(BlueprintSchema.parse({ ...minimal, output: {} }).output?.kind, 'repo-commit');
  assert.equal(BlueprintSchema.parse({ ...minimal, output: { kind: 'artifacts' } }).output?.kind, 'artifacts');
  assert.throws(() => BlueprintSchema.parse({ ...minimal, output: { kind: 'stdout' } }));
});

test('AffinitySchema — bare section defaults to file-overlap; kind is a closed enum', () => {
  assert.equal(BlueprintSchema.parse({ ...minimal, affinity: {} }).affinity?.kind, 'file-overlap');
  assert.equal(BlueprintSchema.parse({ ...minimal, affinity: { kind: 'topic-overlap' } }).affinity?.kind, 'topic-overlap');
  assert.throws(() => BlueprintSchema.parse({ ...minimal, affinity: { kind: 'random' } }));
});

test('Dependencies — blueprints (spawned-blueprint closure) defaults to [] and accepts a list', () => {
  assert.equal(BlueprintSchema.parse(minimal).dependencies, undefined); // optional, unchanged when absent
  assert.deepEqual(BlueprintSchema.parse({ ...minimal, dependencies: {} }).dependencies?.blueprints, []);
  const withDeps = BlueprintSchema.parse({ ...minimal, dependencies: { blueprints: ['coding', 'research'] } });
  assert.deepEqual(withDeps.dependencies?.blueprints, ['coding', 'research']);
});

test('Hive domain-profile (lexicon/fleet/wake/learning/placement) — optional, default to undefined', () => {
  const bp = BlueprintSchema.parse(minimal);
  assert.equal(bp.lexicon, undefined);
  assert.equal(bp.fleet, undefined);
  assert.equal(bp.wake, undefined);
  assert.equal(bp.learning, undefined);
  assert.equal(bp.placement, undefined);
});

test('FleetSchema — worker roles carry an enforced capability envelope; watcher is one or many', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    fleet: { workerRoles: [{ id: 'cup', capabilities: ['coord:send', 'artifacts:save'] }], watcher: 'papercup' },
  });
  assert.equal(bp.fleet?.workerRoles[0]?.id, 'cup');
  assert.deepEqual(bp.fleet?.workerRoles[0]?.capabilities, ['coord:send', 'artifacts:save']);
  assert.equal(bp.fleet?.watcher, 'papercup');
  // capabilities default to [] when omitted; watcher accepts a list.
  const multi = BlueprintSchema.parse({
    ...minimal,
    fleet: { workerRoles: [{ id: 'cup' }], watcher: ['papercup', 'overwatch'] },
  });
  assert.deepEqual(multi.fleet?.workerRoles[0]?.capabilities, []);
  assert.deepEqual(multi.fleet?.watcher, ['papercup', 'overwatch']);
});

test('Wake/Learning/Placement/Lexicon — parse their declared shapes; placement enums are closed', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    lexicon: { workUnit: 'deliverable', reviewGate: 'review' },
    wake: { subscriptions: [{ on: 'work_items:create', note: 'new work' }], kickoffTemplate: 'survey the frontier' },
    learning: { pack: 'coding', loops: ['scout'] },
    placement: { injectLoadThreshold: 3, maxInjectPerBee: 2, strategy: 'balanced' },
  });
  assert.equal(bp.lexicon?.workUnit, 'deliverable');
  assert.equal(bp.wake?.subscriptions[0]?.on, 'work_items:create');
  assert.deepEqual(bp.learning?.loops, ['scout']);
  assert.equal(bp.placement?.strategy, 'balanced');
  // placement strategy is a closed enum; injectLoadThreshold a positive int.
  assert.throws(() => BlueprintSchema.parse({ ...minimal, placement: { strategy: 'random' } }));
  assert.throws(() => BlueprintSchema.parse({ ...minimal, placement: { injectLoadThreshold: 0 } }));
});

test('BlueprintSchema — parse is idempotent (validator-of-record round-trips)', () => {
  const once = BlueprintSchema.parse(minimal);
  const twice = BlueprintSchema.parse(once);
  assert.deepEqual(twice, once);
});

test('BlueprintHeaderSchema — reads id + extends, keeps extra fields (loose)', () => {
  const h = BlueprintHeaderSchema.parse({
    id: 'coding-fork',
    extends: 'coding',
    spine: { edges: {} }, // an unknown-to-the-header field — preserved, not stripped.
  });
  assert.equal(h.id, 'coding-fork');
  assert.equal(h.extends, 'coding');
  assert.ok('spine' in h, 'loose header preserves non-header fields for the merge');
});

test('BlueprintHeaderSchema — extends can be a string or an array', () => {
  assert.equal(BlueprintHeaderSchema.parse({ id: 'a', extends: 'base' }).extends, 'base');
  assert.deepEqual(BlueprintHeaderSchema.parse({ id: 'a', extends: ['base', 'coding'] }).extends, [
    'base',
    'coding',
  ]);
});

test('ReactiveRuleSchema — `cond` is the canonical @papercusp/rules DataCondition (D-002: the retired `custom` string hatch is gone)', () => {
  // A reactive rule may guard with a serializable DataCondition.
  const bp = BlueprintSchema.parse({
    ...minimal,
    reactive: [
      {
        role: 'debugger',
        when: {
          beforeRole: 'worker',
          cond: { all: [{ 'attempts': { gte: 3 } }, { 'feature.status': { in: ['failing'] } }] },
        },
      },
    ],
  });
  assert.deepEqual(bp.reactive[0].when.cond, {
    all: [{ attempts: { gte: 3 } }, { 'feature.status': { in: ['failing'] } }],
  });
  // The retired `custom: string` host-predicate hatch is no longer a schema key —
  // a stale blueprint carrying one parses (stripped), it does not resurrect.
  const stale = BlueprintSchema.parse({
    ...minimal,
    reactive: [{ role: 'debugger', when: { beforeRole: 'worker', custom: 'named-host-predicate' } }],
  });
  assert.ok(!('custom' in stale.reactive[0].when), 'custom is stripped, not preserved');
});

test('GatesSchema.finalize — entries accept plain role/step strings (legacy, unchanged)', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    gates: { finalize: { onDone: ['curator', 'postCuratorOutputs', 'documenter', 'archive'], onEscalate: ['curator'] } },
  });
  assert.deepEqual(bp.gates.finalize?.onDone, ['curator', 'postCuratorOutputs', 'documenter', 'archive']);
  assert.equal(finalizeEntryRole(bp.gates.finalize!.onDone[0]), 'curator');
  assert.deepEqual(finalizeEntryExtras(bp.gates.finalize!.onDone[0]), []);
});

test('GatesSchema.finalize — a `{role,extras}` entry parameterizes a role launch declaratively (EI-421)', () => {
  const bp = BlueprintSchema.parse({
    ...minimal,
    gates: {
      finalize: {
        onDone: ['curator', { role: 'documenter', extras: ['OUTPUT_KIND=artifacts', 'SINK=blob-store'] }],
        onEscalate: [],
      },
    },
  });
  const docEntry = bp.gates.finalize!.onDone[1];
  assert.equal(finalizeEntryRole(docEntry), 'documenter');
  assert.deepEqual(finalizeEntryExtras(docEntry), ['OUTPUT_KIND=artifacts', 'SINK=blob-store']);
  // extras defaults to [] when omitted on the object form.
  const bare = BlueprintSchema.parse({
    ...minimal,
    gates: { finalize: { onDone: [{ role: 'committer' }], onEscalate: [] } },
  });
  assert.deepEqual(finalizeEntryExtras(bare.gates.finalize!.onDone[0]), []);
});
