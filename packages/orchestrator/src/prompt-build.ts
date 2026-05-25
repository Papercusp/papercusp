/**
 * Prompt assembler. Builds the full text fed to the agent CLI (omp via
 * @file argument, claude via stdin).
 *
 * Bash equivalent: the big `{ cat $prompt_file; … }` block at the end of
 * invoke(). Sections (some conditional):
 *
 *   1. The role's prompt file (always)
 *   2. Per-role override from config.json `promptOverrides.$role` (optional)
 *   3. Curated memory (`<stateDir>/memory/summary.md`) — except for curator
 *   4. Per-role identity (`<harnessDir>/identity/$role.md`) — cross-mission
 *   5. Runtime context — extras + cwd + state dir + run id + memory hint
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface BuildPromptInput {
  role: string;
  /** Path to the resolved prompt file (e.g. prompts/staging/worker.md).
   *  Empty string when `inlinePrompt` is supplied — the inline string
   *  replaces what would otherwise come from the file. */
  promptFile: string;
  /** Inline prompt body. When non-empty, used instead of `promptFile`'s
   *  contents — for ad-hoc invocations like the chunk-loop driver
   *  that build the prompt programmatically. */
  inlinePrompt?: string;
  /** Per-role specialization (config.json → promptOverrides.<role>). May be empty. */
  promptOverride: string;
  /** Path to <stateDir>. Used to read memory/summary.md and to print "State directory" hint. */
  stateDir: string;
  /** Path to <harnessDir>. Used to read identity/<role>.md when no
   *  pre-fetched identity is supplied. */
  harnessDir: string;
  /** Pre-fetched cross-mission identity for this role (PG mirror,
   *  Migration 041). When non-empty, used instead of the file read at
   *  `<harnessDir>/identity/<role>.md`. The caller (invoke.ts) loads
   *  it from `harness_shared.identity_files` when `ctx.pg` is set;
   *  empty string falls through to the file path. */
  identity?: string;
  /** Path to the project root. Printed in runtime context. */
  projectDir: string;
  /** Worktree cwd if branch-iso is on AND a feature_id is set. Empty string disables. */
  cwdOverride: string;
  /** Feature ID if extracted (used in cwd override hint). */
  featureId: string | null;
  /** Run ID — printed in runtime context. */
  runId: string;
  /** Extra context lines (e.g. `["MODE=initial"]`, `["FEATURE_ID=F-001"]`). */
  extras: readonly string[];
  /**
   * Pre-fetched substrate-context block (Tier 1 preamble + Tier 2 neighbor
   * view + Tier 3 capabilities + bounded supervisor-inbox). Computed by
   * the caller (invoke.ts) via fetchSubstrateContext() and passed in.
   * Empty string disables — the prompt still works without it.
   */
  substrateContext?: string;
  /**
   * Pre-fetched feature-history block (notes + debugger findings +
   * recent audit transitions). Computed by the caller via
   * `fetchFeatureHistory()` only when a feature ID is in scope.
   *
   * Cache discipline: this content changes per (feature, turn) and is
   * appended at the END of the assembled prompt — after runtime context
   * — so it never invalidates the cacheable preamble (role + override +
   * memory + identity). Empty string disables.
   */
  featureHistory?: string;
  /**
   * Plan context for a plan-derived feature: the origin plan's `## Now`
   * block + last 3 decisions. Fetched by the caller from the operator
   * endpoint `/api/harness/:slug/features/:id/plan-context` so the
   * orchestrator submodule stays free of operator-layer PG imports.
   *
   * Only injected for worker / validator / reviewer roles. Placed before
   * `featureHistory` so it is in-scope for the agent's main task but
   * still after the cacheable preamble.
   *
   * Empty string / undefined disables.
   */
  planContext?: string;
  /**
   * Cross-tool playbook for the role — content of
   * `apps/operator/prompts/<role>.tools.md` if it exists. Captures
   * named workflows + cross-tool patterns + chaining rules that span
   * multiple tools and can't live in any single tool's `guidance`.
   *
   * Caller resolves the path (so this module stays operator-app-agnostic)
   * and passes the file contents. Empty string disables — the role
   * just doesn't get the playbook section.
   *
   * Inserted AFTER the role prompt (section 1) and BEFORE memory /
   * identity (sections 3+) so role-specific instructions can refer
   * back to playbook patterns ("when chaining, see the playbook").
   */
  toolsPlaybook?: string;
  /**
   * Optional shared cross-role guidance pages (e.g. finding-context.mdx).
   * Authored in apps/operator-docs/src/content/docs/agents/ so humans + agents
   * share one source. Loaded + injected by the caller; rendered after
   * toolsPlaybook as section 2c.
   */
  sharedGuides?: string[];
}

