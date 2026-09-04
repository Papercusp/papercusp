/**
 * identities-v1-2026-08-30 P-019 — the MERGE_RULES-driven merger (`merge.ts`) and
 * its wiring into `resolveLayers`. Three evidence families:
 *
 *   1. GOLDEN — every builtin blueprint resolves to the SAME document under the
 *      rule-driven walk and under the pre-P-019 `mergeRaw` walk (same graph shape),
 *      so the registry's default assignment really is byte-equivalent, and the
 *      declared deviations (caps, unions) moved no builtin (D-020 re-authored the
 *      one template whose children raised a cap rather than clamp them).
 *   2. FIXTURES for each declared deviation — the cap flip a parent-200 / child-500
 *      `maxTurns` → 200 asserted explicitly; slots / bundles / roles / dependencies
 *      union across layers; the exclusive-slot refusal survives the new merger.
 *   3. fast-check PROPERTIES where the rule is algebraic: union is commutative +
 *      idempotent (as an identity set); most-restrictive is commutative; replace is
 *      order-dependent by design.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { harnessPath } from '@papercusp/harness/paths';
import { MERGE_RULES, mergeRuleFor, type MergeRule } from './merge-rules.js';
import {
  mergeByRules,
  mergeRaw,
  applyMergeRule,
  unionArrays,
  mostRestrictive,
  schemaInteriorPaths,
  stableStringify,
  type RawDocument,
} from './merge.js';
import { resolveLayers, resolveBlueprint, resolveBuiltinExtends, builtinBlueprintPath, type ResolveExtendsPath } from './loader.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function readYaml(path: string): RawDocument {
  return parseYaml(readFileSync(path, 'utf8')) as RawDocument;
}

/**
 * The PRE-P-019 walk, re-implemented here rather than parameterized out of the
 * loader so the golden compares against an independent reference: the same
 * depth-first, pairwise, parent-first shape `resolveLayers` has, with `mergeRaw`
 * as the algebra.
 */
function resolveWithMergeRaw(raw: RawDocument, resolve: ResolveExtendsPath): RawDocument {
  const ext = raw.extends;
  if (ext == null) return raw;
  const parentIds = Array.isArray(ext) ? ext : [String(ext)];
  let merged: RawDocument = {};
  for (const pid of parentIds) {
    const path = resolve(String(pid));
    if (!path) throw new Error(`cannot resolve "${pid}"`);
    merged = mergeRaw(merged, resolveWithMergeRaw(readYaml(path), resolve));
  }
  const { extends: _drop, ...childOwn } = mergeRaw(merged, raw);
  return childOwn;
}

