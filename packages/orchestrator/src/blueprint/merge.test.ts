/**
 * identities-v1-2026-08-30 P-019/P-039 — the MERGE_RULES-driven merger
 * (`merge.ts`) and its wiring into `resolveLayers`. Three evidence families:
 *
 *   1. GOLDEN — every builtin blueprint resolves to the SAME document under the
 *      rule-driven walk and under the pre-P-019 `mergeRaw` walk (same graph shape),
 *      so the registry's default assignment really is byte-equivalent, and the
 *      declared deviations moved no builtin (D-020 re-authored the
 *      one template whose children raised a cap rather than clamp them).
 *   2. FIXTURES for each declared deviation — the cap flip a parent-200 / child-500
 *      `maxTurns` → 200 asserted explicitly; set union, keyed overlay, replacement,
 *      intersection, and hard conflict each have resolved-value assertions.
 *   3. fast-check PROPERTIES where the rule is algebraic: set union is commutative
 *      + idempotent; constraint intersection is commutative; keyed-overlay values
 *      and explicit replacement are order-dependent by design.
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
  MergeConflictError,
  setUnionArrays,
  keyedOverlayArrays,
  intersectConstraint,
  schemaInteriorPaths,
  stableStringify,
  isPlainObject,
  type RawDocument,
} from './merge.js';
import {
  resolveLayers,
  resolveBlueprint,
  resolveBuiltinExtends,
  builtinBlueprintPath,
  type ResolveExtendsPath,
} from './loader.js';

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
  .filter(([, r]) => r.rule === 'constraint-intersection')
  .map(([p]) => p);
const getPath = (doc: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (cur, seg) => (typeof cur === 'object' && cur !== null ? (cur as RawDocument)[seg] : undefined),
      doc,
    );

// ── 1. golden ───────────────────────────────────────────────────────────────

test('GOLDEN — historical builtins keep pre-P-019 bytes; the new named SU composition intentionally accumulates slots', () => {
  const ids = builtinIds();
  assert.ok(ids.length >= 45, `expected the full builtin set, got ${ids.length}`);
  for (const must of ['base', 'coding', 'single-agent', 'papercusp-engineer', 'su-collaborator']) {
    assert.ok(ids.includes(must), `builtin ${must} missing from the golden population`);
  }
  const diffs: string[] = [];
  for (const id of ids.filter((entry) => entry !== 'su')) {
    const path = builtinBlueprintPath(id);
    const byRules = resolveLayers(readYaml(path), resolveBuiltinExtends, path).merged;
    const byRaw = resolveWithMergeRaw(readYaml(path), resolveBuiltinExtends);
    const d = firstDiff(byRules, byRaw);
    if (d) diffs.push(`${id} @ ${d}`);
  }
  assert.deepEqual(
    diffs,
    [],
    `builtin blueprints whose resolved document CHANGED under MERGE_RULES:\n  ${diffs.join('\n  ')}`,
  );
  const suPath = builtinBlueprintPath('su');
  const suRules = resolveLayers(readYaml(suPath), resolveBuiltinExtends, suPath).merged;
  const suRaw = resolveWithMergeRaw(readYaml(suPath), resolveBuiltinExtends);
  assert.deepEqual((suRules.slots as Array<{ slot: string }>).map((entry) => entry.slot),
    ['domain', 'collaboration-stance', 'practice'],
    'the named SU root keeps its selected parent identities under the declared slot merge rule');
  assert.deepEqual(suRaw.slots, [], 'the historical array-replace rule would erase every parent slot');
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
      if (resolved !== authored)
        clamped.push(`${id} ${cap}: authored ${String(authored)} → resolved ${String(resolved)}`);
    }
  }
  assert.deepEqual(
    clamped,
    [],
    `a parent template tightened a child's cap — re-author the template to the loosest bound:\n  ${clamped.join('\n  ')}`,
  );
});

// ── 2. fixtures ─────────────────────────────────────────────────────────────

test('constraint intersection — a parent-200 / child-500 maxTurns resolves to 200 either way round, and a child may still tighten (D-003/D-029)', () => {
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
    const raised = resolveBlueprint(
      { id: 'raised', extends: 'tight', ...runnable, spine: { maxTurns: 500, edges: { DONE: { to: 'done' } } } },
      { resolve },
    );
    assert.equal(raised.blueprint.spine.maxTurns, 200, 'child cannot loosen a parent cap');
    // A child that TIGHTENS is honoured, and a cap the parent never set is the child's alone.
    const lowered = resolveBlueprint(
      {
        id: 'lowered',
        extends: 'tight',
        ...runnable,
        spine: { maxTurns: 30, edges: { DONE: { to: 'done' } } },
        recursion: { maxDepth: 4 },
      },
      { resolve },
    );
    assert.equal(lowered.blueprint.spine.maxTurns, 30);
    assert.equal(lowered.blueprint.recursion?.maxDepth, 4);
  } finally {
    cleanup();
  }
});

test('constraint intersection — non-comparable policies fail closed and distinguish peer assembly from inheritance with source provenance (D-029)', () => {
  const rejects =
    (mode: 'peer-assembly' | 'inheritance', sources: readonly string[]) =>
    (error: unknown): boolean => {
      assert.ok(error instanceof MergeConflictError);
      assert.equal(error.path, 'knobs.maxCostUsd');
      assert.equal(error.rule, 'constraint-intersection');
      assert.equal(error.context.mode, mode);
      assert.deepEqual([...(error.context.baseSources ?? []), ...(error.context.childSources ?? [])], sources);
      assert.match(error.message, new RegExp(`during ${mode}`));
      for (const source of sources) assert.match(error.message, new RegExp(source));
      return true;
    };
  assert.throws(
    () =>
      mergeByRules(
        { knobs: { maxCostUsd: 'bounded' } },
        { knobs: { maxCostUsd: 'unlimited' } },
        { mode: 'peer-assembly', baseSources: ['policy-a'], childSources: ['policy-b'] },
      ),
    rejects('peer-assembly', ['policy-a', 'policy-b']),
  );
  assert.throws(
    () =>
      mergeByRules(
        { knobs: { maxCostUsd: 'bounded' } },
        { knobs: { maxCostUsd: 'unlimited' } },
        { mode: 'inheritance', baseSources: ['policy-a'], childSources: ['child-root'] },
      ),
    rejects('inheritance', ['policy-a', 'child-root']),
  );
});

test('slots — keyed declarations retain every slot; a diamond deep-merges the restatement; two DISTINCT exclusive claimants still fail the load (D-007)', () => {
  const { resolve, cleanup } = chain({
    engA: { id: 'engA', slots: [{ slot: 'domain' }] },
    engB: { id: 'engB', slots: [{ slot: 'domain' }] },
    pracA: { id: 'pracA', slots: [{ slot: 'practice' }] },
    pracB: { id: 'pracB', extends: 'pracA', slots: [{ slot: 'practice', cardinality: 'additive' }] },
  });
  try {
    const stack = resolveBlueprint({ id: 'stack', extends: ['engA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(stack.blueprint.slots, [{ slot: 'domain' }, { slot: 'practice', cardinality: 'additive' }]);
    assert.deepEqual(
      stack.layers.map((l) => l.id),
      ['engA', 'pracA', 'pracB', 'stack'],
    );
    const diamond = resolveBlueprint({ id: 'diamond', extends: ['pracA', 'pracB'], ...runnable }, { resolve });
    assert.deepEqual(
      diamond.blueprint.slots,
      [{ slot: 'practice', cardinality: 'additive' }],
      'one slot entry, the restatement merged in',
    );
    assert.throws(
      () => resolveBlueprint({ id: 'two-domains', extends: ['engA', 'engB'], ...runnable }, { resolve }),
      /slot-exclusive-conflict: exclusive slot "domain" is claimed by 2 layers \(engA, engB\)/,
    );
    assert.deepEqual(
      Object.entries(MERGE_RULES)
        .filter(([, r]) => r.rule === 'hard-conflict')
        .map(([p]) => p),
      ['slots'],
      'slots is the only hard-conflict leaf, and its refusal is the stack-level check above',
    );
  } finally {
    cleanup();
  }
});

test('bundles — keyed overlay on [kind, ref]: a restated bundle overlays fields and new bundles append; exact-pin acceptance remains loader-level (D-029)', () => {
  const base = {
    bundles: [
      { kind: 'recipe', ref: 'a' },
      { kind: 'rubric', ref: 'r' },
    ],
  };
  const child = {
    bundles: [
      { kind: 'recipe', ref: 'a', version: '2' },
      { kind: 'knowledge-pack', ref: 'k' },
    ],
  };
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
    reactive: [
      { role: 'worker', when: { afterRole: 'lead' } },
      { role: 'reviewer', when: { afterRole: 'worker' } },
    ],
    gym: { signals: ['plantedBugCaught', 'regressionsFromTests'] },
    dependencies: { tools: ['t2', 't3'] },
    grants: { requires: ['net', 'fs'] },
  };
  const m = mergeByRules(base, child);
  assert.deepEqual(
    m.roles,
    [{ id: 'worker', model: 'm', tools: ['b'] }, { id: 'lead' }, { id: 'reviewer' }],
    'worker keeps model, takes the child tools; lead survives; reviewer appends',
  );
  assert.deepEqual(m.reactive, [
    { role: 'worker', when: { afterRole: 'lead' } },
    { role: 'reviewer', when: { afterRole: 'worker' } },
  ]);
  assert.deepEqual(m.gym, { signals: ['regressionsFromTests', 'plantedBugCaught'] });
  assert.deepEqual(m.dependencies, { tools: ['t1', 't2', 't3'], packs: ['p'] });
  assert.deepEqual(m.grants, { requires: ['fs', 'net'] });
});

test('removals are operation-specific — empty set/keyed arrays cannot erase contributors, while explicit replacement can author an empty value', () => {
  const merged = mergeByRules(
    {
      roles: [{ id: 'worker', tools: ['read'] }],
      dependencies: { tools: ['search'] },
      ops: ['deploy'],
    },
    { roles: [], dependencies: { tools: [] }, ops: [] },
  );
  assert.deepEqual(merged.roles, [{ id: 'worker', tools: ['read'] }], 'empty keyed overlay is not a deletion');
  assert.deepEqual(merged.dependencies, { tools: ['search'] }, 'empty set union is not a deletion');
  assert.deepEqual(merged.ops, [], 'an explicitly replaced array can be emptied');
});

test('keyed record overlays preserve nested sibling fields and replace only authored leaves (actual resolved values, D-029)', () => {
  const base = { params: { 'a.b': { label: 'x', type: 'number', min: 1 }, c: { label: 'c' } } };
  const child = { params: { 'a.b': { default: 5, min: 2 }, d: { label: 'd' } } };
  assert.deepEqual(mergeByRules(base, child).params, mergeRaw(base, child).params);
  assert.deepEqual(mergeByRules(base, child).params, {
    'a.b': { label: 'x', type: 'number', min: 2, default: 5 },
    c: { label: 'c' },
    d: { label: 'd' },
  });
  assert.deepEqual(
    mergeByRules(
      { spine: { edges: { RUN: { to: 'role', role: 'worker', extras: ['base'] }, DONE: { to: 'done' } } } },
      { spine: { edges: { RUN: { extras: ['child'] }, REVIEW: { to: 'role', role: 'reviewer' } } } },
    ),
    {
      spine: {
        edges: {
          RUN: { to: 'role', role: 'worker', extras: ['child'] },
          DONE: { to: 'done' },
          REVIEW: { to: 'role', role: 'reviewer' },
        },
      },
    },
  );
});

test('interior nodes descend; a non-object child value replaces (retired: null revives); an ungoverned key composes by mergeRaw; an object-valued catchall knob replaces whole (the one declared divergence)', () => {
  const interior = schemaInteriorPaths();
  for (const p of ['knobs', 'knobs.promotion', 'knobs.promotion.smokeBuild', 'spine', 'gym.rubric', 'retired'])
    assert.ok(interior.has(p), `${p} is an object node`);
  for (const p of ['slots', 'knobs.maxCostUsd', 'params', 'spine.edges', 'roles'])
    assert.ok(!interior.has(p), `${p} is a leaf`);
  // retired: null revives — the interior node cannot be descended into null, so the child's null replaces.
  assert.deepEqual(mergeByRules({ retired: { at: '2026-01-01', reason: 'r' } }, { retired: null }), { retired: null });
  // knobs.promotion is an object node even though `knobs.*` is a catchall rule: its own leaves descend.
  assert.deepEqual(
    mergeByRules(
      { knobs: { promotion: { smokeBuild: { enabled: true }, a_to_b: 'x' } } },
      { knobs: { promotion: { c_to_d: 'y' } } },
    ),
    { knobs: { promotion: { smokeBuild: { enabled: true }, a_to_b: 'x', c_to_d: 'y' } } },
  );
  // A key outside the schema entirely composes as it always did.
  assert.equal(mergeRuleFor('visibility'), null);
  assert.deepEqual(mergeByRules({ visibility: { a: 1 } }, { visibility: { b: 2 } }), { visibility: { a: 1, b: 2 } });
  // A forward-unknown knob is opaque to the schema: `knobs.*` is explicit replacement, so the child's object wins whole.
  assert.equal(mergeRuleFor('knobs.someUnknownKnob')?.rule, 'explicit-replacement');
  assert.deepEqual(mergeByRules({ knobs: { someUnknownKnob: { a: 1 } } }, { knobs: { someUnknownKnob: { b: 2 } } }), {
    knobs: { someUnknownKnob: { b: 2 } },
  });
  // Inputs are never mutated.
  const base = { roles: [{ id: 'w' }], knobs: { logRetention: 1 } };
  const snapshot = stableStringify(base);
  mergeByRules(base, { roles: [{ id: 'x' }], knobs: { logRetention: 2 } });
  assert.equal(stableStringify(base), snapshot);
});

// ── 3. properties ───────────────────────────────────────────────────────────

const asSet = (xs: readonly unknown[]): string[] => [...new Set(xs.map(stableStringify))].sort();
const REPLACE: MergeRule = { rule: 'explicit-replacement' };
const UNION: MergeRule = { rule: 'set-union' };
const OVERLAY: MergeRule = { rule: 'keyed-overlay' };
const CAP: MergeRule = { rule: 'constraint-intersection' };

test('property — set union is commutative and idempotent as a set, and [] is its identity', () => {
  fc.assert(
    fc.property(fc.array(fc.string()), fc.array(fc.string()), (a, b) => {
      assert.deepEqual(asSet(setUnionArrays(a, b)), asSet(setUnionArrays(b, a)), 'commutative');
      assert.deepEqual(asSet(setUnionArrays(a, b)), asSet([...a, ...b]), 'it IS the set union, not the last writer');
      assert.deepEqual(setUnionArrays(a, a), setUnionArrays(a, []), 'idempotent');
      assert.deepEqual(asSet(setUnionArrays(a, [])), asSet(a), 'identity');
      assert.deepEqual(applyMergeRule(UNION, a, b), setUnionArrays(a, b), 'the rule dispatches to the array union');
    }),
  );
});

test('property — keyed overlay retains every key and resolves every colliding value by ordered deep overlay', () => {
  // fast-check 4 generates null-prototype objects by default; the merger normalizes a merged
  // element to a plain object, so idempotence is compared STRUCTURALLY (stableStringify), not
  // by prototype — which is the identity the algebra is about.
  const bundle = fc.record(
    { kind: fc.constantFrom('recipe', 'rubric'), ref: fc.stringMatching(/^[a-z]{1,3}$/), version: fc.nat(9) },
    { noNullPrototype: true },
  );
  const key = ['kind', 'ref'] as const;
  const keysOf = (xs: readonly unknown[]) => asSet(xs.map((e) => [(e as RawDocument).kind, (e as RawDocument).ref]));
  fc.assert(
    fc.property(fc.array(bundle), fc.array(bundle), (a, b) => {
      const ab = keyedOverlayArrays(a, b, key) as RawDocument[];
      assert.deepEqual(keysOf(ab), keysOf(keyedOverlayArrays(b, a, key)), 'commutative key set');
      assert.deepEqual(keysOf(ab), keysOf([...a, ...b]), 'every key from both sides, once');
      assert.equal(new Set(ab.map((e) => `${e.kind}/${e.ref}`)).size, ab.length, 'no duplicate keys');
      assert.equal(
        stableStringify(keyedOverlayArrays(a, a, key)),
        stableStringify(keyedOverlayArrays(a, [], key)),
        'idempotent',
      );
      // The LAST child element for a key wins (a duplicate key inside `b` collapses to its later entry).
      const lastByKey = new Map<string, RawDocument>();
      for (const e of b) lastByKey.set(`${e.kind}/${e.ref}`, e);
      for (const [k, e] of lastByKey) {
        const got = ab.find((x) => `${x.kind}/${x.ref}` === k);
        assert.deepEqual(got?.version, e.version, 'the child’s (later) version wins on its key');
      }
      const expectedByKey = new Map<string, RawDocument>();
      for (const e of [...a, ...b]) {
        const k = `${e.kind}/${e.ref}`;
        const previous = expectedByKey.get(k);
        expectedByKey.set(k, previous ? mergeRaw(previous, e) : e);
      }
      for (const [k, expected] of expectedByKey) {
        const got = ab.find((value) => `${value.kind}/${value.ref}` === k);
        assert.equal(stableStringify(got), stableStringify(expected), `${k}: actual resolved value`);
      }
    }),
  );
});

test('property — numeric constraint intersection is commutative, idempotent, and equals min; through the full merger too', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (a, b) => {
      assert.equal(intersectConstraint(a, b), Math.min(a, b));
      assert.equal(intersectConstraint(a, b), intersectConstraint(b, a), 'commutative');
      assert.equal(intersectConstraint(a, a), a, 'idempotent');
      assert.equal(applyMergeRule(CAP, a, b), Math.min(a, b));
      const ab = mergeByRules(
        { spine: { maxTurns: a }, dispatch: { safetyCeiling: a } },
        { spine: { maxTurns: b }, dispatch: { safetyCeiling: b } },
      );
      const ba = mergeByRules(
        { spine: { maxTurns: b }, dispatch: { safetyCeiling: b } },
        { spine: { maxTurns: a }, dispatch: { safetyCeiling: a } },
      );
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
      assert.equal(
        mergeByRules({ knobs: { logRetention: a } }, { knobs: { logRetention: b } }).knobs &&
          getPath(mergeByRules({ knobs: { logRetention: a } }, { knobs: { logRetention: b } }), 'knobs.logRetention'),
        b,
      );
      assert.equal(
        getPath(mergeByRules({ knobs: { logRetention: b } }, { knobs: { logRetention: a } }), 'knobs.logRetention'),
        a,
      );
    }),
  );
});

test('property — {} is the identity of mergeByRules on both sides, and an absent child key inherits under every rule', () => {
  const doc = fc.dictionary(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}$/), fc.jsonValue(), {
    maxKeys: 6,
    noNullPrototype: true,
  });
  fc.assert(
    fc.property(doc, (d) => {
      // Structural identity (see the keyed-union property for why not prototype identity).
      assert.equal(stableStringify(mergeByRules(d, {})), stableStringify(d));
      assert.equal(stableStringify(mergeByRules({}, d)), stableStringify(d));
    }),
  );
  for (const rule of [REPLACE, UNION, OVERLAY, CAP, { rule: 'hard-conflict', key: 'slot' } as MergeRule]) {
    assert.equal(
      applyMergeRule(rule, 7, undefined),
      undefined,
      `${rule.rule}: an explicitly-undefined child is carried as mergeRaw carries it`,
    );
    assert.equal(applyMergeRule(rule, undefined, 7), 7, `${rule.rule}: an absent base takes the child`);
  }
});

/**
 * WI-10008284: stableStringify's bytes are a HASH INPUT (every stored
 * specificationRevision is sha256 of them), so the single-pass implementation must
 * stay byte-identical to the original recursive form. That form is kept HERE as the
 * oracle; a divergence on any input — a key order, a quirk — fails this test.
 */
