/**
 * Harness Blueprint — the Zod schema (validator-of-record).
 *
 * `harness-blueprint-orchestration-2026-06-03` P-001 / D-001 / D-008.
 *
 * A Blueprint is the entire declarative shape of a harness: its work-item type,
 * role set, orchestration spine, planner, reactive overlay, gates, recursion,
 * gym rubric, and knobs. It is **agent-authorable** (validated `blueprint:*`
 * tools), **inheritable** (`extends`), and **versioned** (git-canonical
 * `.papercusp/blueprint.yaml`, projected to PG — D-006/D-021).
 *
 * This module defines the **resolved** schema — the shape a fully-merged
 * blueprint must satisfy. Inheritance is resolved by deep-merging the raw
 * on-disk objects (child over parent) BEFORE a single `BlueprintSchema.parse`,
 * so `.default()`s apply exactly once on the merged result and an absent child
 * field correctly inherits the parent's value (a default applied per-file would
 * clobber inheritance). The loader (P-002) does the merge; this file is the
 * contract both it and the authoring tools (P-007) validate against.
 *
 * Relationship to `HarnessConfig` (`types.ts`): the blueprint is a superset of
 * HarnessConfig's **shape/knob** fields only (see `knobs` below). Per-install
 * **instance** fields — `phase`, `phases` (port/dbPath), `dept` — stay in
 * `.papercusp/config.json`; they describe *this* install, not the harness shape.
 */
import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';

/**
 * The work unit the director schedules/executes. Maps onto the canonical
 * `work_items(kind, payload)` table (D-013). `kind` is the discriminator
 * (`feature` for coding, `research-task` for research); `idPrefix` shapes the
 * human id (`F` → `F-001`). `payload` is a loose authoring/doc descriptor — the
 * authoritative per-kind payload validation lives in code, not here.
 */
export const WorkItemSchema = z.object({
  kind: z.string().min(1),
  idPrefix: z.string().default('W'),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A role in the blueprint. `id` resolves a prompt via the tiered `prompt-resolve`
 * lookup (`prompts/<id>.md` by default; `prompt` overrides with an explicit path
 * relative to the blueprint dir). `tools`/`capabilities` are generous hints the
 * distribution plan's import-time dep-manifest (su-4b6ce E2, distribution
 * P-003/P-004) resolves against the catalog + Cupboard. `reactive: true` marks a
 * role that belongs to the condition-triggered overlay, not the spine.
 *
 * `isolation` declares the filesystem-isolation a dispatch of this role wants —
 * `worktree` runs it in its own git worktree so parallel dispatches of the same
 * role (e.g. `migration`'s per-site transformer) don't collide, mirroring the
 * Agent/Workflow layer's `isolation: 'worktree'`. It is the role-level
 * *declaration*; honoring it at dispatch time is the orchestrator's job, and
 * parallel dispatch of an isolated role is gated on the same fan-out capability
 * the decider spine doesn't yet have (today the engine dispatches sequentially —
 * the declaration is correct + validated, the parallel honoring is a follow-up).
 * `none` (the default on omit) keeps a role in the shared tree (existing behavior).
 */
export const BlueprintRoleSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  reactive: z.boolean().default(false),
  isolation: z.enum(['none', 'worktree']).optional(),
  description: z.string().optional(),
});

/**
 * A spine edge's action — what happens when the decider emits a given verb.
 * This is the data form of `classifyDecision`'s switch arms (`PipelineAction`):
 *
 *   - `done` / `escalate` / `idle` → terminal (finalize / stop).
 *   - `role` → dispatch a role and loop. `extras` are templated with `{feature}`
 *     and `{arg}` (e.g. `FEATURE_ID={feature}`, `VAL_ID={arg}`). `rejectWhenParallel`
 *     turns an `N=k` (parallel-lane) decision into `unsupported` for this verb —
 *     parallel lanes are the global orchestrator's job, not the per-feature
 *     pipeline's (D-001); today only `NEXT_WORKER` sets it.
 *   - `unsupported` → warn + stop (a global-only verb the per-feature pipeline
 *     deliberately does not run).
 */
