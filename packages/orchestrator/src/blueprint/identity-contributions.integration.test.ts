import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileAgentSpecification,
  replayAgentSpecification,
  specificationPrompt,
} from './composition-compiler.js';

describe('fixed and generated identity contributions through a real source package', () => {
  it('pins deterministic prompt order and supplier provenance, then refuses missing current content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-contribution-integration-'));
    const sourcePath = join(dir, 'blueprint.yaml');
    const fixedPath = join(dir, 'prompts', 'rules.md');
    const providerRef = 'existing.task-brief';
    const taskText = 'Generated task brief from the current turn.';
    try {
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(fixedPath, 'Fixed reusable rules.');
      writeFileSync(sourcePath, [
        'id: generic-react-identity',
        'version: 1.0.0',
        'slots: [{ slot: domain }]',
        'workItem: { kind: feature }',
        'spine: { edges: { DONE: { to: done } } }',
        'contributions:',
        '  - { id: rules, purpose: prompt, source: fixed, refresh: source-change, inputKind: prompt-file, ref: "fixed:rules" }',
        '  - { id: task, purpose: prompt, source: provider, refresh: turn, inputKind: prompt-file, ref: "provider:task", producerRef: "existing.task-brief" }',
      ].join('\n'));
      const input = {
        sourcePath,
        prompt: { files: [{ path: fixedPath, ref: 'fixed:rules' }] },
        inputClosure: [{ kind: 'prompt-file' as const, ref: 'provider:task', producerRef: providerRef,
          bytes: taskText, contentHash: createHash('sha256').update(taskText).digest('hex') }],
      };
      const first = compileAgentSpecification(input);
      const second = compileAgentSpecification(input);
      expect(second.specificationRevision).toBe(first.specificationRevision);
      const rendered = specificationPrompt(first);
      expect(rendered.indexOf('Fixed reusable rules.')).toBeLessThan(rendered.indexOf(taskText));
      expect(first.provenance.find((row) => row.path === 'contribution.rules'))
        .toMatchObject({ sourceRef: 'prompt-file:fixed:rules', decision: 'fixed:source-change' });
      expect(first.provenance.find((row) => row.path === 'contribution.task'))
        .toMatchObject({ sourceRef: 'prompt-file:provider:task', producerRef: providerRef, decision: 'provider:turn' });
      expect(first.inputs.find((row) => row.kind === 'blueprint-layer' && row.ref === 'generic-react-identity'))
        .toHaveProperty('document.contributions');
      expect(() => compileAgentSpecification({ ...input, inputClosure: [] }))
        .toThrow(/contribution-missing.*task:prompt-file:provider:task/);
      rmSync(fixedPath);
      expect(() => compileAgentSpecification(input)).toThrow(/prompt-missing.*fixed:rules/);
      expect(readFileSync(sourcePath, 'utf8')).toContain('generic-react-identity');
      expect(replayAgentSpecification(JSON.parse(JSON.stringify(first)))).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
