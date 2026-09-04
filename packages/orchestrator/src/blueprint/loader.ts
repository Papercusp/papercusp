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
 * local → installed → built-in via `resolveExtendsPath`), assembles parent
 * modules first, merges the child through a separately-labelled inheritance
 * step, then parses the merged plain object once through `BlueprintSchema` (so
 * `.default`s apply once, not per-file).
 *
 * THE MERGE ALGEBRA IS DECLARED, NOT HARDCODED (identities-v1-2026-08-30 P-019).
 * Each pairwise merge is `mergeByRules` (`merge.ts`), which applies the per-leaf
 * rule `merge-rules.ts` declares — `set-union` / `keyed-overlay` /
 * `explicit-replacement` / `constraint-intersection` / `hard-conflict` — so a
 * new field states how it composes. D-029 names peer assembly versus inheritance
 * in conflict provenance instead of letting merge order masquerade as policy.
 *
 * identities-v1-2026-08-30 P-001: the walk also records every LAYER it merged
 * (`resolveLayers` → `LoadedBlueprint.layers`, parent-first) with a per-layer
 * content hash, and `resolveBlueprint` fails the load on a layer whose
 * `attestation.contentHash` disagrees with its content or on two distinct layers
 * claiming one EXCLUSIVE slot (D-007) — the `hard-conflict` rule's refusal, which
 * needs the layers, not the merged document. Exact bundle pins are checked over
 * those same source layers: incompatible versions fail with their authors named
 * unless a later validated `versionOverride` replaces every competing version.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { harnessPath, harnessRootCandidates } from '@papercusp/harness/paths';
import {
  BlueprintHeaderSchema,
  BundleRefSchema,
  RunnableBlueprintSchema,
  isBlueprintContributionField,
  parseBlueprintSourceDocument,
  type Blueprint,
  type BlueprintContributionField,
  type BlueprintSourceKind,
  type BundleRef,
  type RunnableBlueprint,
} from './schema.js';
import { validateBlueprint, type BlueprintValidation, type ValidateOptions } from './validate.js';
import { canonicalBlueprintId } from '../blueprint-aliases.js';
import { findExclusiveSlotConflicts, type SlotClaim } from './slots.js';
import { mergeByRules, isPlainObject, stableStringify } from './merge.js';
import { lintStackLayers, type IdentityLintOptions, type LayerTrust } from './identity-lint.js';
import { homedir } from 'node:os';

// The pre-P-019 last-writer-wins merge, kept as the reference algebra + the rule
// for a record's values (see merge.ts); re-exported here for its historical callers.
export { mergeRaw } from './merge.js';

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
export type RawBlueprint = Record<string, unknown>;

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
  /** Classification of THIS authored layer, before inherited fields are merged. */
  sourceKind: BlueprintSourceKind;
  /** The file this layer was read from (null for the in-memory root raw). */
  sourcePath: string | null;
  /** sha256 over the layer's OWN raw document, `attestation` excluded (`layerContentHash`). */
  contentHash: string;
  /** The layer's declared attestation, if any — `resolveBlueprint` verifies it against `contentHash`. */
  attestation: { contentHash: string; signedBy: string } | null;
  /** The slot ids this layer declares (raw `slots[].slot`; validated per document by `validateBlueprint`). */
  slots: string[];
  /** Top-level keys of the layer's OWN raw document, `extends` excluded — what `identity-lint` reads for the mode-axis authority check (P-003). */
  fields: BlueprintContributionField[];
  /** The layer's own declared grants (raw `grants.requires` / `grants.optional`), null when it declares none (P-003, D-005 ceiling check). */
  grants: { requires: string[]; optional: string[] } | null;
  /** Exact bundle declarations retained per source layer for D-029 conflict provenance. */
  bundles: BundleRef[];
  /** Where the layer was read from: the built-in harness tree, the per-hive local tier, or the installed (`~/.papercusp/blueprints`) tier — an INSTALLED layer must attest (P-003). */
  trust: LayerTrust;
}

/**
 * Source snapshots are kept out of the public layer shape (and out of the PG
 * projection) but remain available to the composition compiler.  The merged
 * blueprint necessarily loses which layer supplied a nested value; retaining a
 * private snapshot lets P-038 report exact per-field origins without creating a
 * second source representation.  A WeakMap also means legacy callers that
 * serialize `BlueprintLayer` keep their byte shape unchanged.
 */
const layerSourceSnapshots = new WeakMap<BlueprintLayer, Readonly<RawBlueprint>>();

function snapshotRaw(value: RawBlueprint): Readonly<RawBlueprint> {
  const clone = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clone);
    if (isPlainObject(input)) {
      const out: RawBlueprint = {};
      for (const key of Object.keys(input)) out[key] = clone(input[key]);
      return out;
    }
    return input;
  };
  return clone(value) as Readonly<RawBlueprint>;
}

/** Return the immutable authored source snapshot for one live loader layer. */
export function layerSourceDocument(layer: BlueprintLayer): Readonly<RawBlueprint> | null {
  return layerSourceSnapshots.get(layer) ?? null;
}

/** Roots of the built-in and installed blueprint tiers, for `layerTrust`. */
const BUILTIN_BLUEPRINTS_ROOT = join(builtinBlueprintPath('base'), '..', '..');
const INSTALLED_BLUEPRINTS_ROOT = join(homedir(), '.papercusp', 'blueprints');

/**
 * The trust tier of a layer by where it was read from. An in-memory root (null path)
 * is the caller's own document — local. Only the installed tier is third-party by
 * construction, so only it is required to attest (`identity-lint` default).
 */
