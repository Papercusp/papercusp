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
 *
 * identities-v1-2026-08-30 P-001: the walk also records every LAYER it merged
 * (`resolveLayers` → `LoadedBlueprint.layers`, parent-first) with a per-layer
 * content hash, and `resolveBlueprint` fails the load on a layer whose
 * `attestation.contentHash` disagrees with its content or on two distinct layers
 * claiming one EXCLUSIVE slot (D-007). The per-field composition rules are
 * DECLARED in `merge-rules.ts`; P-019 replaces `mergeRaw` with the merger that
 * honours them (this file's last-writer-wins is byte-identical to `replace` for
 * scalars/arrays and `union` for records — the registry's default assignment).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { harnessPath, harnessRootCandidates } from '@papercusp/harness/paths';
import { BlueprintSchema, BlueprintHeaderSchema, type Blueprint } from './schema.js';
import { validateBlueprint, type BlueprintValidation, type ValidateOptions } from './validate.js';
import { canonicalBlueprintId } from '../blueprint-aliases.js';
import { findExclusiveSlotConflicts, type SlotClaim } from './slots.js';

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

/** Built-in blueprints ship under `@papercusp/harness/blueprints/<id>/blueprint.yaml`.
 *  Legacy ids are aliased (hive→coding, generic-hive→work) so a stale `extends:`
 *  or `loadBuiltinBlueprint(<old id>)` still resolves during the 2026-06-18 rename. */
export function builtinBlueprintPath(id: string): string {
  const cid = canonicalBlueprintId(id);
  // Try each candidate harness root — the primary `harnessRoot()` first, then any
  // derived SOURCE package (EI-8628: a blueprint present in the fresh source tree
  // but MISSING from a stale bundled `dist-host/blueprints` copy must still resolve,
  // not throw `no built-in blueprint`). Fall back to the primary path (for the
  // caller's error message) when the blueprint exists in none of them.
  for (const root of harnessRootCandidates()) {
    const p = join(root, 'blueprints', cid, 'blueprint.yaml');
    if (existsSync(p)) return p;
  }
  return harnessPath('blueprints', cid, 'blueprint.yaml');
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
 * One document of a resolved stack (identities-v1 P-001). `layers` is the
 * merge order — parents first, the loaded document last — so a renderer that
 * walks it sees precedence ascending.
 */
export interface BlueprintLayer {
  id: string;
  /** The file this layer was read from (null for the in-memory root raw). */
  sourcePath: string | null;
  /** sha256 over the layer's OWN raw document, `attestation` excluded (`layerContentHash`). */
  contentHash: string;
  /** The layer's declared attestation, if any — `resolveBlueprint` verifies it against `contentHash`. */
  attestation: { contentHash: string; signedBy: string } | null;
  /** The slot ids this layer declares (raw `slots[].slot`; validated per document by `validateBlueprint`). */
  slots: string[];
}

/**
 * The per-LAYER content hash: sha256 over the raw document with `attestation`
 * removed — so a publisher can sign a document that then carries its own
 * attestation without the signature invalidating itself. Sorted-key stable, like
 * `blueprintHash`, which remains the hash of the RESOLVED document.
 */
export function layerContentHash(raw: RawBlueprint): string {
  const { attestation: _omit, ...content } = raw;
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

function layerOf(raw: RawBlueprint, sourcePath: string | null): BlueprintLayer {
  const att = isPlainObject(raw.attestation) ? raw.attestation : null;
  const attestation =
    att && typeof att.contentHash === 'string' && typeof att.signedBy === 'string'
      ? { contentHash: att.contentHash, signedBy: att.signedBy }
      : null;
  const slots = Array.isArray(raw.slots)
    ? raw.slots.flatMap((s) => (isPlainObject(s) && typeof s.slot === 'string' ? [s.slot] : []))
    : [];
  return { id: String(raw.id), sourcePath, contentHash: layerContentHash(raw), attestation, slots };
}

/**
 * Resolve a raw blueprint's `extends` chain into a single merged raw object AND
 * the ordered list of layers it merged. Walks parents depth-first (so a
 * grandparent merges before a parent), guarding against cycles. `merged` still
 * needs `BlueprintSchema.parse`; `layers` is parent-first with `raw` last.
 */
export function resolveLayers(
  raw: RawBlueprint,
  resolve: ResolveExtendsPath = resolveBuiltinExtends,
  sourcePath: string | null = null,
  seen: Set<string> = new Set(),
): { merged: RawBlueprint; layers: BlueprintLayer[] } {
  const ext = raw.extends;
  if (ext == null) return { merged: raw, layers: [layerOf(raw, sourcePath)] };
  const parentIds = Array.isArray(ext) ? ext : [String(ext)];

  let merged: RawBlueprint = {};
  const layers: BlueprintLayer[] = [];
  for (const pid of parentIds) {
    if (seen.has(pid)) {
      throw new Error(`blueprint extends cycle detected at "${pid}"`);
    }
    const path = resolve(pid);
    if (!path) throw new Error(`cannot resolve extended blueprint "${pid}"`);
    const parent = resolveLayers(readRaw(path), resolve, path, new Set([...seen, pid]));
    merged = mergeRaw(merged, parent.merged);
    layers.push(...parent.layers);
  }
  // Child wins; drop the now-consumed `extends` from the resolved result.
  const { extends: _drop, ...childOwn } = mergeRaw(merged, raw);
  layers.push(layerOf(raw, sourcePath));
  return { merged: childOwn, layers };
}

/**
 * Resolve a raw blueprint's `extends` chain into a single merged raw object
 * (the pre-P-001 signature; `resolveLayers` is the same walk keeping the layers).
 */
export function resolveExtends(
  raw: RawBlueprint,
  resolve: ResolveExtendsPath = resolveBuiltinExtends,
  seen: Set<string> = new Set(),
): RawBlueprint {
  return resolveLayers(raw, resolve, null, seen).merged;
}

export interface LoadedBlueprint {
  blueprint: Blueprint;
  validation: BlueprintValidation;
  /** sha256 of the resolved blueprint — the PG cache key / drift signal. */
  contentHash: string;
  /** The file the blueprint was read from (null for an in-memory raw). */
  sourcePath: string | null;
  /** The stack that was merged, parent-first, each with its own content hash (P-001). */
  layers: BlueprintLayer[];
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
  const sourcePath = opts.sourcePath ?? null;
  const { merged, layers } = resolveLayers(raw, opts.resolve ?? resolveBuiltinExtends, sourcePath);
  const blueprint = BlueprintSchema.parse(merged);
  const validation = validateBlueprint(blueprint, opts.registry ?? {});
  // ── stack-level checks (identities-v1 P-001) — need the layers, not the merged doc ──
  for (const layer of layers) {
    if (layer.attestation && layer.attestation.contentHash !== layer.contentHash) {
      validation.errors.push({
        level: 'error',
        code: 'attestation-hash-mismatch',
        message: `layer "${layer.id}" attests contentHash ${layer.attestation.contentHash.slice(0, 12)}… but its content hashes to ${layer.contentHash.slice(0, 12)}… — the document changed after signing, or the attestation was copied from another revision`,
      });
    }
  }
  const claims: SlotClaim[] = layers.flatMap((l) => l.slots.map((slot) => ({ id: l.id, slot })));
  for (const c of findExclusiveSlotConflicts(claims)) {
    validation.errors.push({
      level: 'error',
      code: 'slot-exclusive-conflict',
      message: `exclusive slot "${c.slot}" is claimed by ${c.claimants.length} layers (${c.claimants.join(', ')}) — an exclusive slot admits exactly one document per stack (D-007)`,
    });
  }
  validation.ok = validation.errors.length === 0;
  if (!validation.ok) {
    const msg = validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`invalid blueprint "${blueprint.id}": ${msg}`);
  }
  return { blueprint, validation, contentHash: blueprintHash(blueprint), sourcePath, layers };
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