function fileContents(path: string): string {
  try {
    if (!existsSync(path)) return '';
    if (statSync(path).size === 0) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function buildPrompt(input: BuildPromptInput): string {
  const out: string[] = [];

  // 0. Substrate context (Tier 1 + Tier 2 + Tier 3 + bounded inbox).
  // Goes BEFORE the role prompt so role-specific instructions can refer
  // back to "the parent harness above" / "the available templates above".
  if (input.substrateContext && input.substrateContext.trim()) {
    out.push(input.substrateContext);
    out.push('\n---\n');
  }

  // 1. Role prompt file (always — caller asserts it exists), unless
  //    the caller supplied an inline prompt (chunk-loop driver, etc.).
  if (input.inlinePrompt && input.inlinePrompt.length > 0) {
    out.push(input.inlinePrompt);
  } else {
    out.push(fileContents(input.promptFile));
  }

  // 2. Per-role specialization override.
  if (input.promptOverride) {
    out.push('\n---');
    out.push(`## Droid specialization (from .harness/config.json → promptOverrides.${input.role})\n`);
    out.push(input.promptOverride);
  }

  // 2b. Tools playbook (cross-tool patterns + named workflows).
  //     Loaded from apps/operator/prompts/<role>.tools.md by the caller.
  //     Inserted after the role prompt + specialization so role-specific
  //     instructions can refer to the playbook patterns.
  if (input.toolsPlaybook && input.toolsPlaybook.trim()) {
    out.push('\n---');
    out.push(input.toolsPlaybook);
  }

  // 2c. Shared cross-role guidance (finding-context.mdx, etc.).
  //      Authored in the public docs site under
  //      apps/operator-docs/src/content/docs/agents/ and injected by the
  //      caller so the doc page and the prompt content share one source.
  for (const guide of input.sharedGuides ?? []) {
    if (guide && guide.trim()) {
      out.push('\n---');
      out.push(guide);
    }
  }

  // 3. Curated memory — every role except curator.
  if (input.role !== 'curator') {
    const mem = fileContents(`${input.stateDir}/memory/summary.md`);
    if (mem) {
      out.push('\n---');
      out.push('## Memory (curated from prior iterations of this run)\n');
      out.push(mem);
    }
  }

  // 4. Per-role identity (cross-mission). PG-canonical via Migration
  // 041 when caller passed `input.identity`; otherwise fall back to
  // the on-disk file (legacy / no-PG path).
  const identity = (input.identity && input.identity.length > 0)
    ? input.identity
    : fileContents(`${input.harnessDir}/identity/${input.role}.md`);
  if (identity) {
    out.push('\n---');
    out.push(`## Your identity (cross-mission memory for the ${input.role} role)\n`);
    out.push(identity);
  }

  // 5. Runtime context.
  out.push('\n---');
  out.push('## Runtime context\n');
  for (const e of input.extras) {
    out.push(`- ${e}`);
  }
  if (input.cwdOverride) {
    out.push(`- Working directory: ${input.cwdOverride} (worktree for ${input.featureId})`);
    out.push(`- Project root: ${input.projectDir} (reference only — you edit the worktree)`);
  } else {
    out.push(`- Working directory: ${input.projectDir}`);
  }
  out.push(`- State directory: ${input.stateDir} (all coordination files live here; shared across worktrees if any)`);
  out.push(`- Run ID: ${input.runId}`);
  if (input.role !== 'curator') {
    out.push('- **Memory discipline:** at the end of your work, if you learned something');
    out.push('  actionable for future iterations (a technique that works, a library that');
    out.push('  doesn\'t, an invariant that tripped you up), append ONE line to');
    out.push('  `.harness/memory/raw.md` in the format:');
    out.push(`  \`[<ISO-8601-timestamp>] ${input.role} <feature_id-or-dash>: <one-line observation>\``);
    out.push('  Do not dump logs. Do not duplicate existing lines. Skip silently if you');
    out.push('  have nothing generalizable to add.');
  }

  // 6. Plan context — origin plan's ## Now + last 3 decisions for
  //    plan-derived features. More static than featureHistory so placed
  //    before it; still after the cacheable preamble.
  if (input.planContext && input.planContext.trim()) {
    out.push('\n---');
    out.push(input.planContext);
  }

  // 7. Feature history — APPENDED LAST so it never invalidates the
  //    cacheable preamble. Per-feature, per-turn content; expected to
  //    differ across calls. See feature-history.ts and the "cache
  //    discipline" comment on `featureHistory` in BuildPromptInput.
  if (input.featureHistory && input.featureHistory.trim()) {
    out.push('\n---');
    out.push(input.featureHistory);
  }

  return out.join('\n');
}
