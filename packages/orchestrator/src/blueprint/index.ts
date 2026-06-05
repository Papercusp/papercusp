/**
 * `@papercusp/orchestrator/blueprint` — the Harness Blueprint engine.
 *
 * `harness-blueprint-orchestration-2026-06-03` Phase A (keystone). The engine is
 * the declarative orchestration layer: a Blueprint (schema.ts) is interpreted by
 * `deriveNext` (the pure replacement for `classifyDecision`), validated by
 * `validateBlueprint`, and loaded git-canonical → PG by the loader.
 *
 * Lives in this lib (not the operator app) so both the operator AND the
 * `papercusp init` CLI / distribution plan can import it.
 */
export * from './schema.js';
export type { PipelineAction } from './action.js';
export { deriveNext } from './derive-next.js';
export type { ParsedDecisionLike } from './derive-next.js';
export { validateBlueprint } from './validate.js';
export type { BlueprintIssue, BlueprintValidation, ValidateOptions } from './validate.js';
// Coord-op-program layer (coordination-ops-as-blueprint-primitives-2026-06-04):
// `{{ path }}` interpolation and the pure program interpreter (planStep /
// selectGateBranch — the program-mode `deriveNext`). These are the generic,
// domain-free step-program core — extracted to the borrowable
// `@papercusp/step-program` lib (generalize-libs-to-generic-2026-06-05 #5) and
// re-exported here. The string-expr DSL (`evalExpr`/`parseExpr`/`isValidExpr`)
// is deliberately NOT re-exported: the canonical condition language on this
// surface is the `@papercusp/rules` `DataCondition` (adopt-event-rules-engines
// D-002) — the spine injects `evaluateDataCondition` as its `WhenEval`; the
// string DSL remains only as step-program's standalone default.
export { readPath, truthy } from '@papercusp/step-program';
export type { Scope } from '@papercusp/step-program';
export { interpolate, interpolateArgs } from '@papercusp/step-program';
export { planStep, selectGateBranch, isProgramSpine } from '@papercusp/step-program';
export type { StepPlan, GateDecision } from '@papercusp/step-program';
export {
  loadBuiltinBlueprint,
  loadBlueprintFromFile,
  resolveBlueprint,
  resolveExtends,
  mergeRaw,
  blueprintHash,
  builtinBlueprintPath,
  resolveBuiltinExtends,
} from './loader.js';
export type { LoadedBlueprint, ResolveExtendsPath } from './loader.js';
