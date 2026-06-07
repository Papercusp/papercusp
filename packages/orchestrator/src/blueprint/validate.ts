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
import { dataConditionSchema } from '@papercusp/rules';
import { CHILD_BLUEPRINT_PARAM_RE, isChildBlueprintParam } from './resolve-child.js';

/** A step/gate `when` is valid iff it's a serializable `@papercusp/rules` DataCondition. */
function isValidWhen(when: unknown): boolean {
  return dataConditionSchema.safeParse(when).success;
}

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

export interface ValidateOptions {
  /**
   * The set of registered coord-op names (the coord-op registry's keys). When
   * provided, a program step / gate branch that names an op NOT in the set is an
   * error (`unknown-op`). The pure lib doesn't own the registry (it lives in
   * operator-core — D-001/D-004), so the operator passes this on load/projection;
   * omitted → the op-name check is skipped (author-time validation in the lib
   * still catches every structural + expression problem).
   */
  knownOps?: Set<string>;
}

const TERMINAL = new Set(['done', 'escalate', 'idle']);
/** Finalize-recipe entries that are pipeline STEPS, not dispatchable roles. */
const FINALIZE_STEPS = new Set(['archive', 'postCuratorOutputs']);

export function validateBlueprint(bp: Blueprint, opts: ValidateOptions = {}): BlueprintValidation {
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

  if (!Number.isFinite(bp.spine.maxTurns) || bp.spine.maxTurns < 1) {
    err('bad-max-turns', `spine.maxTurns must be a finite positive integer (got ${bp.spine.maxTurns})`);
  }

  // ── spine mode: a spine declares EXACTLY ONE model (D-002) ──────────────────
  const hasEdges = bp.spine.edges != null && Object.keys(bp.spine.edges).length > 0;
  const hasSteps = bp.spine.steps != null && bp.spine.steps.length > 0;
  const dispatched = new Set<string>();
  if (hasEdges && hasSteps) {
    err('spine-mode', 'spine declares BOTH edges (decider model) and steps (program model) — choose one');
  } else if (!hasEdges && !hasSteps) {
    err('empty-spine', 'spine declares neither edges (decider model) nor steps (program model)');
  } else if (hasSteps) {
    validateProgramSpine(bp, opts, err, warn);
  } else {
    validateDeciderSpine(bp, roleIds, dispatched, err, warn);
  }

  // ── reactive overlay: guards well-formed ───────────────────────────────────
  for (const rule of bp.reactive) {
    const w = rule.when;
    const hasCond =
      w.beforeRole != null || w.afterRole != null || w.minAttempts != null || w.cond != null;
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
  // `bp.gates` is schema-prefaulted ({}) for a parsed blueprint, but this fn is
  // also the author-time "secondary net" over RAW (un-parsed) blueprints (see
  // validate-program.test.ts), so guard the defaulted field.
  const finalize = bp.gates?.finalize;
  if (finalize) {
    for (const step of [...finalize.onDone, ...finalize.onEscalate]) {
      if (!FINALIZE_STEPS.has(step) && !roleIds.has(step)) {
        warn('finalize-unknown-role', `gates.finalize references "${step}" which is neither a step nor a declared role`);
      }
    }
  }

  // ── recursion: bounded ─────────────────────────────────────────────────────
  // Defaulted ({}) for a parsed blueprint; guard for the raw-blueprint path.
  const recursion = bp.recursion;
  if (recursion?.enabled) {
    if (!recursion.spawnOn) {
      warn('recursion-no-trigger', 'recursion.enabled but no spawnOn trigger declared — it can never recurse');
    }
    if (!Number.isFinite(recursion.maxDepth) || recursion.maxDepth < 0) {
      err('recursion-unbounded', `recursion.maxDepth must be a finite non-negative integer (got ${recursion.maxDepth})`);
    }
    // A `$param` childBlueprint (D-008 — the gym's `$target`) must be a
    // well-formed placeholder; the binding itself is a spawn-time concern
    // (resolveChildBlueprint), not statically checkable here.
    const child = recursion.childBlueprint;
    if (isChildBlueprintParam(child) && !CHILD_BLUEPRINT_PARAM_RE.test(child as string)) {
      err(
        'recursion-bad-param',
        `recursion.childBlueprint ${JSON.stringify(child)} is not a valid placeholder — expected \`$\` + identifier (e.g. \`$target\`)`,
      );
    }
  }

  // ── reachability: declared-but-unused roles (dead roles) ───────────────────
  // Decider-mode only: program-mode roles (voter / advocate) are spawned by a
  // `spawn-roles` op step, not by a spine edge, so `dispatched` is empty and the
  // dead-role heuristic would wrongly flag every program role.
  if (!hasSteps) {
    for (const id of roleIds) {
      const used =
        id === bp.spine.decider ||
        // A declared decider ALTERNATIVE (e.g. the pot's `queen`) is a live
        // role an install may swap in — not a dead one (local-hive P-030).
        (bp.spine.deciderAlternatives ?? []).includes(id) ||
        dispatched.has(id) ||
        bp.reactive.some((r) => r.role === id) ||
        (finalize ? [...finalize.onDone, ...finalize.onEscalate].includes(id) : false);
      if (!used) {
        warn('unused-role', `role "${id}" is declared but never dispatched, reactive, or in finalize`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

type Reporter = (code: string, message: string) => void;

/** Decider-model spine checks (edges + termination + reachability). */
function validateDeciderSpine(
  bp: Blueprint,
  roleIds: Set<string>,
  dispatched: Set<string>,
  err: Reporter,
  warn: Reporter,
): void {
  const edges = bp.spine.edges ?? {};
  // A terminal must be reachable — via some edge OR the default — else the loop
  // can only ever spin until maxTurns.
  const anyTerminalEdge = Object.values(edges).some((a) => TERMINAL.has(a.to));
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
  for (const [verb, action] of Object.entries(edges)) {
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
}

/**
 * Program-model spine checks (`coordination-ops-as-blueprint-primitives` P-005):
 * unique step ids, parseable `when` expressions, a gate that always resolves (a
 * fallback branch), and — when `knownOps` is supplied — that every op exists.
 */
function validateProgramSpine(
  bp: Blueprint,
  opts: ValidateOptions,
  err: Reporter,
  warn: Reporter,
): void {
  const steps = bp.spine.steps ?? [];
  const gate = bp.spine.gate ?? [];
  const known = opts.knownOps;

  const seenIds = new Set<string>();
  const boundNames = new Set<string>();
  for (const s of steps) {
    if (seenIds.has(s.id)) err('duplicate-step', `program step id "${s.id}" is declared more than once`);
    seenIds.add(s.id);
    if (known && !known.has(s.op)) {
      err('unknown-op', `program step "${s.id}" invokes unknown op "${s.op}"`);
    }
    if (s.when != null && !isValidWhen(s.when)) {
      err('bad-step-when', `program step "${s.id}" has an invalid when (not a DataCondition): ${JSON.stringify(s.when)}`);
    }
    if (s.bind) boundNames.add(s.bind);
  }
  void boundNames; // reserved for a future "gate reads an unbound name" lint

  if (gate.length === 0) {
    err('gate-missing', 'program-mode spine has steps but no gate — a program must resolve through a gate');
    return;
  }
  const hasFallback = gate.some((b) => b.else === true || b.when == null);
  if (!hasFallback) {
    err('gate-no-fallback', 'gate has no fallback branch (else / no-when) — some scopes would never resolve');
  }
  for (let i = 0; i < gate.length; i++) {
    const b = gate[i]!;
    if (known && !known.has(b.op)) err('unknown-op', `gate branch ${i} fires unknown op "${b.op}"`);
    if (b.when != null && !isValidWhen(b.when)) {
      err('bad-gate-when', `gate branch ${i} has an invalid when (not a DataCondition): ${JSON.stringify(b.when)}`);
    }
  }
}
