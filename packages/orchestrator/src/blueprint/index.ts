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
export type { BlueprintIssue, BlueprintValidation } from './validate.js';
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