/** The first dot-path at which two documents differ, for a readable golden failure. */
function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (stableStringify(a) === stableStringify(b)) return null;
  const isObj = (v: unknown): v is RawDocument => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
  }
  return `${path || '<root>'}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

/** Materialize a set of blueprint documents on disk + a resolver over them. */
function chain(docs: Record<string, RawDocument>) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-merge-'));
  for (const [id, doc] of Object.entries(docs)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'blueprint.yaml'), toYaml(doc), 'utf8');
  }
  const resolve = (id: string): string | null => (id in docs ? join(dir, id, 'blueprint.yaml') : null);
  return { resolve, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const runnable = { workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };

const BP_DIR = harnessPath('blueprints');
const builtinIds = (): string[] => readdirSync(BP_DIR).filter((d) => existsSync(join(BP_DIR, d, 'blueprint.yaml')));
const CAP_LEAVES = Object.entries(MERGE_RULES)
  .filter(([, r]) => r.rule === 'most-restrictive')
  .map(([p]) => p);
const getPath = (doc: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((cur, seg) => (typeof cur === 'object' && cur !== null ? (cur as RawDocument)[seg] : undefined), doc);

// ── 1. golden ───────────────────────────────────────────────────────────────

test('GOLDEN — every builtin blueprint resolves to the same document under the rule-driven merger and under the pre-P-019 mergeRaw walk', () => {
  const ids = builtinIds();
  assert.ok(ids.length >= 45, `expected the full builtin set, got ${ids.length}`);
  for (const must of ['base', 'coding', 'single-agent', 'papercusp-engineer', 'su-collaborator']) {
    assert.ok(ids.includes(must), `builtin ${must} missing from the golden population`);
  }
  const diffs: string[] = [];
  for (const id of ids) {
    const path = builtinBlueprintPath(id);
    const byRules = resolveLayers(readYaml(path), resolveBuiltinExtends, path).merged;
    const byRaw = resolveWithMergeRaw(readYaml(path), resolveBuiltinExtends);
    const d = firstDiff(byRules, byRaw);
    if (d) diffs.push(`${id} @ ${d}`);
  }
  assert.deepEqual(diffs, [], `builtin blueprints whose resolved document CHANGED under MERGE_RULES:\n  ${diffs.join('\n  ')}`);
});

test('GOLDEN — no builtin child is clamped by a parent cap: every resolved cap equals the LEAF-MOST layer that sets it (templates carry the loosest bound, D-020)', () => {
  const clamped: string[] = [];
  for (const id of builtinIds()) {
    const path = builtinBlueprintPath(id);
    const { merged, layers } = resolveLayers(readYaml(path), resolveBuiltinExtends, path);
    for (const cap of CAP_LEAVES) {
      const resolved = getPath(merged, cap);
      if (resolved === undefined) continue;
      // The leaf-most layer that sets the cap is the child's declared budget.
      const authored = [...layers]
        .reverse()
        .map((l) => getPath(readYaml(l.sourcePath!), cap))
        .find((v) => v !== undefined);
      if (resolved !== authored) clamped.push(`${id} ${cap}: authored ${String(authored)} → resolved ${String(resolved)}`);
    }
  }
  assert.deepEqual(clamped, [], `a parent template tightened a child's cap — re-author the template to the loosest bound:\n  ${clamped.join('\n  ')}`);
});

// ── 2. fixtures ─────────────────────────────────────────────────────────────

test('most-restrictive — a parent-200 / child-500 maxTurns resolves to 200 either way round, and a child may still tighten (the intended flip, D-003)', () => {
  const { resolve, cleanup } = chain({
    loose: { id: 'loose', spine: { maxTurns: 500 }, knobs: { maxCostUsd: 9, parallelWorkers: { max: 8 } } },
    tight: { id: 'tight', spine: { maxTurns: 200 }, knobs: { maxCostUsd: 2, parallelWorkers: { max: 3 } } },
    tightThenLoose: { id: 'tightThenLoose', extends: ['tight', 'loose'] },
    looseThenTight: { id: 'looseThenTight', extends: ['loose', 'tight'] },
  });
  try {
    for (const id of ['tightThenLoose', 'looseThenTight']) {
      const { merged } = resolveLayers(readYaml(resolve(id)!), resolve, resolve(id));
      assert.equal(getPath(merged, 'spine.maxTurns'), 200, `${id} maxTurns`);
      assert.equal(getPath(merged, 'knobs.maxCostUsd'), 2, `${id} maxCostUsd`);
      assert.equal(getPath(merged, 'knobs.parallelWorkers.max'), 3, `${id} parallelWorkers.max`);
    }
    // A child that sets a LOOSER cap than its parent does not get it.
    const raised = resolveBlueprint({ id: 'raised', extends: 'tight', ...runnable, spine: { maxTurns: 500, edges: { DONE: { to: 'done' } } } }, { resolve });
    assert.equal(raised.blueprint.spine.maxTurns, 200, 'child cannot loosen a parent cap');
    // A child that TIGHTENS is honoured, and a cap the parent never set is the child's alone.
    const lowered = resolveBlueprint({ id: 'lowered', extends: 'tight', ...runnable, spine: { maxTurns: 30, edges: { DONE: { to: 'done' } } }, recursion: { maxDepth: 4 } }, { resolve });
    assert.equal(lowered.blueprint.spine.maxTurns, 30);
    assert.equal(lowered.blueprint.recursion?.maxDepth, 4);
  } finally {
    cleanup();
  }
});

