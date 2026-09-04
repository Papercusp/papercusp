/**
 * P-033 — duplicate blueprint declaration sites fail at the semantic validator,
 * with the error naming the site that actually has authority/enforcement.
 */
import { describe, expect, test } from 'vitest';
import { BlueprintSchema } from './schema.js';
import { validateBlueprint } from './validate.js';

const base = {
  id: 'declaration-authority-test',
  workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: { claimModel: 'self-claim-priority', default: { to: 'idle' as const } },
};

function validate(doc: Record<string, unknown>) {
  return validateBlueprint(BlueprintSchema.parse({ ...base, ...doc }));
}

describe('blueprint declaration authority', () => {
  test('the role prompt is the persona authority; a blueprint prompt override cannot restate it', () => {
    const result = validate({
      roles: [{ id: 'worker', prompt: 'prompts/custom-worker.md' }],
      knobs: { promptOverrides: { worker: 'A second persona body.' } },
    });

    const issue = result.errors.find((candidate) => candidate.code === 'duplicate-persona-authority');
    expect(issue?.message).toContain('roles[].prompt is the authored persona authority');
    expect(issue?.message).toContain('instance/experiment specialization');
  });

  test('top-level dependencies are authoritative over role-local advisory hints', () => {
    const result = validate({ roles: [{ id: 'worker', tools: ['plans:get'] }] });

    const issue = result.errors.find((candidate) => candidate.code === 'role-dependency-authority');
    expect(issue?.message).toContain('dependencies.tools is the single import-time authority');
    expect(issue?.message).toContain('ENFORCED allow-list');
  });

  test('the fleet capability list is explicitly the enforced authority', () => {
    const result = validate({
      roles: [{ id: 'worker', capabilities: ['plans:read'] }],
      fleet: { workerRoles: [{ id: 'worker', capabilities: ['coord:send'] }] },
    });

    const issue = result.errors.find((candidate) => candidate.code === 'duplicate-capability-authority');
    expect(issue?.message).toContain('fleet.workerRoles[].capabilities is the ENFORCED allow-list');
    expect(issue?.message).toContain('dependencies.tools');
  });

  test('knowledge.pack is the single seed-pack authority', () => {
    const duplicate = validate({ knowledge: { pack: 'coding' }, learning: { pack: 'legacy' } });
    expect(duplicate.errors.find((candidate) => candidate.code === 'duplicate-knowledge-pack-authority')?.message).toContain(
      'knowledge.pack is authoritative',
    );

    const legacyOnly = validate({ learning: { pack: 'legacy' } });
    expect(legacyOnly.ok).toBe(true);
    expect(legacyOnly.warnings.find((candidate) => candidate.code === 'deprecated-learning-pack')?.message).toContain(
      'read-side compatibility key',
    );
  });

  test('acceptance and gym rubrics cannot silently restate one rubric', () => {
    const result = validate({
      gym: { rubric: { dimensions: { quality: 'optimizer score' } } },
      acceptance: { kind: 'judge', rubric: { dimensions: { quality: 'completion score' } } },
    });

    const issue = result.errors.find((candidate) => candidate.code === 'duplicate-rubric-authority');
    expect(issue?.message).toContain('acceptance.rubric ENFORCES completion');
    expect(issue?.message).toContain('gym.rubric scores optimizer trials');
  });

  test('one declaration per fact remains valid', () => {
    const result = validate({
      roles: [{ id: 'worker', prompt: 'prompts/worker.md' }],
      dependencies: { tools: ['plans:get'] },
      fleet: { workerRoles: [{ id: 'worker', capabilities: ['coord:send'] }] },
      knowledge: { pack: 'coding' },
      acceptance: { kind: 'judge', rubric: { dimensions: { quality: 'completion score' } } },
    });

    expect(result.errors).toEqual([]);
  });
});