function stableStringifyOracle(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringifyOracle).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringifyOracle(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

test('stableStringify: byte-identical to the recursive oracle on arbitrary JSON-ish values', () => {
  fc.assert(
    fc.property(
      fc.anything({
        withNullPrototype: true,
        withObjectString: true,
        withDate: true,
        withSparseArray: true,
        withBigInt: false,
        maxDepth: 6,
      }),
      (value) => {
        assert.equal(stableStringify(value), stableStringifyOracle(value));
      },
    ),
    { numRuns: 500 },
  );
});

test('stableStringify: preserves the recursive form\'s quirks exactly', () => {
  const cases: unknown[] = [
    { a: undefined }, // bare word `undefined` inside an object
    [undefined, 1], // an undefined element renders as nothing
    [1, undefined],
    [() => 1, 'x'],
    { d: new Date(0) }, // a Date renders by its (zero) enumerable keys
    { f: () => 1 },
    { b: [{}, []], a: { y: 1, x: [2, { z: null }] }, 'é': true, 'A': 0 },
    'x',
    0,
    null,
    true,
  ];
  for (const value of cases) assert.equal(stableStringify(value), stableStringifyOracle(value));
  assert.equal(stableStringify(undefined), undefined);
  assert.equal(stableStringify(() => 1), undefined);
});