export const SpineActionSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('done') }),
  z.object({
    to: z.literal('escalate'),
    /** Static reason, or pull it from the decision arg with `reasonFrom: 'arg'`. */
    reason: z.string().optional(),
    reasonFrom: z.enum(['arg']).optional(),
  }),
  z.object({ to: z.literal('idle') }),
  z.object({
    to: z.literal('role'),
    role: z.string().min(1),
    extras: z.array(z.string()).default([]),
    rejectWhenParallel: z.boolean().default(false),
  }),
  z.object({ to: z.literal('unsupported') }),
]);

/**
 * A coord-op spine **step** — the first-class declarative composition unit of the
 * coordination-ops layer (`coordination-ops-as-blueprint-primitives-2026-06-04`
 * D-002/D-003/D-005). A step invokes a coord op (`coord:thread-open`,
 * `coord:collect`, `vote:aggregate`, …) with `{{ path }}`-templated `args`, binds
 * the op's result into the spine scope under `bind`, and may be guarded by a
 * `when` boolean expression over the bound scope. The ops are the `what`; the
 * spine `steps` are `how` (D-002 — the four-layer stack). Result-binding +
 * conditions are the load-bearing new infra the executor (P-005) runs durably.
 */
export const CoordOpStepSchema = z.object({
  /** Human/debug id, also the DBOS step name (`op-<id>`). Unique within a spine. */
  id: z.string().min(1),
  /** The coord-op to invoke — a name in the coord-op registry (D-001/D-004). */
  op: z.string().min(1),
  /** Op args, `{{ path }}`-interpolated against the bound scope before invoke. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Scope key to bind the op's result under (later steps + the gate read it). */
  bind: z.string().optional(),
  /**
   * Optional condition over the scope — skip the step when false. The canonical
   * `@papercusp/rules` `MatchMap`/`DataCondition` (adopt-event-rules-engines
   * D-002): dot-path → operator-test (`{ "asked.answered": { truthy: false } }`),
   * with `all`/`any`/`not` combinators. Evaluated by `evaluateDataCondition`
   * (injected as the spine's `WhenEval`) — one condition language across the
   * event-reaction rules, the gate, and these steps.
   */
  when: dataConditionSchema.optional(),
});

/**
 * A spine **gate** branch — the conditional decision after the steps run (the
 * `resolve` / `escalate` fork of the vote worked example, D-006). The first
 * branch whose `when` is true fires its `op` (with interpolated `args`); a branch
 * with `else: true` (or no `when`) is the fallback. A well-formed program gate
 * MUST have a fallback so it always resolves (validated — P-005).
 */