test('slots — union across layers keyed by slot (the resolved document lists every slot the stack fills); a diamond deep-merges the restatement; two DISTINCT exclusive claimants still fail the load (D-007)', () => {
  const { resolve, cleanup } = chain({
    engA: { id: 'engA', slots: [{ slot: 'domain' }] },
    engB: { id: 'engB', slots: [{ slot: 'domain' }] },
    pracA: { id: 'pracA', slots: [{ slot: 'practice' }] },
    pracB: { id: 'pracB', extends: 'pracA', slots: [{ slot: 'practice', cardinality: 'additive' }] },
  });
  try {
    const stack = resolveBlueprint({ id: 'stack', extends: ['engA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(stack.blueprint.slots, [{ slot: 'domain' }, { slot: 'practice', cardinality: 'additive' }]);
    assert.deepEqual(stack.layers.map((l) => l.id), ['engA', 'pracA', 'pracB', 'stack']);
    const diamond = resolveBlueprint({ id: 'diamond', extends: ['pracA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(diamond.blueprint.slots, [{ slot: 'practice', cardinality: 'additive' }], 'one slot entry, the restatement merged in');
    assert.throws(
      () => resolveBlueprint({ id: 'two-domains', extends: ['engA', 'engB'], ...runnable }, { resolve }),
      /slot-exclusive-conflict: exclusive slot "domain" is claimed by 2 layers \(engA, engB\)/,
    );
    assert.deepEqual(
      Object.entries(MERGE_RULES).filter(([, r]) => r.rule === 'hard-error').map(([p]) => p),
      ['slots'],
      'slots is the only hard-error leaf, and its refusal is the stack-level check above',
    );
  } finally {
    cleanup();
  }
});

test('bundles — keyed union on [kind, ref]: a restated bundle takes the child’s fields, new bundles append (D-011)', () => {
  const base = { bundles: [{ kind: 'recipe', ref: 'a', version: '1' }, { kind: 'rubric', ref: 'r' }] };
  const child = { bundles: [{ kind: 'recipe', ref: 'a', version: '2' }, { kind: 'knowledge-pack', ref: 'k' }] };
  assert.deepEqual(mergeByRules(base, child).bundles, [
    { kind: 'recipe', ref: 'a', version: '2' },
    { kind: 'rubric', ref: 'r' },
    { kind: 'knowledge-pack', ref: 'k' },
  ]);
});

test('declaration sets (D-020) — roles union by id with field-level override; reactive / gym.signals / dependencies.* union by value; grants union', () => {
  const base = {
    roles: [{ id: 'worker', model: 'm', tools: ['a'] }, { id: 'lead' }],
    reactive: [{ role: 'worker', when: { afterRole: 'lead' } }],
    gym: { signals: ['regressionsFromTests'] },
    dependencies: { tools: ['t1', 't2'], packs: ['p'] },
    grants: { requires: ['fs'] },
  };
  const child = {
    roles: [{ id: 'worker', tools: ['b'] }, { id: 'reviewer' }],
    reactive: [{ role: 'worker', when: { afterRole: 'lead' } }, { role: 'reviewer', when: { afterRole: 'worker' } }],
    gym: { signals: ['plantedBugCaught', 'regressionsFromTests'] },
    dependencies: { tools: ['t2', 't3'] },
    grants: { requires: ['net', 'fs'] },
  };
  const m = mergeByRules(base, child);
  assert.deepEqual(m.roles, [{ id: 'worker', model: 'm', tools: ['b'] }, { id: 'lead' }, { id: 'reviewer' }], 'worker keeps model, takes the child tools; lead survives; reviewer appends');
  assert.deepEqual(m.reactive, [{ role: 'worker', when: { afterRole: 'lead' } }, { role: 'reviewer', when: { afterRole: 'worker' } }]);
  assert.deepEqual(m.gym, { signals: ['regressionsFromTests', 'plantedBugCaught'] });
  assert.deepEqual(m.dependencies, { tools: ['t1', 't2', 't3'], packs: ['p'] });
  assert.deepEqual(m.grants, { requires: ['fs', 'net'] });
});

test('params — a record unions by key and deep-merges a colliding key: byte-identical to mergeRaw (the record stays a record, D-020)', () => {
  const base = { params: { 'a.b': { label: 'x', type: 'number', min: 1 }, 'c': { label: 'c' } } };
  const child = { params: { 'a.b': { default: 5, min: 2 }, 'd': { label: 'd' } } };
  assert.deepEqual(mergeByRules(base, child).params, mergeRaw(base, child).params);
  assert.deepEqual(mergeByRules(base, child).params, {
    'a.b': { label: 'x', type: 'number', min: 2, default: 5 },
    c: { label: 'c' },
    d: { label: 'd' },
  });
});

test('interior nodes descend; a non-object child value replaces (retired: null revives); an ungoverned key composes by mergeRaw; an object-valued catchall knob replaces whole (the one declared divergence)', () => {
  const interior = schemaInteriorPaths();
  for (const p of ['knobs', 'knobs.promotion', 'knobs.promotion.smokeBuild', 'spine', 'gym.rubric', 'retired']) assert.ok(interior.has(p), `${p} is an object node`);
  for (const p of ['slots', 'knobs.maxCostUsd', 'params', 'spine.edges', 'roles']) assert.ok(!interior.has(p), `${p} is a leaf`);
  // retired: null revives — the interior node cannot be descended into null, so the child's null replaces.
  assert.deepEqual(mergeByRules({ retired: { at: '2026-01-01', reason: 'r' } }, { retired: null }), { retired: null });
  // knobs.promotion is an object node even though `knobs.*` is a catchall rule: its own leaves descend.
  assert.deepEqual(
    mergeByRules({ knobs: { promotion: { smokeBuild: { enabled: true }, a_to_b: 'x' } } }, { knobs: { promotion: { c_to_d: 'y' } } }),
    { knobs: { promotion: { smokeBuild: { enabled: true }, a_to_b: 'x', c_to_d: 'y' } } },
  );
  // A key outside the schema entirely composes as it always did.
  assert.equal(mergeRuleFor('visibility'), null);
  assert.deepEqual(mergeByRules({ visibility: { a: 1 } }, { visibility: { b: 2 } }), { visibility: { a: 1, b: 2 } });
  // A forward-unknown knob is opaque to the schema: `knobs.*` is `replace`, so the child's object wins whole.
  assert.equal(mergeRuleFor('knobs.someUnknownKnob')?.rule, 'replace');
  assert.deepEqual(mergeByRules({ knobs: { someUnknownKnob: { a: 1 } } }, { knobs: { someUnknownKnob: { b: 2 } } }), { knobs: { someUnknownKnob: { b: 2 } } });
  // Inputs are never mutated.
  const base = { roles: [{ id: 'w' }], knobs: { logRetention: 1 } };
  const snapshot = stableStringify(base);
  mergeByRules(base, { roles: [{ id: 'x' }], knobs: { logRetention: 2 } });
  assert.equal(stableStringify(base), snapshot);
});

// ── 3. properties ───────────────────────────────────────────────────────────

const asSet = (xs: readonly unknown[]): string[] => [...new Set(xs.map(stableStringify))].sort();
const REPLACE: MergeRule = { rule: 'replace' };
const UNION: MergeRule = { rule: 'union' };
const CAP: MergeRule = { rule: 'most-restrictive' };

test('property — union by value is commutative and idempotent as a set, and [] is its identity', () => {
  fc.assert(
    fc.property(fc.array(fc.string()), fc.array(fc.string()), (a, b) => {
      assert.deepEqual(asSet(unionArrays(a, b)), asSet(unionArrays(b, a)), 'commutative');
      assert.deepEqual(asSet(unionArrays(a, b)), asSet([...a, ...b]), 'it IS the set union, not the last writer');
      assert.deepEqual(unionArrays(a, a), unionArrays(a, []), 'idempotent');
      assert.deepEqual(asSet(unionArrays(a, [])), asSet(a), 'identity');
      assert.deepEqual(applyMergeRule(UNION, a, b), unionArrays(a, b), 'the rule dispatches to the array union');
    }),
  );
});

test('property — keyed union: the key set is commutative + idempotent, and the child’s fields win on a colliding key', () => {
  // fast-check 4 generates null-prototype objects by default; the merger normalizes a merged
  // element to a plain object, so idempotence is compared STRUCTURALLY (stableStringify), not
  // by prototype — which is the identity the algebra is about.
  const bundle = fc.record({ kind: fc.constantFrom('recipe', 'rubric'), ref: fc.stringMatching(/^[a-z]{1,3}$/), version: fc.nat(9) }, { noNullPrototype: true });
  const key = ['kind', 'ref'] as const;
  const keysOf = (xs: readonly unknown[]) => asSet(xs.map((e) => [(e as RawDocument).kind, (e as RawDocument).ref]));
  fc.assert(
    fc.property(fc.array(bundle), fc.array(bundle), (a, b) => {
      const ab = unionArrays(a, b, key) as RawDocument[];
      assert.deepEqual(keysOf(ab), keysOf(unionArrays(b, a, key)), 'commutative key set');
      assert.deepEqual(keysOf(ab), keysOf([...a, ...b]), 'every key from both sides, once');
      assert.equal(new Set(ab.map((e) => `${e.kind}/${e.ref}`)).size, ab.length, 'no duplicate keys');
      assert.equal(stableStringify(unionArrays(a, a, key)), stableStringify(unionArrays(a, [], key)), 'idempotent');
      for (const e of b) {
        const got = ab.find((x) => x.kind === e.kind && x.ref === e.ref);
        assert.deepEqual(got?.version, e.version, 'the child’s (later) version wins on its key');
      }
    }),
  );
});

test('property — most-restrictive is commutative, idempotent, and equals min; through the full document merger too', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (a, b) => {
      assert.equal(mostRestrictive(a, b), Math.min(a, b));
      assert.equal(mostRestrictive(a, b), mostRestrictive(b, a), 'commutative');
      assert.equal(mostRestrictive(a, a), a, 'idempotent');
      assert.equal(applyMergeRule(CAP, a, b), Math.min(a, b));
      const ab = mergeByRules({ spine: { maxTurns: a }, dispatch: { safetyCeiling: a } }, { spine: { maxTurns: b }, dispatch: { safetyCeiling: b } });
      const ba = mergeByRules({ spine: { maxTurns: b }, dispatch: { safetyCeiling: b } }, { spine: { maxTurns: a }, dispatch: { safetyCeiling: a } });
      assert.deepEqual(ab, ba);
      assert.deepEqual(ab, { spine: { maxTurns: Math.min(a, b) }, dispatch: { safetyCeiling: Math.min(a, b) } });
    }),
  );
});

test('property — replace is order-dependent by design: the later layer wins, and swapping the order swaps the result', () => {
  fc.assert(
    fc.property(fc.integer(), fc.integer(), (a, b) => {
      fc.pre(a !== b);
      assert.equal(applyMergeRule(REPLACE, a, b), b);
      assert.equal(applyMergeRule(REPLACE, b, a), a);
      assert.equal(mergeByRules({ knobs: { logRetention: a } }, { knobs: { logRetention: b } }).knobs && getPath(mergeByRules({ knobs: { logRetention: a } }, { knobs: { logRetention: b } }), 'knobs.logRetention'), b);
      assert.equal(getPath(mergeByRules({ knobs: { logRetention: b } }, { knobs: { logRetention: a } }), 'knobs.logRetention'), a);
    }),
  );
});

test('property — {} is the identity of mergeByRules on both sides, and an absent child key inherits under every rule', () => {
  const doc = fc.dictionary(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}$/), fc.jsonValue(), { maxKeys: 6, noNullPrototype: true });
  fc.assert(
    fc.property(doc, (d) => {
      // Structural identity (see the keyed-union property for why not prototype identity).
      assert.equal(stableStringify(mergeByRules(d, {})), stableStringify(d));
      assert.equal(stableStringify(mergeByRules({}, d)), stableStringify(d));
    }),
  );
  for (const rule of [REPLACE, UNION, CAP, { rule: 'hard-error', key: 'slot' } as MergeRule]) {
    assert.equal(applyMergeRule(rule, 7, undefined), undefined, `${rule.rule}: an explicitly-undefined child is carried as mergeRaw carries it`);
    assert.equal(applyMergeRule(rule, undefined, 7), 7, `${rule.rule}: an absent base takes the child`);
  }
});
