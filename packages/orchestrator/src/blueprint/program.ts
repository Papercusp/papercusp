/**
 * `program` — the pure coord-op-program interpreter (`coordination-ops-as-
 * blueprint-primitives-2026-06-04` P-005 / D-005). The program-mode analogue of
 * `deriveNext`: it reads the spine `steps` + `gate` and a bound scope and decides
 * *what op to run with what args* — but never runs it (no I/O / DBOS). The durable
 * `coordProgramWorkflow` consumes these decisions, invokes the op as a checkpointed
 * step, binds the result back into the scope, and asks again. Same purity boundary
 * that makes `deriveNext` unit-testable + replay-safe applies here.
 *
 *   planStep(step, scope)        → run the op (interpolated args) | skip it (`when` false)
 *   selectGateBranch(gate, scope) → the first matching branch + its interpolated args
 *
 * Conditions are evaluated by `expr.ts` (safe, no-eval) and args by
 * `interpolate.ts` (`{{ path }}`, type-preserving).
 */
import type { CoordOpStep, GateBranch } from './schema.js';
import { evalExpr, type Scope } from './expr.js';
import { interpolateArgs } from './interpolate.js';

/** The decision for one step: invoke `op` with interpolated `args`, or skip. */
export type StepPlan =
  | { kind: 'skip'; reason: string }
  | { kind: 'invoke'; op: string; args: Record<string, unknown>; bind?: string };

/**
 * Decide what to do with one coord-op step against the current scope. A `when`
 * guard that evaluates false → skip (the step's bind stays unset). Otherwise →
 * invoke the op with `{{ path }}`-interpolated args.
 */
export function planStep(step: CoordOpStep, scope: Scope): StepPlan {
  if (step.when != null && step.when.trim() !== '' && !evalExpr(step.when, scope)) {
    return { kind: 'skip', reason: `when "${step.when}" is false` };
  }
  return {
    kind: 'invoke',
    op: step.op,
    args: interpolateArgs(step.args, scope),
    bind: step.bind,
  };
}

/** The chosen gate branch + its interpolated args (or null when nothing matched). */
export interface GateDecision {
  branch: GateBranch;
  op: string;
  args: Record<string, unknown>;
  /** Index of the chosen branch (for tracing). */
  index: number;
}

/**
 * Select the gate branch that fires: the first branch whose `when` is true, in
 * declaration order; a branch with `else: true` or no `when` is the fallback and
 * always matches. Returns null only when no branch matched AND there is no
 * fallback (validateBlueprint rejects that shape — `gate-no-fallback`).
 */
export function selectGateBranch(gate: GateBranch[] | undefined, scope: Scope): GateDecision | null {
  if (!gate || gate.length === 0) return null;
  for (let i = 0; i < gate.length; i++) {
    const b = gate[i]!;
    const isFallback = b.else === true || b.when == null || b.when.trim() === '';
    if (isFallback || evalExpr(b.when!, scope)) {
      return { branch: b, op: b.op, args: interpolateArgs(b.args, scope), index: i };
    }
  }
  return null;
}

/** True if a spine is in program mode (has `steps`); false = decider mode. */
export function isProgramSpine(spine: { steps?: unknown[] }): boolean {
  return Array.isArray(spine.steps) && spine.steps.length > 0;
}
