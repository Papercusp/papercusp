/**
 * The `coding` blueprint — the default per-feature pipeline (scoper → architect →
 * worker → validator → … → curator) and the zero-regression anchor for the whole
 * blueprint engine (harness-blueprint-orchestration-2026-06-03, D-024). The
 * behaviour-preserving lift of the legacy `classifyDecision` switch into declared
 * spine edges.
 *
 * `loader.test.ts` already covers coding's load + base-knob inheritance + merge;
 * this file covers the complementary half: that the loaded spine DRIVES through
 * `deriveNext` exactly as the legacy switch did — every lifecycle / quality /
 * terminal / global-only verb maps to the right `PipelineAction` — plus the
 * role-prompt resolvability + the reactive debugger-gate shape.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolvePromptFile } from '../prompt-resolve.js';
import { harnessPath } from '@papercusp/harness/paths';
import { loadBuiltinBlueprint } from './loader.js';
import { deriveNext, type ParsedDecisionLike } from './derive-next.js';

const decision = (verb: string, arg: string | null = null, n: number | null = null): ParsedDecisionLike => ({
  verb,
  arg,
  n,
});

const F = 'F-042';

test('coding blueprint loads + validates with no errors', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('coding-factory');
  assert.equal(blueprint.id, 'coding-factory');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
});

test('coding blueprint has the expected feature-pipeline shape', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  assert.equal(bp.workItem.kind, 'feature');
  assert.equal(bp.workItem.idPrefix, 'F');
  assert.equal(bp.spine.decider, 'director');
  assert.equal(bp.knobs.requiresRepo, true);
  assert.equal(bp.knobs.harnessKind, 'coding');
  assert.equal(bp.knobs.debuggerThreshold, 3);
  // coding's verb vocabulary (distinct from research/review)
  for (const verb of ['NEXT_SCOPER', 'NEXT_ARCHITECT', 'NEXT_WORKER', 'NEXT_VALIDATOR']) {
    assert.ok(Object.prototype.hasOwnProperty.call(bp.spine.edges, verb), `missing edge ${verb}`);
  }
  // the Level-2 DAG planner is the plans→features import
  assert.equal(bp.planner.kind, 'features-import');
  // coding collects its gym trace from the substrate git diff (a repo harness)
  assert.equal(bp.gym?.collectTrace, 'git-diff');
});

test('deriveNext drives the per-feature lifecycle verbs to the right roles', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  const s = bp.spine;
  assert.deepEqual(deriveNext(s, decision('NEXT_SCOPER', F), F), {
    kind: 'dispatch',
    role: 'scoper',
    feature: F,
    extras: [`FEATURE_ID=${F}`],
  });
  assert.deepEqual(deriveNext(s, decision('NEXT_ARCHITECT', F), F), {
    kind: 'dispatch',
    role: 'architect',
    feature: F,
    extras: [`FEATURE_ID=${F}`],
  });
  assert.deepEqual(deriveNext(s, decision('NEXT_WORKER', F), F), {
    kind: 'dispatch',
    role: 'worker',
    feature: F,
    extras: [`FEATURE_ID=${F}`],
  });
  assert.deepEqual(deriveNext(s, decision('NEXT_VALIDATOR', F), F), {
    kind: 'dispatch',
    role: 'validator',
    feature: F,
    extras: [`FEATURE_ID=${F}`],
  });
});

test('NEXT_WORKER N=k is rejected — parallel lanes are the global orchestrator job (D-001)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  // NEXT_WORKER sets rejectWhenParallel; an N=k decision → unsupported.
  assert.deepEqual(deriveNext(bp.spine, decision('NEXT_WORKER', F, 4), F), {
    kind: 'unsupported',
    verb: 'NEXT_WORKER N=4',
  });
  // global-only verbs the per-feature pipeline deliberately does not run
  assert.deepEqual(deriveNext(bp.spine, decision('NEXT_HARNESS'), F), { kind: 'unsupported', verb: 'NEXT_HARNESS' });
  assert.deepEqual(deriveNext(bp.spine, decision('NEXT_WORKER_CEO_MODE'), F), {
    kind: 'unsupported',
    verb: 'NEXT_WORKER_CEO_MODE',
  });
});

test('quality verbs carry their own extras templating', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  const s = bp.spine;
  // NEXT_TESTER templates VAL_ID from the raw arg (not the feature)
  assert.deepEqual(deriveNext(s, decision('NEXT_TESTER', 'V-9'), F), {
    kind: 'dispatch',
    role: 'tester',
    feature: 'V-9',
    extras: ['VAL_ID=V-9'],
  });
  // NEXT_SECURITY dispatches the security-reviewer with no extras
  assert.deepEqual(deriveNext(s, decision('NEXT_SECURITY'), F), {
    kind: 'dispatch',
    role: 'security-reviewer',
    feature: F,
    extras: [],
  });
});

test('terminal + benign-global verbs map correctly', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  const s = bp.spine;
  assert.deepEqual(deriveNext(s, decision('DONE'), F), { kind: 'terminal', outcome: 'done' });
  assert.deepEqual(deriveNext(s, decision('IDLE'), F), { kind: 'terminal', outcome: 'idle' });
  // ESCALATE carries its reason from the arg
  assert.deepEqual(deriveNext(s, decision('ESCALATE', 'blocked on infra'), F), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'blocked on infra',
  });
  // CHECKPOINT (deprecated) → escalate; with no arg it falls back to its static reason
  assert.deepEqual(deriveNext(s, decision('CHECKPOINT', null), F), {
    kind: 'terminal',
    outcome: 'escalate',
    reason: 'checkpoint (deprecated)',
  });
  // benign global/phase verbs stop this pipeline cleanly (idle → re-scan)
  for (const verb of ['CONVERTED', 'FEATURE_FREEZE', 'READY_FOR_PROD', 'RUN_TESTS']) {
    assert.deepEqual(deriveNext(s, decision(verb), F), { kind: 'terminal', outcome: 'idle' }, `${verb} → idle`);
  }
  // an unparseable / unknown verb hits the default (idle)
  assert.deepEqual(deriveNext(s, decision('GIBBERISH'), F), { kind: 'terminal', outcome: 'idle' });
  assert.deepEqual(deriveNext(s, null, F), { kind: 'terminal', outcome: 'idle' });
});

test('every declared coding role has a resolvable prompt file', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  assert.ok(bp.roles.length >= 8, 'coding declares its pipeline + quality roles');
  for (const role of bp.roles) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'coding-factory' },
      role.id,
    );
    assert.ok(found, `missing prompt for coding role "${role.id}" (blueprints/coding-factory/prompts or base)`);
  }
});

test('the reactive debugger gate fires before a worker retry once attempts ≥ threshold', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  const rule = bp.reactive.find((r) => r.role === 'debugger');
  assert.ok(rule, 'debugger reactive rule declared');
  assert.equal(rule!.when.beforeRole, 'worker');
  assert.equal(rule!.when.minAttempts, 3);
  assert.equal(rule!.when.unless, 'debug-note');
  // read-only — it does NOT preempt the worker dispatch
  assert.equal(rule!.preempt, false);
});

test('coding declares params = base universal ∪ coding-specific (P-006 / D-003)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('coding-factory');
  const params = bp.params;
  // keys are config.json INSTANCE paths (what the settings panel persists), NOT blueprint-knobs paths.
  // base's UNIVERSAL params are inherited (the record unions across `extends: base`)
  assert.ok(params['parallelWorkers.max'], 'inherits base concurrency param');
  assert.ok(params['aiBackend.default.model'], 'inherits base backend-model param');
  assert.ok(params['aiBackend.default.engine'], 'inherits base execution-engine param');
  assert.ok(params['aiBackend.default.agentCmd'], 'inherits base backend-cmd param');
  // coding-SPECIFIC params (the old hardcoded HarnessSettingsPanel knobs, now declared)
  assert.ok(params['debugger.threshold'], 'coding declares debugger.threshold param');
  assert.ok(params['parallelWorkers.useChunkLoop'], 'coding declares useChunkLoop param');
  assert.ok(params['parallelWorkers.workingStateCheck'], 'coding declares workingStateCheck param');
  assert.ok(params['parallelWorkers.replanStrikes'], 'coding declares replanStrikes param');
  assert.ok(params['parallelWorkers.escalateToRole'], 'coding declares escalateToRole param');
  // ParamSpec shape carried through (type / group / number range / default)
  assert.equal(params['parallelWorkers.max'].type, 'number');
  assert.equal(params['parallelWorkers.max'].group, 'Dispatch');
  assert.equal(params['parallelWorkers.max'].min, 1);
  assert.equal(params['parallelWorkers.max'].max, 64);
  assert.equal(params['parallelWorkers.max'].default, 1);
  assert.equal(params['debugger.threshold'].group, 'Workers');
  assert.equal(params['debugger.threshold'].default, 3);
  assert.equal(params['parallelWorkers.useChunkLoop'].type, 'boolean');
  assert.equal(params['parallelWorkers.useChunkLoop'].default, true);
});
