/**
 * Prompt-file resolution for `invoke <role>`.
 *
 * blueprint-role-bundling-2026-06-15 — K-1 (the keystone): a role's prompt
 * resolves by walking the blueprint **extends-chain**, then the (temporary)
 * global `prompts/` tiers:
 *
 *   1. blueprints/<blueprintId>/prompts/<role>.md        (the blueprint's own override)
 *   2. blueprints/<ancestor>/prompts/<role>.md           (each extends parent, …)
 *   3. blueprints/base/prompts/<role>.md                 (the shared role library — ALWAYS consulted)
 *   4. prompts/$phase/departments/$dept/$role.md         (global — backstop, deleted in Phase 5)
 *   5. prompts/$phase/$role.md                           (global)
 *   6. prompts/department/$role.md                       (global, when phase=department)
 *   7. prompts/$role.md                                  (global default)
 *
 * Returns the first path that exists, or null if none do.
 *
 * `base` is ALWAYS a candidate (step 3) — even when no `blueprintId` is supplied —
 * because the main shared assembler (`assembleRolePrompt`) passes none, yet every
 * concrete blueprint `extends: base`, so base is the universal role library. This
 * is what lets the global `prompts/` dir (steps 4-7) be deleted in Phase 5: once a
 * role's persona lives in `blueprints/base/prompts/<role>.md`, it resolves via step
 * 3 and the global backstop is no longer needed. During the migration the global
 * tiers stay LAST so resolution is unchanged until base is populated (D-005).
 *
 * Role aliasing: a map of legacy role names → canonical role names. When code
 * references the legacy name we walk the canonical name's candidates FIRST, then
 * the legacy name's. Currently empty — `plan-gate` was retired in favor of
 * `reviewer`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface PromptResolveContext {
  /** Absolute path to the harness install (containing prompts/ + blueprints/). */
  harnessDir: string;
  /** Resolved phase, e.g. "staging" / "department". May be empty. */
  phase: string;
  /** Department slug from .papercusp/config.json `dept`, or empty. */
  dept: string;
  /**
   * The blueprint a spawned role belongs to (e.g. 'vote', 'implement', 'coding').
   * Its own prompts dir is tried FIRST, then its `extends` ancestors, then `base`.
   * Set from the autonomous spawn's `BLUEPRINT_ID=<id>` extra (program + launched
   * blueprints) or threaded by a caller. Absent for a plain pipeline spawn —
   * which still resolves via `base` (the universal library).
   */
  blueprintId?: string;
  /**
   * The pre-resolved extends-chain for `blueprintId`, leaf-first, ending at `base`
   * (e.g. ['implement','single-agent','base']). When omitted, the resolve
   * functions compute it from the blueprint.yaml `extends` headers under
   * `harnessDir` (`resolveBlueprintChain`). Supplied directly by tests and by a
   * marketplace/installed-blueprint resolver (Phase 4). The pure
   * `promptCandidates` consults it as-is; when neither it nor `blueprintId` is set,
   * `base` alone is the chain.
   */
  extendsChain?: string[];
}

/**
 * Legacy role name → canonical role name. The codebase consolidated on
 * `reviewer`. This map exists for future renames; today no aliases are active.
 */
export const ROLE_ALIASES: Record<string, string> = {};

/** The universal role library — every `extends` chain terminates here. */
const BASE_BLUEPRINT_ID = 'base';

/** Read a blueprint.yaml's `extends` header → parent id(s). [] when absent/unreadable. */
function blueprintExtends(harnessDir: string, id: string): string[] {
  const p = join(harnessDir, 'blueprints', id, 'blueprint.yaml');
  if (!existsSync(p)) return [];
  try {
    const parsed = parseYaml(readFileSync(p, 'utf8')) as { extends?: unknown } | null;
    const ext = parsed && typeof parsed === 'object' ? parsed.extends : undefined;
    if (ext == null) return [];
    return Array.isArray(ext) ? ext.map(String) : [String(ext)];
  } catch {
    return [];
  }
}

/**
 * Resolve a blueprint's `extends`-chain into an ordered, deduped, leaf-first id
 * list ending at `base` — by reading the blueprint.yaml `extends` headers under
 * `harnessDir` (the same headers the blueprint loader merges). Cycle-guarded; a
 * missing/unreadable blueprint.yaml just stops that branch. `base` is always the
 * final element even if a blueprint doesn't declare it (every blueprint inherits
 * the universal library).
 *
 * e.g. resolveBlueprintChain(h, 'implement') → ['implement','single-agent','base'];
 *      resolveBlueprintChain(h, 'coding')    → ['coding','base'];
 *      resolveBlueprintChain(h, 'base')      → ['base'].
 */
export function resolveBlueprintChain(harnessDir: string, blueprintId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    for (const parent of blueprintExtends(harnessDir, id)) walk(parent);
  };
  walk(blueprintId);
  if (!chain.includes(BASE_BLUEPRINT_ID)) chain.push(BASE_BLUEPRINT_ID);
  return chain;
}

/** The blueprint-chain a context resolves against (leaf-first, base-terminated). */
function chainForCtx(ctx: PromptResolveContext): string[] {
  const base = (chain: string[]): string[] =>
    chain.includes(BASE_BLUEPRINT_ID) ? chain : [...chain, BASE_BLUEPRINT_ID];
  if (ctx.extendsChain && ctx.extendsChain.length > 0) return base(ctx.extendsChain);
  if (ctx.blueprintId) return base([ctx.blueprintId]);
  return [BASE_BLUEPRINT_ID];
}

