import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  COMPOSITION_COMPILER_VERSION,
  CompositionCompilerError,
  compileAgentSpecification,
  compileStackSpecification,
  operationFromSpecification,
  specificationPrompt,
} from './composition-compiler.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'composition-compiler-'));
  const basePath = join(dir, 'base.yaml');
  const promptDir = join(dir, 'blueprints', 'base', 'prompts');
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(
    basePath,
    [
      'id: base',
      'version: 1.0.0',
      'knobs:',
      '  logRetention: 10',
      'workItem:',
      '  kind: feature',
      'spine:',
      '  edges:',
      '    DONE:',
      '      to: done',
      '',
    ].join('\n'),
  );
  writeFileSync(join(promptDir, 'worker.md'), 'Base worker prompt.\n');
  const resolve = (id: string): string | null => (id === 'base' ? basePath : null);
  return { dir, basePath, promptDir, resolve, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rootSource() {
  return {
    id: 'runtime',
    extends: 'base',
    description: 'runtime blueprint',
    knobs: { maxCostUsd: 2 },
    workItem: { kind: 'feature' },
    spine: { edges: { DONE: { to: 'done' } } },
  };
}

test('P-038 compiler snapshots the resolved blueprint, prompt bytes, closure and provenance deterministically', () => {
  const f = fixture();
  try {
    const input = {
      source: rootSource(),
      resolve: f.resolve,
      harnessDir: f.dir,
      prompt: { role: 'worker' },
      addressedDocuments: {
        revision: 7,
        parts: [{ partKey: 'worker-guide', body: 'Use the fixture safely.', targetSection: 'Runtime' }],
      },
      settings: [{ ref: 'mode', revision: '41', value: { enabled: true } }],
    } as const;
    const a = compileAgentSpecification(input);
    const b = compileAgentSpecification(input);

    assert.deepEqual(a, b, 'same inputs produce byte-identical structured artifacts');
    assert.equal(a.compilerVersion, COMPOSITION_COMPILER_VERSION);
    assert.match(a.specificationRevision, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(a), true);
    assert.equal(Object.isFrozen(a.configuration), true);
    assert.equal(Object.isFrozen(a.inputs), true);
    assert.equal(Object.isFrozen(a.provenance), true);
    assert.deepEqual(
      a.inputs.filter((entry) => entry.kind === 'blueprint-layer').map((entry) => entry.ref),
      ['base', 'runtime'],
    );
    const prompt = a.inputs.find((entry) => entry.kind === 'prompt-file' && entry.ref.endsWith('/worker.md'));
    assert.equal(prompt?.kind, 'prompt-file');
    assert.equal(prompt && prompt.bytes, 'Base worker prompt.\n');
    assert.ok(a.inputs.some((entry) => entry.kind === 'addressed-document' && entry.ref === 'worker-guide'));
    assert.ok(a.inputs.some((entry) => entry.kind === 'setting' && entry.ref === 'mode'));
    assert.ok(a.provenance.some((entry) => entry.path === 'configuration.knobs.maxCostUsd'));
    assert.equal(
      a.provenance.find((entry) => entry.path === 'configuration.knobs.logRetention')?.sourceRef,
      'base',
      'nested inherited values retain the parent origin even when the child restates the knobs object',
    );
    assert.equal(
      a.provenance.find((entry) => entry.path === 'configuration.knobs.maxCostUsd')?.sourceRef,
      'runtime',
    );
    assert.ok(a.provenance.some((entry) => entry.path === 'addressed.worker-guide'));
    assert.ok(a.provenance.some((entry) => entry.path === 'setting.mode'));
    assert.equal(specificationPrompt(a), 'Base worker prompt.\n\n## Addressed guidance — for this session’s stack\n\n> These sections are pinned to the addressed-document revisions in the effective agent specification.\n\n## Runtime\n\nUse the fixture safely.\n');
  } finally {
    f.cleanup();
  }
});

test('an already-rendered fixed contribution is pinned once and must occur in the delivered prompt', () => {
  const f = fixture();
  try {
    const fixed = join(f.dir, 'fixed-rules.md');
    writeFileSync(fixed, 'Fixed rules.\n');
    const source = { ...rootSource(), contributions: [{
      id: 'rules', purpose: 'prompt', source: 'fixed', refresh: 'source-change',
      inputKind: 'prompt-file', ref: 'fixed:rules',
    }] };
    const input = {
      source, resolve: f.resolve,
      prompt: { text: 'Fixed rules.\n\nKernel.' },
      pinnedFixedPromptFiles: [{ path: fixed, ref: 'fixed:rules' }],
    } as const;
    const artifact = compileAgentSpecification(input);
    assert.equal(specificationPrompt(artifact), 'Fixed rules.\n\nKernel.');
    assert.ok(artifact.inputs.some((entry) => entry.kind === 'prompt-file' &&
      entry.ref === 'fixed:rules' && entry.bytes === 'Fixed rules.\n'));
    assert.ok(artifact.provenance.some((entry) => entry.path === 'contribution.rules' &&
      entry.decision === 'fixed:source-change'));
    assert.throws(() => compileAgentSpecification({ ...input, prompt: { text: 'Kernel.' } }),
      /contribution-not-delivered/);
    writeFileSync(fixed, 'Changed rules.\n');
    assert.throws(() => compileAgentSpecification({ ...input, pinnedFixedPromptFiles: [{
      path: fixed, ref: 'fixed:rules', bytes: 'Fixed rules.\n',
    }] }), /prompt-hash-mismatch/);
  } finally {
    f.cleanup();
  }
});

test('a compiled operation keeps revision A after the authored definition changes to B', () => {
  const f = fixture();
  try {
    const operation = {
      id: 'extract',
      version: 'A',
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    };
    const source = { ...rootSource(), roles: [{ id: 'worker' }], operations: [operation] };
    const first = compileAgentSpecification({ source, resolve: f.resolve, harnessDir: f.dir });
    const accepted = operationFromSpecification(first, 'extract');
    const second = compileAgentSpecification({
      source: { ...source, operations: [{ ...operation, version: 'B' }] },
      resolve: f.resolve,
      harnessDir: f.dir,
    });

    assert.equal(accepted.operation.version, 'A');
    assert.equal(Object.isFrozen(accepted.operation), true);
    assert.equal(accepted.specificationRevision, first.specificationRevision);
    assert.ok(first.provenance.some((entry) => entry.path === 'configuration.operations' && entry.decision === 'declared'));
    assert.notEqual(first.specificationRevision, second.specificationRevision);
    assert.equal(operationFromSpecification(second, 'extract').operation.version, 'B');
    assert.throws(() => operationFromSpecification(second, 'missing'), CompositionCompilerError);
  } finally {
    f.cleanup();
  }
});

test('P-025 identity layers contribute lexicon, retirement, role backend and each valid rubric authority', () => {
  const f = fixture();
  try {
    const commonIdentity = {
      extends: 'base',
      slots: [{ slot: 'domain' }],
      lexicon: { workUnit: 'deliverable', reviewGate: 'review' },
      retired: { at: 'D-025', reason: 'fixture retirement contract' },
      knobs: {
        aiBackend: {
          roles: {
            reviewer: { model: 'review-model', extraArgs: ['--reasoning-effort', 'high'] },
          },
        },
      },
    } as const;
    const gymIdentity = {
      ...commonIdentity,
      id: 'gym-domain-identity',
      gym: {
        rubric: {
          version: 'gym-v1',
          dimensions: { quality: 'Is the deliverable well supported?' },
          weights: { quality: 1 },
        },
      },
    } as const;
    const acceptanceIdentity = {
      ...commonIdentity,
      id: 'acceptance-domain-identity',
      acceptance: {
        kind: 'judge',
        rubric: {
          version: 'accept-v1',
          dimensions: { complete: 'Does it answer the full brief?' },
          weights: { complete: 1 },
        },
      },
    } as const;

    const gymArtifact = compileAgentSpecification({ source: gymIdentity, resolve: f.resolve });
    const acceptanceArtifact = compileAgentSpecification({ source: acceptanceIdentity, resolve: f.resolve });
    for (const [artifact, sourceRef] of [
      [gymArtifact, 'gym-domain-identity'],
      [acceptanceArtifact, 'acceptance-domain-identity'],
    ] as const) {
      assert.deepEqual(artifact.configuration.lexicon, { workUnit: 'deliverable', reviewGate: 'review' });
      assert.deepEqual(artifact.configuration.retired, { at: 'D-025', reason: 'fixture retirement contract' });
      assert.deepEqual(artifact.configuration.knobs?.aiBackend?.roles?.reviewer, {
        model: 'review-model',
        extraArgs: ['--reasoning-effort', 'high'],
      });
      for (const path of [
        'configuration.lexicon.workUnit',
        'configuration.retired.at',
        'configuration.knobs.aiBackend.roles.reviewer.model',
      ]) {
        assert.equal(
          artifact.provenance.find((entry) => entry.path === path)?.sourceRef,
          sourceRef,
          `${path} must retain identity-layer provenance`,
        );
      }
    }
    assert.equal(gymArtifact.configuration.gym?.rubric?.version, 'gym-v1');
    assert.equal(gymArtifact.configuration.acceptance, undefined);
    assert.equal(acceptanceArtifact.configuration.acceptance?.rubric?.version, 'accept-v1');
    assert.equal(acceptanceArtifact.configuration.gym, undefined);
    for (const [artifact, path, sourceRef] of [
      [gymArtifact, 'configuration.gym.rubric.dimensions.quality', 'gym-domain-identity'],
      [acceptanceArtifact, 'configuration.acceptance.rubric.dimensions.complete', 'acceptance-domain-identity'],
    ] as const) {
      assert.equal(
        artifact.provenance.find((entry) => entry.path === path)?.sourceRef,
        sourceRef,
        `${path} must retain identity-layer provenance`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('prompt-only and addressed-document-only changes invalidate the artifact without changing configuration', () => {
  const f = fixture();
  try {
    const baseInput = {
      source: rootSource(),
      resolve: f.resolve,
      harnessDir: f.dir,
      role: 'worker',
      addressedDocuments: { revision: 1, parts: [{ partKey: 'guide', body: 'one' }] },
    } as const;
    const first = compileAgentSpecification(baseInput);
    writeFileSync(join(f.promptDir, 'worker.md'), 'Changed worker prompt.\n');
    const promptChanged = compileAgentSpecification(baseInput);
    assert.notEqual(promptChanged.specificationRevision, first.specificationRevision);
    assert.deepEqual(promptChanged.configuration, first.configuration);
    assert.notEqual(
      promptChanged.inputs.find((entry) => entry.kind === 'prompt-file' && entry.ref.endsWith('/worker.md')),
      first.inputs.find((entry) => entry.kind === 'prompt-file' && entry.ref.endsWith('/worker.md')),
    );

    const docChanged = compileAgentSpecification({
      ...baseInput,
      addressedDocuments: { revision: 2, parts: [{ partKey: 'guide', body: 'one' }] },
    });
    assert.notEqual(docChanged.specificationRevision, promptChanged.specificationRevision);
    assert.deepEqual(docChanged.configuration, promptChanged.configuration);
  } finally {
    f.cleanup();
  }
});

test('compiler refuses missing/corrupt inputs and never falls back to another prompt', () => {
  const f = fixture();
  try {
    assert.throws(
      () => compileAgentSpecification({ source: rootSource(), resolve: f.resolve, harnessDir: f.dir, role: 'missing' }),
      (error: unknown) => error instanceof CompositionCompilerError && error.code === 'prompt-missing',
    );
    assert.throws(
      () =>
        compileAgentSpecification({
          source: rootSource(),
          resolve: f.resolve,
          promptFiles: [{ path: join(f.promptDir, 'worker.md'), contentHash: 'a'.repeat(64) }],
        }),
      (error: unknown) => error instanceof CompositionCompilerError && error.code === 'prompt-hash-mismatch',
    );
    assert.throws(
      () =>
        compileAgentSpecification({
          source: rootSource(),
          resolve: f.resolve,
          harnessDir: f.dir,
          role: 'worker',
          addressedDocuments: {
            revision: 1,
            parts: [{ partKey: 'bad', body: 'body', contentHash: 'b'.repeat(64) }],
          },
        }),
      (error: unknown) => error instanceof CompositionCompilerError && error.code === 'addressed-document-hash-mismatch',
    );
    assert.throws(
      () => compileAgentSpecification({ source: { id: 'broken', extends: 'missing' }, resolve: f.resolve }),
      (error: unknown) => error instanceof CompositionCompilerError && error.code === 'source-resolution-failed',
    );
  } finally {
    f.cleanup();
  }
});

test('the existing sealed render seam can feed the same compiler artifact consumed by adapters', () => {
  const f = fixture();
  try {
    const specification = compileStackSpecification({
      source: rootSource(),
      resolve: f.resolve,
      stackDocuments: [{ id: 'kernel', layer: 'kernel', text: 'Kernel text.' }],
    });
    const rendered = specification.inputs.find((entry) => entry.kind === 'prompt-file' && entry.ref.startsWith('rendered:'));
    assert.equal(rendered?.kind, 'prompt-file');
    assert.match(specificationPrompt(specification), /Kernel precedence — the seal/);
    assert.match(specificationPrompt(specification), /Kernel text\./);
    // The source file remains available as the exact input closure even though
    // the adapter consumes the rendered sealed bytes.
    assert.ok(rendered && rendered.bytes.endsWith('\n'));
    assert.equal(readFileSync(f.basePath, 'utf8').includes('id: base'), true);
  } finally {
    f.cleanup();
  }
});