export const GateBranchSchema = z.object({
  /** Condition over the scope (the canonical `@papercusp/rules` `DataCondition` —
   *  see {@link CoordOpStepSchema} `when`); omit (or set `else`) for the fallback. */
  when: dataConditionSchema.optional(),
  /** Marks the fallback branch (sugar; an omitted `when` is equivalent). */
  else: z.boolean().default(false),
  /** The coord-op this branch fires (e.g. `resolve`, `coord:escalate`). */
  op: z.string().min(1),
  /** Op args, `{{ path }}`-interpolated against the bound scope. */
  args: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The orchestration spine. Two coexisting, additive models (D-002):
 *
 *  - **decider model** (`edges` + `default`) — a flat declared graph (D-024): the
 *    `decider` role emits a verb each turn; `deriveNext` looks it up in `edges`,
 *    falling back to `default`. The behavior-preserving lift of the legacy
 *    director loop + `classifyDecision` switch (coding/research/gym).
 *  - **coord-op program** (`steps` + `gate`) — an ordered list of coord-op steps
 *    with result-binding + conditions, then a decision gate (vote/deliberate,
 *    D-006). No decider: the program IS the orchestration. Run by the durable
 *    `coordProgramWorkflow` (P-005).
 *
 * A spine declares EXACTLY ONE model (validated — `spine-mode` in validate.ts). A
 * blueprint may mix both across composition (a `deliberate` program step invokes
 * a `coord:vote` op which runs the `vote` program) — recursion bounded by the
 * depth cap (D-008). `edges` is optional so a program-mode spine omits it.
 */
export const SpineSchema = z.object({
  decider: z.string().min(1).default('director'),
  /** Hard iteration cap (was `MAX_TURNS`; promoted to a blueprint field — P-004). */
  maxTurns: z.number().int().positive().default(200),
  /** verb → action (decider model). Keys are the blueprint's verb vocabulary. */
  edges: z.record(z.string(), SpineActionSchema).optional(),
  /** Action for a null/unparseable decision or an unmapped verb (decider model). */
  default: SpineActionSchema.default({ to: 'idle' }),
  /** Ordered coord-op steps (program model — D-002). */
  steps: z.array(CoordOpStepSchema).optional(),
  /** The decision gate fired after the steps (program model — D-006). */
  gate: z.array(GateBranchSchema).optional(),
});

/**
 * The planner that generates the Level-2 runtime task DAG (the per-goal plan).
 * `features-import` = the existing plans→features import (coding's Level-2 DAG —
 * waves + blocked_by parallelism). `inline` = the decider plans within its own
 * loop (research default — D-016). `none` = no separate planner.
 */
export const PlannerSchema = z.object({
  kind: z.enum(['features-import', 'inline', 'none']).default('none'),
  config: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A reactive-overlay rule (layer 3 — 3T/blackboard): a condition-triggered role
 * that can preempt the spine. v1 covers coding's debugger-before-worker gate
 * (`beforeRole: 'worker'`, `minAttempts: <threshold>`, `unless: 'debug-note'`).
 * `cond` is the escape hatch for conditions the structured fields can't
 * express — the canonical `@papercusp/rules` `DataCondition` (the same `when`
 * language as the coord-op steps + gate branches; adopt-event-rules-engines
 * D-002), evaluated over the dispatch scope by `evaluateDataCondition`. It
 * replaces the retired `custom: string` named-host-predicate hatch (a second,
 * non-serializable condition language with zero authors and zero consumers).
 */
export const ReactiveRuleSchema = z.object({
  role: z.string().min(1),
  when: z.object({
    beforeRole: z.string().optional(),
    afterRole: z.string().optional(),
    minAttempts: z.number().int().nonnegative().optional(),
    unless: z.string().optional(),
    cond: dataConditionSchema.optional(),
  }),
  /** true → can interrupt the spine (3T reactive preemption); false → advisory. */
  preempt: z.boolean().default(false),
});

/**
 * Gates: the finalize-recipe (what runs on a terminal outcome — promoted from a
 * hardcoded constant, P-004) plus named human-approval gates.
 */
export const GatesSchema = z.object({
  finalize: z
    .object({
      /** Roles/steps run on `done` — e.g. `['curator','documenter','archive']`. */
      onDone: z.array(z.string()).default([]),
      /** Roles/steps run on `escalate` — e.g. `['curator']`. */
      onEscalate: z.array(z.string()).default([]),
    })
    .optional(),
  approvals: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.string().optional(),
        blocking: z.boolean().default(true),
      }),
    )
    .default([]),
});

/**
 * Harness-boundary recursion (layer 4 — Erlang/OTP supervision): a role spawns a
 * durable sub-harness with a declared restart/escalation strategy. Off for
 * coding (per-feature pipelines don't recurse); on for research overflow (spawn
 * a sub-research-harness) and monorepo sub-projects (D-016/D-023). Recursion is
 * at the *harness* boundary — preserving durability, gates, and observability.
 */
export const RecursionSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Blueprint a spawned child uses. Three forms (D-008):
   *   - omitted      → self;
   *   - a literal id → that blueprint;
   *   - `$param`     → a PARAMETERIZED child bound at spawn time via
   *                    `resolveChildBlueprint(bp, { <param>: id })` — the gym
   *                    declares `$target` and binds the blueprint-under-
   *                    optimization (the former undeclared runtime override).
   */
  childBlueprint: z.string().optional(),
  spawnOn: z
    .object({
      role: z.string().optional(),
      verb: z.string().optional(),
      custom: z.string().optional(),
    })
    .optional(),
  strategy: z.enum(['one-for-one', 'rest-for-one', 'escalate']).default('escalate'),
  maxDepth: z.number().int().nonnegative().default(1),
});

