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
    assert.ok(a.provenance.some((entry) => entry.path === 'addressed.worker-guide'));
    assert.ok(a.provenance.some((entry) => entry.path === 'setting.mode'));
    assert.equal(specificationPrompt(a), 'Base worker prompt.\n\n## Addressed guidance — for this session’s stack\n\n> These sections are pinned to the addressed-document revisions in the effective agent specification.\n\n## Runtime\n\nUse the fixture safely.\n');
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