function candidatesFor(ctx: PromptResolveContext, role: string): string[] {
  const candidates: string[] = [];
  const promptsRoot = join(ctx.harnessDir, 'prompts');
  const chain = chainForCtx(ctx);

  // ── 1. The blueprint's OWN override, then its non-base `extends` ancestors
  //    (e.g. implement → single-agent). Most specific; precedes the phase tiers
  //    because an explicitly-extended blueprint's override is intentional. `base`
  //    is held back to step 3 (it is the universal DEFAULT, not a specialization).
  for (const id of chain) {
    if (id === BASE_BLUEPRINT_ID) continue;
    candidates.push(join(ctx.harnessDir, 'blueprints', id, 'prompts', `${role}.md`));
  }

  // ── 2. Global phase/dept tiers — the legacy multi-phase (staging/testing/…)
  //    override axis. A phase override must keep winning over `base` (phase
  //    defaults to "staging", so these are LIVE default personas today), so they
  //    precede base. BACKSTOP — deleted in Phase 5 (with the phase personas
  //    relocated first). ──
  if (ctx.phase && ctx.dept) {
    candidates.push(join(promptsRoot, ctx.phase, 'departments', ctx.dept, `${role}.md`));
  }
  if (ctx.phase) {
    candidates.push(join(promptsRoot, ctx.phase, `${role}.md`));
  }
  if (ctx.phase === 'department') {
    candidates.push(join(promptsRoot, 'department', `${role}.md`));
  }

  // ── 3. `base` — the universal role library (every chain terminates here).
  //    The end-state DEFAULT, replacing the legacy global `prompts/<role>.md`
  //    (step 4) it sits just above. ALWAYS consulted, even with no blueprintId.
  if (chain.includes(BASE_BLUEPRINT_ID)) {
    candidates.push(join(ctx.harnessDir, 'blueprints', BASE_BLUEPRINT_ID, 'prompts', `${role}.md`));
  }

  // ── 4. Global default — legacy backstop, deleted in Phase 5. ──
  candidates.push(join(promptsRoot, `${role}.md`));
  return candidates;
}

/** Build the candidate path list (most specific first). Useful for testing.
 *  PURE: consults `ctx.extendsChain`/`ctx.blueprintId` as given (does NOT read
 *  blueprint.yaml). The resolve functions populate `extendsChain` first. */
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
 * Ensure `ctx.extendsChain` is populated when a `blueprintId` is set — reading the
 * blueprint.yaml `extends` headers so multi-level chains
 * (implement→single-agent→base) resolve their intermediate ancestors' overrides.
 * A no-op when the chain is already supplied (tests, marketplace resolver) or no
 * blueprintId is given (the pure `[base]` chain suffices).
 */
function withResolvedChain(ctx: PromptResolveContext): PromptResolveContext {
  if (ctx.extendsChain || !ctx.blueprintId) return ctx;
  return { ...ctx, extendsChain: resolveBlueprintChain(ctx.harnessDir, ctx.blueprintId) };
}

/**
 * Walk the candidate list, returning the first existing path, or null if none
 * exist — caller decides how to surface that (usually: warn + fall back).
 */
export function resolvePromptFile(
  ctx: PromptResolveContext,
  role: string,
): string | null {
  for (const candidate of promptCandidates(withResolvedChain(ctx), role)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The prompt files that COMPOSE a role's prompt, least- to most-specific: the
 * universal generic-role prefix layer first (the "Base Worker/Validator/…"
 * persona — universal rules + the G3 untrusted-peer-content rule), then the
 * resolved concrete prompt (`resolvePromptFile` — authoritative, per the prompts
 * README's "later sections override earlier ones"). Callers join the files'
 * contents with `\n\n---\n\n`. The prefix is prepended to whatever concrete
 * resolves (the base default OR a blueprint/phase override), and only when it is
 * DISTINCT from that concrete (a base-only role resolves to a single file).
 *
 * The generic prefix is consulted in two places, FIRST that exists wins:
 *   1. blueprints/base/prompts/<role>.base.md   (the base blueprint — Phase 2 home)
 *   2. prompts/base/<role>.md                    (legacy global — deleted in Phase 5)
 * Only ~5 roles (worker/validator/documenter/orchestrator/summarizer) HAVE a
 * generic prefix; the rest resolve to a single self-contained file.
 *
 * Returns [] when the role has no prompt at all.
 */
export function resolvePromptFiles(
  ctx: PromptResolveContext,
  role: string,
): string[] {
  const main = resolvePromptFile(ctx, role);
  const canonical = ROLE_ALIASES[role] ?? role;
  const prefix = [
    join(ctx.harnessDir, 'blueprints', BASE_BLUEPRINT_ID, 'prompts', `${canonical}.base.md`),
    join(ctx.harnessDir, 'prompts', 'base', `${canonical}.md`),
  ].find((p) => existsSync(p));
  const sections: string[] = [];
  if (prefix && prefix !== main) sections.push(prefix);
  if (main) sections.push(main);
  return sections;
}
