/**
 * Prompt assembler. Builds the full text fed to `claude -p` stdin.
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
  /** Path to the resolved prompt file (e.g. prompts/staging/worker.md). */
  promptFile: string;
  /** Per-role specialization (config.json → promptOverrides.<role>). May be empty. */
  promptOverride: string;
  /** Path to <stateDir>. Used to read memory/summary.md and to print "State directory" hint. */
  stateDir: string;
  /** Path to <harnessDir>. Used to read identity/<role>.md. */
  harnessDir: string;
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

  // 1. Role prompt file (always — caller asserts it exists).
  out.push(fileContents(input.promptFile));

  // 2. Per-role specialization override.
  if (input.promptOverride) {
    out.push('\n---');
    out.push(`## Droid specialization (from .harness/config.json → promptOverrides.${input.role})\n`);
    out.push(input.promptOverride);
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

  // 4. Per-role identity (cross-mission).
  const identity = fileContents(`${input.harnessDir}/identity/${input.role}.md`);
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

  return out.join('\n');
}
