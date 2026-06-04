/**
 * `validateBlueprint` — semantic validation of a resolved blueprint, beyond what
 * the Zod schema enforces structurally (`harness-blueprint-orchestration-2026-06-03`
 * P-005 / A4). Run author-time (the `blueprint:*` tools) AND on load (the
 * loader), so a malformed spine never reaches the durable pipeline.
 *
 * Pure. Checks, per the A4 spec:
 *   - reachability — every declared role is referenced somewhere; at least one
 *     terminal outcome is reachable.
 *   - termination — a terminal is reachable and `maxTurns` is finite/positive.
 *   - every node has an exit — every spine edge maps to a valid action (the
 *     schema guarantees this) and a `default` exists.
 *   - guards well-formed — reactive rules carry at least one condition.
 *   - bounded recursion — recursion, when enabled, declares a trigger and a
 *     finite depth.
 *   - work-item payload valid — `workItem.kind` is present (schema-enforced).
 *
 * `errors` make a blueprint unrunnable (reject); `warnings` are authoring smells
 * (e.g. a spine edge that dispatches a role with no prompt — the vestigial
 * tester/test-writer/monitor verbs kept for switch parity) that don't block.
 */
import type { Blueprint } from './schema.js';

export interface BlueprintIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface BlueprintValidation {
  ok: boolean;
  errors: BlueprintIssue[];
  warnings: BlueprintIssue[];
}

const TERMINAL = new Set(['done', 'escalate', 'idle']);
/** Finalize-recipe entries that are pipeline STEPS, not dispatchable roles. */
const FINALIZE_STEPS = new Set(['archive', 'postCuratorOutputs']);

export function validateBlueprint(bp: Blueprint): BlueprintValidation {
  const errors: BlueprintIssue[] = [];
  const warnings: BlueprintIssue[] = [];
  const err = (code: string, message: string) => errors.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => warnings.push({ level: 'warning', code, message });

  const roleIds = new Set(bp.roles.map((r) => r.id));

  // ── role declarations ──────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const r of bp.roles) {
    if (seen.has(r.id)) err('duplicate-role', `role "${r.id}" is declared more than once`);
    seen.add(r.id);
  }

  // ── spine: edges + termination + reachability ──────────────────────────────
  const edgeKeys = Object.keys(bp.spine.edges);
  if (edgeKeys.length === 0) {
    err('empty-spine', 'spine.edges is empty — the decider has no action to take');
  }
  if (!Number.isFinite(bp.spine.maxTurns) || bp.spine.maxTurns < 1) {
    err('bad-max-turns', `spine.maxTurns must be a finite positive integer (got ${bp.spine.maxTurns})`);
  }

  // A terminal must be reachable — via some edge OR the default — else the loop
  // can only ever spin until maxTurns.
  const anyTerminalEdge = Object.values(bp.spine.edges).some((a) => TERMINAL.has(a.to));
  const defaultTerminal = TERMINAL.has(bp.spine.default.to);
  if (!anyTerminalEdge && !defaultTerminal) {
    err('no-terminal', 'no terminal outcome is reachable (no terminal edge and a non-terminal default)');
  }

  // Decider should be a declared role (prompt-resolve has global fallbacks, so a
  // warning rather than a hard error).
  if (!roleIds.has(bp.spine.decider)) {
    warn('decider-undeclared', `spine.decider "${bp.spine.decider}" is not in roles[]`);
  }

  // Dispatch targets that aren't declared roles → likely vestigial/dormant verbs.
  const dispatched = new Set<string>();
  for (const [verb, action] of Object.entries(bp.spine.edges)) {
    if (action.to === 'role') {
      dispatched.add(action.role);
      if (!roleIds.has(action.role)) {
        warn(
          'dispatch-undeclared-role',
          `spine edge ${verb} dispatches role "${action.role}" which is not declared in roles[]`,
        );
      }
    }
  }

  // ── reactive overlay: guards well-formed ───────────────────────────────────
  for (const rule of bp.reactive) {
    const w = rule.when;
    const hasCond =
      w.beforeRole != null || w.afterRole != null || w.minAttempts != null || w.custom != null;
    if (!hasCond) {
      err('empty-reactive-guard', `reactive rule for "${rule.role}" has no trigger condition`);
    }
    if (!roleIds.has(rule.role)) {
      warn('reactive-undeclared-role', `reactive rule targets role "${rule.role}" not in roles[]`);
    }
    for (const ref of [w.beforeRole, w.afterRole]) {
      if (ref && !roleIds.has(ref) && !dispatched.has(ref)) {
        warn('reactive-unknown-anchor', `reactive rule references unknown role "${ref}"`);
      }
    }
  }

  // ── gates: finalize-recipe roles ───────────────────────────────────────────
  const finalize = bp.gates.finalize;
  if (finalize) {
    for (const step of [...finalize.onDone, ...finalize.onEscalate]) {
      if (!FINALIZE_STEPS.has(step) && !roleIds.has(step)) {
        warn('finalize-unknown-role', `gates.finalize references "${step}" which is neither a step nor a declared role`);
      }
    }
  }

  // ── recursion: bounded ─────────────────────────────────────────────────────
  if (bp.recursion.enabled) {
    if (!bp.recursion.spawnOn) {
      warn('recursion-no-trigger', 'recursion.enabled but no spawnOn trigger declared — it can never recurse');
    }
    if (!Number.isFinite(bp.recursion.maxDepth) || bp.recursion.maxDepth < 0) {
      err('recursion-unbounded', `recursion.maxDepth must be a finite non-negative integer (got ${bp.recursion.maxDepth})`);
    }
  }

  // ── reachability: declared-but-unused roles (dead roles) ───────────────────
  for (const id of roleIds) {
    const used =
      id === bp.spine.decider ||
      dispatched.has(id) ||
      bp.reactive.some((r) => r.role === id) ||
      (finalize ? [...finalize.onDone, ...finalize.onEscalate].includes(id) : false);
    if (!used) {
      warn('unused-role', `role "${id}" is declared but never dispatched, reactive, or in finalize`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
