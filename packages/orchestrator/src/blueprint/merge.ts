/**
 * The MERGE_RULES-driven merger — `identities-v1-2026-08-30` P-019 (rulings D-003 /
 * D-007 / D-017 §4 / D-020). `resolveLayers` composes an `extends` stack with
 * `mergeByRules`; the per-leaf algebra it applies is DECLARED in `merge-rules.ts`,
 * never hardcoded here.
 *
 * HOW A DOCUMENT IS WALKED. `BlueprintSchema` is a tree of OBJECT nodes whose
 * leaves are the merge-units `enumerateBlueprintLeaves` lists (a scalar, a whole
 * array, a whole record, a union, a lazy schema, or an object's catchall keys).
 * The merger descends every INTERIOR node (`schemaInteriorPaths` — each proper
 * prefix of a leaf path) field by field, and at a LEAF applies `mergeRuleFor(path)`:
 *
 *   - `replace`          — the child's value, taken whole, when the child sets the
 *                          key; an absent child key inherits. For an object-valued
 *                          CATCHALL key (`knobs.someUnknownKnob: {…}`) this is the
 *                          one place the algebra is stricter than `mergeRaw`, which
 *                          would deep-merge it: the schema knows nothing below a
 *                          catchall, so the child's value is opaque and wins whole
 *                          (no builtin blueprint sets such a key on two layers —
 *                          `merge.test.ts`'s golden proves it).
 *   - `union`            — set-union. Records: key-union, and a key present on both
 *                          sides composes its VALUES by last-writer-wins deep-merge
 *                          (`mergeRaw`, below) — byte-identical to today, because a
 *                          record is ONE leaf and nothing below it is enumerated.
 *                          Arrays: elements identified by `rule.key` (a field or a
 *                          tuple of fields; an element missing the key falls back to
 *                          value identity) or by structural value; a colliding
 *                          element likewise deep-merges, so a child restating a
 *                          role / slot / bundle overrides the fields it names and
 *                          inherits the rest. Base order, then the child's new
 *                          elements in the child's order.
 *   - `most-restrictive` — two numbers: the smaller. Any other pairing is not
 *                          comparable, so the child's value goes through to the
 *                          schema, which refuses a non-number where a cap belongs.
 *   - `hard-error`       — in the DOCUMENT, a keyed union (the resolved `slots` lists
 *                          every slot the stack fills — the renderer needs that). The
 *                          "two DISTINCT layers claim one exclusive key" refusal needs
 *                          layer identity a merged document no longer carries, so it
 *                          runs over `LoadedBlueprint.layers` in `resolveBlueprint`
 *                          (`findExclusiveSlotConflicts`, `slot-exclusive-conflict`),
 *                          where a diamond re-visit of the same document is one
 *                          claimant. `merge-rules.test.ts` pins `slots` as the only
 *                          hard-error leaf; `loader.layers.test.ts` proves the refusal.
 *
 * A key the registry does not govern at all — outside `BlueprintSchema`, which
 * strips it at parse — composes by `mergeRaw`, exactly as before.
 *
 * THE STACK WALK IS UNCHANGED (P-019 changes the algebra, not the graph): parents
 * are resolved depth-first and merged pairwise in `extends` order, the child last.
 * `mergeRaw` (last-writer-wins) is not associative when an intermediate layer sets
 * a scalar over an object a later layer sets again, so the golden test compares the
 * rule-driven walk against a `mergeRaw` walk of the SAME shape, not a flat fold.
 */
import { mergeRuleFor, enumerateBlueprintLeaves, type MergeRule } from './merge-rules.js';

/** A raw, pre-parse blueprint object (straight off disk, or an already-merged subtree). */
export type RawDocument = Record<string, unknown>;

