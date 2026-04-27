/**
 * Prompt-file resolution for `invoke <role>`. Mirrors bash's 5-tier lookup:
 *
 *   1. prompts/$phase/departments/$dept/$role.md   (most specific)
 *   2. prompts/$phase/$role.md
 *   3. prompts/department/$role.md                 (legacy when phase=department)
 *   4. prompts/$role.md                            (default fallback)
 *
 * Returns the first path that exists. Returns null if none of them do.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptResolveContext {
  /** Absolute path to the harness install (containing prompts/). */
  harnessDir: string;
  /** Resolved phase, e.g. "staging" / "department". May be empty. */
  phase: string;
  /** Department slug from .harness/config.json `dept`, or empty. */
  dept: string;
}

/** Build the candidate path list (most specific first). Useful for testing. */
export function promptCandidates(
  ctx: PromptResolveContext,
  role: string,
): string[] {
  const candidates: string[] = [];
  const promptsRoot = join(ctx.harnessDir, 'prompts');

  if (ctx.phase && ctx.dept) {
    candidates.push(
      join(promptsRoot, ctx.phase, 'departments', ctx.dept, `${role}.md`),
    );
  }
  if (ctx.phase) {
    candidates.push(join(promptsRoot, ctx.phase, `${role}.md`));
  }
  if (ctx.phase === 'department') {
    candidates.push(join(promptsRoot, 'department', `${role}.md`));
  }
  candidates.push(join(promptsRoot, `${role}.md`));

  // Dedupe while preserving order.
  return Array.from(new Set(candidates));
}

/**
 * Walk the candidate list, returning the first existing path. Returns null
 * if no candidate exists — caller decides how to surface that to the agent
 * (usually: log a warning and fall back to `prompts/$role.md` as bash does).
 */
export function resolvePromptFile(
  ctx: PromptResolveContext,
  role: string,
): string | null {
  for (const candidate of promptCandidates(ctx, role)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