/**
 * The judge rubric a gym run scores against. Structurally mirrors the gym's
 * `GymJudgeRubric` (`apps/operator/lib/gym/judge-scoring.ts`) without importing
 * it (that lives in the operator; this is a lib). The operator's gym maps this
 * onto its concrete rubric type.
 */
export const GymRubricSchema = z.object({
  version: z.string().default('v1'),
  model: z.string().optional(),
  temperature: z.number().optional(),
  thinkingBudgetTokens: z.number().int().optional(),
  weights: z.record(z.string(), z.number()).optional(),
  dimensions: z.record(z.string(), z.string()).optional(),
});

/**
 * Per-blueprint gym configuration (the self-improving layer). `collectTrace` is
 * the fifth seam (D-015) that breaks the gym's repo-coupling: `git-diff` for
 * coding (diff over the substrate clone), `work-item-output` for research
 * (work-item output + transcript), or a named custom collector. `signals` are
 * deterministic, un-gameable guardrails resolved by name host-side
 * (`regressionsFromTests`, `plantedBugCaught`). The *target* blueprint declares
 * this; the `gym` blueprint reads it (D-022).
 */
export const GymSchema = z.object({
  collectTrace: z.union([z.enum(['git-diff', 'work-item-output']), z.string()]).default('work-item-output'),
  signals: z.array(z.string()).default([]),
  rubric: GymRubricSchema.optional(),
});

/** Per-role / default AI-backend invocation knob (mirrors HarnessConfig's
 *  `AiBackendRoleConfig`). `.passthrough` so non-secret extras survive. */
