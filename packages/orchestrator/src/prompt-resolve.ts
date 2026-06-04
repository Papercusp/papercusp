/**
 * Prompt-file resolution for `invoke <role>`. Mirrors bash's 5-tier lookup:
 *
 *   1. prompts/$phase/departments/$dept/$role.md   (most specific)
 *   2. prompts/$phase/$role.md
 *   3. prompts/department/$role.md                 (legacy when phase=department)
 *   4. prompts/$role.md                            (default fallback)
 *
 * Returns the first path that exists. Returns null if none of them do.
 *
 * Role aliasing: a map of legacy role names → canonical role names.
 * When code (or a user's config.json) references the legacy name, we
 * walk the canonical name's candidates FIRST, then fall through to the
 * legacy name's candidates so user-supplied overrides at the legacy
 * path keep working during the deprecation period.
 *
 * Currently empty — `plan-gate` was retired in favor of `reviewer`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptResolveContext {
  /** Absolute path to the harness install (containing prompts/). */
  harnessDir: string;
  /** Resolved phase, e.g. "staging" / "department". May be empty. */
  phase: string;
  /** Department slug from .papercusp/config.json `dept`, or empty. */
  dept: string;
  /**
   * The program blueprint a spawned role belongs to (e.g. 'vote'), when the
   * invoke is a `coordination-ops-as-blueprint-primitives` program spawn. A
   * program-blueprint role (`voter`/`advocate`) keeps its prompt in the OWNING
   * blueprint's dir — `blueprints/<blueprintId>/prompts/<role>.md` — not the
   * global `prompts/<role>.md`. When set, that path is tried FIRST so a blueprint
   * owns (and a fork can override) its roles' prompts without code. Empty/absent
   * for the normal pipeline (worker/scoper/…), leaving resolution unchanged.
   */
  blueprintId?: string;
}

/**
 * Legacy role name → canonical role name. The codebase consolidated on
 * `reviewer` (run.sh invokes it; identity/reviewer.md exists). The old
 * `plan-gate` prompt was removed in favor of one canonical name.
 *
 * This map exists for future renames; today no aliases are active.
 */
export const ROLE_ALIASES: Record<string, string> = {};

function candidatesFor(ctx: PromptResolveContext, role: string): string[] {
  const candidates: string[] = [];
  const promptsRoot = join(ctx.harnessDir, 'prompts');

  // Program-blueprint roles live in the owning blueprint's prompts dir; try it
  // first so a blueprint (or a user fork of it) owns its roles' prompts (D-006).
  if (ctx.blueprintId) {
    candidates.push(
      join(ctx.harnessDir, 'blueprints', ctx.blueprintId, 'prompts', `${role}.md`),
    );
  }
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
  return candidates;
}

/** Build the candidate path list (most specific first). Useful for testing. */
export function promptCandidates(
  ctx: PromptResolveContext,
  role: string,
): string[] {
  // If the requested role has a canonical alias, walk the canonical name's
  // candidates first, then fall through to the legacy name's candidates.
  const canonical = ROLE_ALIASES[role];
  const all = canonical
    ? [...candidatesFor(ctx, canonical), ...candidatesFor(ctx, role)]
    : candidatesFor(ctx, role);

  // Dedupe while preserving order.
  return Array.from(new Set(all));
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