export function layerTrust(sourcePath: string | null): LayerTrust {
  if (!sourcePath) return 'local';
  if (sourcePath.startsWith(BUILTIN_BLUEPRINTS_ROOT)) return 'builtin';
  if (sourcePath.startsWith(INSTALLED_BLUEPRINTS_ROOT)) return 'installed';
  return 'local';
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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
  const sourceKind = parseBlueprintSourceDocument(raw).kind;
  const att = isPlainObject(raw.attestation) ? raw.attestation : null;
  const attestation =
    att && typeof att.contentHash === 'string' && typeof att.signedBy === 'string'
      ? { contentHash: att.contentHash, signedBy: att.signedBy }
      : null;
  const slots = Array.isArray(raw.slots)
    ? raw.slots.flatMap((s) => (isPlainObject(s) && typeof s.slot === 'string' ? [s.slot] : []))
    : [];
  const fields = Object.keys(raw).filter(isBlueprintContributionField);
  const g = isPlainObject(raw.grants) ? raw.grants : null;
  const grants = g ? { requires: stringList(g.requires), optional: stringList(g.optional) } : null;
  const bundles = Array.isArray(raw.bundles) ? raw.bundles.map((bundle) => BundleRefSchema.parse(bundle)) : [];
  const layer: BlueprintLayer = {
    id: String(raw.id),
    sourceKind,
    sourcePath,
    contentHash: layerContentHash(raw),
    attestation,
    slots,
    fields,
    grants,
    bundles,
    trust: layerTrust(sourcePath),
  };
  layerSourceSnapshots.set(layer, snapshotRaw(raw));
  return layer;
}

interface ExactBundleClaim {
  layerId: string;
  layerContentHash: string;
  version: string;
}

/**
 * D-029 exact-pin consistency over the SOURCE layers. The merged document has
 * already lost the losing value and cannot name its author, so this check must
 * run here, beside the exclusive-slot check, while layer provenance survives.
 */
function exactBundleVersionConflicts(layers: readonly BlueprintLayer[]): string[] {
  const effective = new Map<string, ExactBundleClaim[]>();
  for (const layer of layers) {
    for (const bundle of layer.bundles) {
      if (!bundle.version) continue;
      const key = `${bundle.kind}/${bundle.ref}`;
      const previous = effective.get(key) ?? [];
      const duplicateLayer = previous.some(
        (claim) =>
          claim.layerId === layer.id &&
          claim.layerContentHash === layer.contentHash &&
          claim.version === bundle.version,
      );
      if (duplicateLayer) continue;

      const claim = { layerId: layer.id, layerContentHash: layer.contentHash, version: bundle.version };
      const replaces = new Set(bundle.versionOverride?.replaces ?? []);
      const survivors = previous.filter((prior) => !replaces.has(prior.version));
      // Defer the diagnostic: a still-higher-precedence declaration may carry a
      // validated override covering every active version. Keeping unresolved
      // claims here also gives an incomplete override a complete provenance list.
      effective.set(key, [...survivors, claim]);
    }
  }

  const conflicts: string[] = [];
  for (const [key, claims] of effective) {
    if (new Set(claims.map((claim) => claim.version)).size <= 1) continue;
    const sources = claims.map((claim) => `layer "${claim.layerId}" pins "${claim.version}"`).join(', ');
    conflicts.push(
      `bundle "${key}" has incompatible exact versions: ${sources}; no later validated versionOverride replaces every competing version`,
    );
  }
  return conflicts;
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
    merged = mergeByRules(merged, parent.merged, {
      mode: 'peer-assembly',
      baseSources: layers.map((layer) => layer.id),
      childSources: parent.layers.map((layer) => layer.id),
    });
    layers.push(...parent.layers);
  }
  // The child is the last layer; drop the now-consumed `extends` from the resolved result.
  const { extends: _drop, ...childOwn } = mergeByRules(merged, raw, {
    mode: 'inheritance',
    baseSources: layers.map((layer) => layer.id),
    childSources: [String(raw.id)],
  });
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
  /** Resolved, executable configuration; never an authored source fragment. */
  blueprint: RunnableBlueprint;
  /** Kind of the ROOT authored document, unaffected by inherited slots. */
  sourceKind: BlueprintSourceKind;
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
    /** identity-lint options for the structural BLOCK tier over the stack (P-003): the D-005 ceiling, which layers must attest. */
    lint?: IdentityLintOptions;
  } = {},
): LoadedBlueprint {
  const sourcePath = opts.sourcePath ?? null;
  const { merged, layers } = resolveLayers(raw, opts.resolve ?? resolveBuiltinExtends, sourcePath);
  const blueprint = RunnableBlueprintSchema.parse(merged);
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
  for (const message of exactBundleVersionConflicts(layers)) {
    validation.errors.push({ level: 'error', code: 'bundle-version-conflict', message });
  }
  // ── identity-lint, structural BLOCK tier over the composed stack (P-003 / D-009 as amended):
  //    a kernel-slot claim, a grant past the D-005 ceiling, authority on a mode-axis document, a
  //    missing attestation on an installed layer. The two findings the loops above already report
  //    under their pinned codes (`slot-exclusive-conflict`, `attestation-hash-mismatch`) are not
  //    reported twice. Every finding fails the load — there is no override path.
  for (const f of lintStackLayers(layers, opts.lint)) {
    if (f.code === 'exclusive-double-claim' || f.code === 'attestation-failed') continue;
    validation.errors.push({ level: 'error', code: f.code, message: f.message });
  }
  validation.ok = validation.errors.length === 0;
  if (!validation.ok) {
    const msg = validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`invalid blueprint "${blueprint.id}": ${msg}`);
  }
  return {
    blueprint,
    sourceKind: layers[layers.length - 1]!.sourceKind,
    validation,
    contentHash: blueprintHash(blueprint),
    sourcePath,
    layers,
  };
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