const AiBackendRoleKnobSchema = z.object({
  agentCmd: z.string().optional(),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Knobs — the shape/knob subset of `HarnessConfig` that becomes part of the
 * harness *shape* (vs the per-install instance fields that stay in config.json).
 * `.catchall(unknown)` keeps forward-unknown knobs rather than stripping them.
 */
export const KnobsSchema = z
  .object({
    harnessKind: z.string().optional(),
    maxCostUsd: z.number().optional(),
    logRetention: z.number().int().optional(),
    branchIsolation: z.object({ enabled: z.boolean().optional(), baseBranch: z.string().optional() }).optional(),
    worktrees: z.object({ enabled: z.boolean().optional() }).optional(),
    reviewer: z.object({ replanOnAccept: z.boolean().optional() }).optional(),
    product: z
      .object({
        enabled: z.boolean().optional(),
        triggerOnNearDone: z.boolean().optional(),
        nearDoneThreshold: z.number().optional(),
        mode: z.enum(['auto-apply', 'propose-only']).optional(),
        replanOnAccept: z.boolean().optional(),
      })
      .optional(),
    /** Promotion-gate SHAPE knobs (`deprecate-harness-config-json-2026-06-06` —
     *  the last config.json knob without a declared home). `<from>_to_<to>` edge
     *  keys carry per-edge `criteria` overrides; `smokeBuild.enabled` opts into the
     *  pre-handoff smoke build. `.loose` because the edge keys are dynamic. Per-install
     *  overrides live in PG `configOverrides`, not the blueprint. */
    promotion: z
      .looseObject({
        smokeBuild: z.looseObject({ enabled: z.boolean().optional() }).optional(),
      })
      .optional(),
    models: z.record(z.string(), z.string()).optional(),
    /** debugger-before-worker gate threshold (attempts ≥ n fires the gate). */
    debuggerThreshold: z.number().int().nonnegative().optional(),
    /** The repo's verified test command (P-009 generate-from-repo detects + runs it once;
     *  consumed by the worker/validator gate + the gym signals). */
    testCommand: z.string().optional(),
    /** UI-QA opt-in for frontend repos (P-009 sets this when a frontend is detected). */
    uiQa: z.object({ enabled: z.boolean().optional() }).optional(),
    /** Does instantiating this blueprint require a git repo? (P-008; coding=true, research=false.) */
    requiresRepo: z.boolean().default(true),
    // ── Residual config.json → knobs migration (cloud-deployment-layer P-006) ──
    // These five had no declared blueprint home; they now do. config.json keeps
    // instance-override precedence (resolved by readEffectiveConfig's overlay).
    /** Per-role prompt specialization (config `promptOverrides.<role>` = a full
     *  replacement / specialization string for that role's prompt). */
    promptOverrides: z.record(z.string(), z.string()).optional(),
    /** Per-harness AI backend: a `default` invocation + per-role overrides
     *  (agentCmd / model / extraArgs). Secrets never go here — see HarnessConfig. */
    aiBackend: z
      .object({
        default: AiBackendRoleKnobSchema.optional(),
        roles: z.record(z.string(), AiBackendRoleKnobSchema).optional(),
      })
      .optional(),
    /** Worker-lane config WITHIN a feature (distinct from `dispatch.concurrency`,
     *  which is cross-feature pipeline concurrency). `.loose` so adaptive/mode/
     *  workersPerFeature/escalateToRole/replanStrikes/workingStateCheck survive. */
    parallelWorkers: z
      .looseObject({
        max: z.number().int().positive().optional(),
        maxFeaturesInFlight: z.number().int().positive().optional(),
        synthesizeSingle: z.boolean().optional(),
        useChunkLoop: z.boolean().optional(),
        mode: z.string().optional(),
      })
      .optional(),
    /** Scoper SHAPE knobs (`outputMode` proposal|plan, `backend`). `.loose` so any
     *  transient scoper run-state keys still parse (those move to PG under P-008). */
    scoper: z
      .looseObject({
        outputMode: z.enum(['proposal', 'plan']).optional(),
        backend: z.string().optional(),
      })
      .optional(),
    /** How many snapshot dirs to keep before pruning (read-site default 50). */
    snapshotRetention: z.number().int().nonnegative().optional(),
  })
  .catchall(z.unknown());

/**
 * Scheduler defaults the blueprint declares; `harness:create` materializes them
 * into `harness_shared.routines` (D-018). The routine's target is the
 * `system:blueprint-run` action — NOT a `pending_events` consumer (that hop is
 * retired). Runtime-editable after creation (pause/retime via upsert).
 */
export const TriggersSchema = z.object({
  schedule: z
    .array(
      z.object({
        cron: z.string().min(1),
        action: z.string().default('system:blueprint-run'),
      }),
    )
    .default([]),
  /**
   * The event key that fires this blueprint as a coord-op program
   * (`coordination-ops-as-blueprint-primitives-2026-06-04` D-007). An
   * [[event-reaction-system-2026-06-04]] rule matching this key invokes the
   * program (`startCoordProgram`); the blueprint is ALSO directly invocable as a
   * tool (D-009, e.g. `coord:vote`). Declared here as the firing seam — the
   * event-reaction system (a separate plan) is the matcher that consumes it.
   */
  event: z.string().optional(),
});

/**
 * The autoloop **dispatch policy** — `autoloop-pot-operator-rebuild-2026-06-05`
 * D-005 (P-005/P-006): the last "lift hardcoded → declarative" for the autoloop.
 * Roles/spine/triggers/gates were already declared; the dispatch policy
 * (readiness + priority + concurrency + cost cap + safety ceiling — the
 * `computeFrontier` gates in `operator-core/lib/dbos/orchestrator-loop.ts`) was
 * hardcoded. This section declares it per blueprint, so `coding` runs 4 feature
 * pipelines at once while `research` runs 1 — per-harness-type autoloop
 * behaviors, all declared.
 *
 * OPTIONAL on a blueprint: launch/program blueprints (pot, vote, deliberate, …)
 * have no work-item autoloop and declare none — the orchestrator then keeps the
 * legacy config-only resolution. Resolution order at dispatch time: the
 * per-install `.papercusp/config.json` (`parallelWorkers.*`, `maxCostUsd`)
 * overrides the blueprint's declared policy (instance refines shape); the
 * blueprint fills where config is silent; and the orchestrator's imperative
 * `SAFETY_CEILING` clamps everything (D-007: safety gates stay deterministic
 * code — a blueprint can tighten the ceiling, never raise it).
 */
export const DispatchSchema = z.object({
  /** Max concurrent pipelines (work items in flight) for harnesses of this
   *  shape. Filled when the per-install `parallelWorkers` config is silent. */
  concurrency: z.number().int().positive().optional(),
  /** Candidate ordering. `plan-order` = strict plan priority (lower first,
   *  no-plan last), within a plan by (feature_order ASC NULLS LAST, id) — the
   *  greedy fill `computeFrontier` implements. The only mode today; a new mode
   *  lands WITH its frontier implementation, never as a dangling enum value. */
  priority: z.enum(['plan-order']).default('plan-order'),
  /** Work-item statuses eligible for dispatch. Default = the legacy needs-work
   *  set (`pending`/`failed` are FeatureRecord aliases kept for safety). */
  readiness: z.array(z.string().min(1)).nonempty().default(['todo', 'failing', 'pending', 'failed']),
  /** Autoloop spend ceiling (USD) — over it, no new pipelines start. The
   *  per-install `maxCostUsd` config overrides when set. */
  costCapUsd: z.number().positive().optional(),
  /** Declared concurrency ceiling — clamps the resolved cap for this shape.
   *  The orchestrator's hard imperative SAFETY_CEILING still applies on top
   *  (D-007): tighten-only, never a raise. */
  safetyCeiling: z.number().int().positive().optional(),
});

/**
 * Tool/pack/plugin dependencies the blueprint's roles need. The distribution
 * plan's import-time validation (su-4b6ce distribution P-003/P-004) resolves
 * these against the catalog + Cupboard listings and fails upfront with
 * "needs plugin X", closing the call-time-only `unknown_tool` gap.
 *
 * Deps are declared on TOOLS (capabilities) and resolved to their providing
 * pack/plugin/built-in; `packs` is a convenience for a whole curated
 * capability set (a plugin is a runtime-bearing pack, so a `packs` entry
 * resolves against plugins too). `tool-distribution-granularity-2026-06-05`
 * D-001/D-002.
 */
export const DependenciesSchema = z.object({
  tools: z.array(z.string()).default([]),
  packs: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
});

/** A long-running background service the harness's environment needs (a dev
 *  server, a DB, a cache). The deployment driver starts these on the frame and
 *  (optionally) waits for `healthcheck` before marking the frame ready. */
export const EnvServiceSchema = z.object({
  /** Stable service name (for logs / health reporting). */
  name: z.string().min(1),
  /** The command that starts the service (run + supervised on the frame). */
  command: z.string().min(1),
  /** Port the service listens on, if any (also implies it in `ports`). */
  port: z.number().int().positive().optional(),
  /** A command or URL the driver probes to confirm the service is up. */
  healthcheck: z.string().optional(),
});

/**
 * The harness's build/run **environment spec** (`cloud-deployment-layer-2026-06-06`
 * P-007) — the declarative "what to stand up on a frame". The deployment driver's
 * `install()` (P-010) runs `setup`→`install`→`build`, the validator/gym run
 * `test`, and `run` + `services` are the long-lived processes; `ports` are
 * exposed and `env` (NON-SECRET vars only — secrets ride `credentialRef`) is set.
 * First-class on the blueprint (alongside `dispatch`/`gates`) so the SHAPE is
 * placement-agnostic and identical local vs cloud; per-repo commands can be
 * detected (harness:generate-from-repo) and refined per instance. Empty arrays
 * (the default) ⇒ nothing to stand up — today's local-only behavior.
 */
export const EnvironmentSpecSchema = z.object({
  /** One-time machine setup (apt/toolchain installs) run once per frame. */
  setup: z.array(z.string()).default([]),
  /** Dependency install (e.g. `npm ci`). */
  install: z.array(z.string()).default([]),
  /** Build commands (e.g. `npm run build`). */
  build: z.array(z.string()).default([]),
  /** Test command(s) the validator/gym run. */
  test: z.array(z.string()).default([]),
  /** Long-running app/dev-server start commands. */
  run: z.array(z.string()).default([]),
  /** Background services (DB / cache / dev servers) supervised on the frame. */
  services: z.array(EnvServiceSchema).default([]),
  /** Ports the frame must expose. */
  ports: z.array(z.number().int().positive()).default([]),
  /** NON-SECRET env vars to set on the frame (secrets ride `credentialRef`). */
  env: z.record(z.string(), z.string()).default({}),
});

/**
 * The resolved Blueprint — the validator-of-record. A fully-merged blueprint
 * (after `extends` resolution) must satisfy this.
 */
export const BlueprintSchema = z.object({
  id: z.string().min(1),
  /** Parent blueprint id(s); resolved local → installed → built-in. */
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * The privileged-blueprint discriminator (swarm-coordination D-018 / local-hive
   * D-009). `'harness'` (the default — every existing blueprint, no field needed)
   * is a general harness: a pipeline/research/gym/launch blueprint that recurses
   * freely (a bee spins one up for structured work). `'hive'` is the privileged
   * Queen blueprint (the `pot`): launchable ONLY as a ROOT, never with a parent —
   * hives are flat PEERS, never nested (the no-nest guard, `assertNotNestedHive`,
   * enforces this in code so a stray child-hive launch can't break the flat-peer
   * budget-federation invariant). Additive + optional-with-default, so every
   * pre-existing blueprint parses unchanged as a `'harness'`.
   */
  kind: z.enum(['hive', 'harness']).default('harness'),
  version: z.string().default('0.1.0'),
  description: z.string().optional(),
  workItem: WorkItemSchema,
  roles: z.array(BlueprintRoleSchema).default([]),
  spine: SpineSchema,
  // `.prefault({})` (not `.default`) so an absent field is parsed THROUGH the
  // sub-schema — filling its inner defaults fully and idempotently. A plain
  // `.default({})` short-circuits and would leave inner defaults unfilled until
  // a second parse (breaking validator-of-record round-tripping).
  planner: PlannerSchema.prefault({}),
  reactive: z.array(ReactiveRuleSchema).default([]),
  gates: GatesSchema.prefault({}),
  recursion: RecursionSchema.prefault({}),
  gym: GymSchema.optional(),
  knobs: KnobsSchema.prefault({}),
  triggers: TriggersSchema.optional(),
  /** The autoloop dispatch policy (D-005). Optional: launch/program blueprints
   *  declare none and the orchestrator keeps its legacy config-only resolution. */
  dispatch: DispatchSchema.optional(),
  dependencies: DependenciesSchema.optional(),
  /** The build/run environment spec — "what to stand up on a frame" (P-007). The
   *  deployment driver reads it to bootstrap a cloud frame; absent ⇒ nothing to
   *  stand up (today's local-only behavior). */
  environment: EnvironmentSpecSchema.optional(),
});

/**
 * The on-disk header — just enough to read `id` + `extends` from a raw file
 * before the inheritance merge (the merge happens on the raw plain objects; the
 * merged result is then parsed through `BlueprintSchema`). `.loose()` keeps
 * every other field so the loader can hand the whole object to the merge.
 */
export const BlueprintHeaderSchema = z.looseObject({
  id: z.string().min(1),
  extends: z.union([z.string(), z.array(z.string())]).optional(),
});

export type Blueprint = z.infer<typeof BlueprintSchema>;
/** The privileged-blueprint kind (`'hive' | 'harness'`, default `'harness'`). */
export type BlueprintKind = z.infer<typeof BlueprintSchema.shape.kind>;
export type BlueprintSpine = z.infer<typeof SpineSchema>;
export type SpineAction = z.infer<typeof SpineActionSchema>;
export type CoordOpStep = z.infer<typeof CoordOpStepSchema>;
export type GateBranch = z.infer<typeof GateBranchSchema>;
export type BlueprintRole = z.infer<typeof BlueprintRoleSchema>;
export type BlueprintWorkItem = z.infer<typeof WorkItemSchema>;
export type BlueprintReactiveRule = z.infer<typeof ReactiveRuleSchema>;
export type BlueprintGates = z.infer<typeof GatesSchema>;
export type BlueprintRecursion = z.infer<typeof RecursionSchema>;
export type BlueprintGym = z.infer<typeof GymSchema>;
export type BlueprintKnobs = z.infer<typeof KnobsSchema>;
export type BlueprintTriggers = z.infer<typeof TriggersSchema>;
export type BlueprintDispatch = z.infer<typeof DispatchSchema>;
export type BlueprintEnvironment = z.infer<typeof EnvironmentSpecSchema>;
export type BlueprintEnvService = z.infer<typeof EnvServiceSchema>;
export type BlueprintHeader = z.infer<typeof BlueprintHeaderSchema>;
