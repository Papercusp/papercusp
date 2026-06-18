/**
 * Blueprint loader — the file-read/parse path that turns a git-canonical
 * `.papercusp/blueprint.yaml` (+ its `extends` chain) into a resolved,
 * schema-validated `Blueprint` (`harness-blueprint-orchestration-2026-06-03`
 * P-002 / D-021).
 *
 * This is the SAME file-read/parse pattern plans/specs/config use — NOT the
 * Hyperbee CRDT `TableProjection` (which is peer-sync machinery, wrong for a
 * single-writer local git file). The operator projects the resolved result into
 * `harness_shared.blueprints` (the PG cache the interpreter reads); this module
 * is the pure read+resolve half (fs + yaml + zod), unit-testable without PG.
 *
 * Inheritance: a child names parent blueprint id(s) via `extends`; the loader
 * resolves each (built-in by default; the distribution plan widens this to
 * local → installed → built-in via `resolveExtendsPath`), deep-merges them
 * parent-first with the child on top, then parses the merged plain object once
 * through `BlueprintSchema` (so `.default`s apply once, not per-file). Merge
 * rule: objects deep-merge (child wins on leaf keys); arrays + scalars are
 * replaced wholesale by the child.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { BlueprintSchema, BlueprintHeaderSchema, type Blueprint } from './schema.js';
import { validateBlueprint, type BlueprintValidation, type ValidateOptions } from './validate.js';

/**
 * The registry sets the operator passes so the load path enforces the op/role
 * liveness contract (`deterministic-blueprints-migration-2026-06-13` P-001) —
 * an unknown op is an error; an undeclared-but-live role is not flagged. The
 * pure lib doesn't own either registry (D-001/D-004), so the operator injects
 * them at the admission chokepoints (projection / install / authoring); omitted
 * → the load stays lenient (every pre-P-001 caller is byte-unchanged).
 */
export type BlueprintValidateRegistry = Pick<ValidateOptions, 'knownOps' | 'knownRoles'>;

/** A raw, pre-merge blueprint object straight off disk. */
type RawBlueprint = Record<string, unknown>;

/** Resolve a blueprint `extends` id → an absolute file path, or null if absent. */
export type ResolveExtendsPath = (id: string) => string | null;

/** Built-in blueprints ship under `@papercusp/harness/blueprints/<id>/blueprint.yaml`. */
export function builtinBlueprintPath(id: string): string {
  return harnessPath('blueprints', id, 'blueprint.yaml');
}

/** Default resolver — built-ins only. The distribution plan composes local/installed in front. */
export const resolveBuiltinExtends: ResolveExtendsPath = (id) => {
  const p = builtinBlueprintPath(id);
  return existsSync(p) ? p : null;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `child` over `base`: plain objects merge recursively; arrays and
 * scalars are replaced by the child's value. Pure (returns a new object).
 */
export function mergeRaw(base: RawBlueprint, child: RawBlueprint): RawBlueprint {
  const out: Record<string, unknown> = { ...base };
  for (const [k, cv] of Object.entries(child)) {
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(cv) ? mergeRaw(bv, cv) : cv;
  }
  return out;
}

function readRaw(path: string): RawBlueprint {
  const parsed = parseYaml(readFileSync(path, 'utf8'));
  if (!isPlainObject(parsed)) {
    throw new Error(`blueprint at ${path} is not a YAML mapping`);
  }
  // Sanity-check the header (id + optional extends) before merging.
  BlueprintHeaderSchema.parse(parsed);
  return parsed;
}

/**
 * Resolve a raw blueprint's `extends` chain into a single merged raw object.
 * Walks parents depth-first (so a grandparent merges before a parent), guarding
 * against cycles. The returned object still needs `BlueprintSchema.parse`.
 */
export function resolveExtends(
  raw: RawBlueprint,
  resolve: ResolveExtendsPath = resolveBuiltinExtends,
  seen: Set<string> = new Set(),
): RawBlueprint {
  const ext = raw.extends;
  if (ext == null) return raw;
  const parentIds = Array.isArray(ext) ? ext : [String(ext)];

  let merged: RawBlueprint = {};
  for (const pid of parentIds) {
    if (seen.has(pid)) {
      throw new Error(`blueprint extends cycle detected at "${pid}"`);
    }
    const path = resolve(pid);
    if (!path) throw new Error(`cannot resolve extended blueprint "${pid}"`);
    const parentRaw = resolveExtends(readRaw(path), resolve, new Set([...seen, pid]));
    merged = mergeRaw(merged, parentRaw);
  }
  // Child wins; drop the now-consumed `extends` from the resolved result.
  const { extends: _drop, ...childOwn } = mergeRaw(merged, raw);
  return childOwn;
}

export interface LoadedBlueprint {
  blueprint: Blueprint;
  validation: BlueprintValidation;
  /** sha256 of the resolved blueprint — the PG cache key / drift signal. */
  contentHash: string;
  /** The file the blueprint was read from (null for an in-memory raw). */
  sourcePath: string | null;
}

/** Stable sha256 over the resolved blueprint (sorted keys → order-independent). */
export function blueprintHash(bp: Blueprint): string {
  return createHash('sha256').update(stableStringify(bp)).digest('hex');
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Resolve + parse + validate a raw blueprint object into a `LoadedBlueprint`.
 * Throws if `validateBlueprint` reports errors (a malformed spine must never
 * reach the durable pipeline); warnings are returned, not thrown.
 */
export function resolveBlueprint(
  raw: RawBlueprint,
  opts: {
    resolve?: ResolveExtendsPath;
    sourcePath?: string | null;
    /** Operator-injected registries → op/role liveness enforcement (P-001). */
    registry?: BlueprintValidateRegistry;
  } = {},
): LoadedBlueprint {
  const merged = resolveExtends(raw, opts.resolve ?? resolveBuiltinExtends);
  const blueprint = BlueprintSchema.parse(merged);
  const validation = validateBlueprint(blueprint, opts.registry ?? {});
  if (!validation.ok) {
    const msg = validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`invalid blueprint "${blueprint.id}": ${msg}`);
  }
  return { blueprint, validation, contentHash: blueprintHash(blueprint), sourcePath: opts.sourcePath ?? null };
}

/** Load + resolve a blueprint from a YAML file path (e.g. `.papercusp/blueprint.yaml`). */
export function loadBlueprintFromFile(
  path: string,
  resolve?: ResolveExtendsPath,
  registry?: BlueprintValidateRegistry,
): LoadedBlueprint {
  return resolveBlueprint(readRaw(path), { resolve, sourcePath: path, registry });
}

/** Load + resolve a built-in blueprint by id (e.g. 'coding', 'research'). */
export function loadBuiltinBlueprint(
  id: string,
  resolve?: ResolveExtendsPath,
  registry?: BlueprintValidateRegistry,
): LoadedBlueprint {
  const path = builtinBlueprintPath(id);
  if (!existsSync(path)) throw new Error(`no built-in blueprint "${id}" at ${path}`);
  return loadBlueprintFromFile(path, resolve, registry);
}