export function isPlainObject(v: unknown): v is RawDocument {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Sorted-key JSON — the structural identity of a value (order-independent for objects). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Last-writer-wins deep-merge: plain objects merge recursively; arrays and scalars
 * are replaced by the child's value. Pure. This was the WHOLE algebra before P-019;
 * it survives as (a) the composition of a record's values and of colliding keyed
 * elements under `union`, (b) the rule for a key outside the schema, and (c) the
 * reference the golden test compares the rule-driven merger against.
 */
export function mergeRaw(base: RawDocument, child: RawDocument): RawDocument {
  const out: RawDocument = { ...base };
  for (const [k, cv] of Object.entries(child)) {
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(cv) ? mergeRaw(bv, cv) : cv;
  }
  return out;
}

let interiorCache: ReadonlySet<string> | null = null;

/**
 * The OBJECT nodes of `BlueprintSchema` — every proper prefix of a leaf path
 * (`knobs`, `knobs.promotion`, `knobs.promotion.smokeBuild`, …). The merger
 * descends these; everything else is a leaf governed by `mergeRuleFor`. Derived
 * from the same enumeration `MERGE_RULES` is asserted exhaustive over, so a new
 * object field descends without any registration here.
 */
export function schemaInteriorPaths(): ReadonlySet<string> {
  if (!interiorCache) {
    const set = new Set<string>();
    for (const { path } of enumerateBlueprintLeaves()) {
      const segs = path.split('.');
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join('.'));
    }
    interiorCache = set;
  }
  return interiorCache;
}

function elementIdentity(el: unknown, key: MergeRule['key']): string {
  if (key && isPlainObject(el)) {
    const fields = typeof key === 'string' ? [key] : key;
    const parts = fields.map((f) => el[f]);
    if (parts.every((p) => p !== undefined)) return `k:${JSON.stringify(parts)}`;
  }
  return `v:${stableStringify(el)}`;
}

/**
 * Set-union of two arrays. Identity is `key` (a field or tuple of fields on a plain
 * object element) or structural value. Base order first; a child element whose
 * identity already exists deep-merges INTO that position (child fields win); new
 * elements append in the child's order. Duplicates within one side collapse too, so
 * `unionArrays(a, a)` is the deduplicated `a` (idempotent) and the identity SET is
 * commutative — `merge.test.ts` holds both as fast-check properties.
 */
export function unionArrays(base: readonly unknown[], child: readonly unknown[], key?: MergeRule['key']): unknown[] {
  const out: unknown[] = [];
  const at = new Map<string, number>();
  for (const el of [...base, ...child]) {
    const id = elementIdentity(el, key);
    const i = at.get(id);
    if (i === undefined) {
      at.set(id, out.length);
      out.push(el);
    } else {
      const prev = out[i];
      out[i] = isPlainObject(prev) && isPlainObject(el) ? mergeRaw(prev, el) : el;
    }
  }
  return out;
}

/** The tighter of two caps. Non-numeric pairings are not comparable: the child's value goes through. */
export function mostRestrictive(base: unknown, child: unknown): unknown {
  return typeof base === 'number' && typeof child === 'number' ? Math.min(base, child) : child;
}

/**
 * Apply ONE leaf's rule to a base value and a child value. `undefined` on either
 * side short-circuits to the child (an absent base has nothing to compose with;
 * an explicitly-undefined child key is carried as `mergeRaw` carries it).
 */
export function applyMergeRule(rule: MergeRule, base: unknown, child: unknown): unknown {
  if (base === undefined || child === undefined) return child;
  switch (rule.rule) {
    case 'replace':
      return child;
    case 'most-restrictive':
      return mostRestrictive(base, child);
    case 'union':
    case 'hard-error':
      if (Array.isArray(base) && Array.isArray(child)) return unionArrays(base, child, rule.key);
      if (isPlainObject(base) && isPlainObject(child)) return mergeRaw(base, child);
      return child;
  }
}

function mergeNode(base: RawDocument, child: RawDocument, path: string, interior: ReadonlySet<string>): RawDocument {
  const out: RawDocument = { ...base };
  for (const [k, cv] of Object.entries(child)) {
    const p = path ? `${path}.${k}` : k;
    const bv = out[k];
    if (interior.has(p)) {
      // An object node of the schema: descend field by field. A non-object on either
      // side (a child's `retired: null`, say) cannot be descended — the child's value
      // replaces, as it always has.
      out[k] = isPlainObject(bv) && isPlainObject(cv) ? mergeNode(bv, cv, p, interior) : cv;
      continue;
    }
    const rule = mergeRuleFor(p);
    out[k] = rule ? applyMergeRule(rule, bv, cv) : isPlainObject(bv) && isPlainObject(cv) ? mergeRaw(bv, cv) : cv;
  }
  return out;
}

/**
 * Merge `child` over `base` under the declared `MERGE_RULES`. Pure (a new object;
 * neither input is mutated). The loader calls this pairwise along the `extends`
 * walk; `mergeByRules(doc, {})` and `mergeByRules({}, doc)` are both `doc`.
 */
export function mergeByRules(base: RawDocument, child: RawDocument): RawDocument {
  return mergeNode(base, child, '', schemaInteriorPaths());
}
