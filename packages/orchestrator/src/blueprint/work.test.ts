/**
 * hive-blueprint-generalization P-020 — the `generic-hive` blueprint loads,
 * resolves (`extends: hive`), validates clean, and carries the full non-coding
 * DOMAIN PROFILE: judge acceptance, artifacts output, topic-overlap affinity, and
 * the research/review/vote member-blueprint dependencies. The unit-level proof that
 * a non-coding hive is a pure declaration on the same engine (the LIVE smoke that a
 * generic-hive reaches DONE repo-less is P-021).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from './loader.js';
import { resolvePromptFile } from '../prompt-resolve.js';
import { harnessPath } from '@papercusp/harness/paths';

test('generic-hive blueprint loads + validates with no errors', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('work');
  assert.equal(blueprint.id, 'work');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
});

test('generic-hive carries the non-coding domain profile (acceptance/output/affinity)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('work');
  // The three domain-profile knobs that de-code the hive (P-009/010/011):
  assert.equal(bp.acceptance?.kind, 'judge', 'done = a rubric judge verdict, not a test pass');
  assert.equal(bp.output?.kind, 'artifacts', 'deliverables land in the artifacts store, not a repo commit');
  assert.equal(bp.affinity?.kind, 'topic-overlap', 'the Queen co-locates by subject, not files');
});

test('generic-hive declares its work-blueprint dependencies (the member pipelines its bees spawn)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('work');
  const deps = bp.dependencies?.blueprints ?? [];
  for (const member of ['research', 'review', 'vote']) {
    assert.ok(deps.includes(member), `generic-hive must declare the "${member}" member blueprint (install-closure / P-017)`);
  }
});

test('generic-hive resolves its own mug/judge/documenter personas (then falls through to base)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('work');
  // The roles generic-hive specializes ship in its own prompts dir.
  for (const role of ['mug', 'judge', 'documenter']) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'work' },
      role,
    );
    assert.ok(found, `generic-hive role "${role}" must resolve (its own prompts dir or the inherited base)`);
    assert.ok(
      found!.includes('work'),
      `generic-hive specializes "${role}" — expected its own override, got ${found}`,
    );
  }
});

test('every generic-hive role has a resolvable prompt (inherited bee included)', () => {
  const { blueprint: bp } = loadBuiltinBlueprint('work');
  for (const role of bp.roles) {
    const found = resolvePromptFile(
      { harnessDir: harnessPath(), phase: '', dept: '', blueprintId: 'work' },
      role.id,
    );
    assert.ok(found, `missing prompt for generic-hive role "${role.id}" (blueprints/generic-hive or its extends-chain to base)`);
  }
});
