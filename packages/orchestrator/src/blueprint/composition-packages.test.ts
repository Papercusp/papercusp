import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileAgentSpecification as compileCurrentSpecification,
  pinPackageInput,
  replayAgentSpecification,
  snapshotPackageDirectory,
  specificationPrompt,
  validateAgentInputClosure,
  type CompositionCompilerInput,
  type CompiledAgentSpecification,
} from './composition-compiler.js';
import type { ResolvedPackageInput } from './schema.js';
import { builtinBlueprintPath } from './loader.js';
import { parse as parseYaml } from 'yaml';

// The standard mutation probe can exercise a copied compiler without editing production.
const compileAgentSpecification: typeof compileCurrentSpecification = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? (await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)).compileAgentSpecification
  : compileCurrentSpecification;

const source = {
  id: 'pinned-agent',
  workItem: { kind: 'feature' },
  spine: { edges: { DONE: { to: 'done' } } },
};
const reference = ({ packageKind, ref, revision, contentHash }: ResolvedPackageInput) =>
  ({ packageKind, ref, revision, contentHash });
const recipe = (bytes = 'return 1') => pinPackageInput({
  packageKind: 'recipe', ref: 'shared', revision: '1.0.0',
  files: [{ path: 'recipe.json', bytes }], value: { script: bytes },
});
const compile = (pins = [recipe()]) => compileAgentSpecification({
  source: { ...source, bundles: [{ kind: 'recipe', ref: 'shared', version: '1.0.0' }] },
  prompt: { text: 'A reproducible prompt.' },
  addressedDocuments: [{ ref: 'guide', revision: 7, body: 'Addressed text.' }],
  inputClosure: pins,
});

describe('P-006 complete package closure and replay', () => {
  it('uses locale-independent package file ordering and validates the pin envelope', () => {
    const result = pinPackageInput({ packageKind: 'recipe', ref: 'r', revision: '1',
      files: [{ path: 'ä.md', bytes: 'accent' }, { path: 'z.md', bytes: 'ascii' }] });
    expect(result.files.map((file) => file.path)).toEqual(['z.md', 'ä.md']);
    expect(() => pinPackageInput({ packageKind: 'recipe', ref: 'r', revision: '', files: [] })).toThrow(/input-invalid/);
  });
  it('accepts sourcePath envelopes through the same compiler boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-envelope-'));
    try {
      const sourcePath = join(dir, 'blueprint.yaml');
      writeFileSync(sourcePath, 'id: file-source\nworkItem: { kind: feature }\nspine: { edges: { DONE: { to: done } } }\n');
      expect(compileAgentSpecification({ sourcePath }).source.id).toBe('file-source');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps a document-only prompt replayable and rejects non-JSON setting values', () => {
    const artifact = compileAgentSpecification({
      source, addressedDocuments: [{ ref: 'only', revision: 1, body: 'The entire prompt.' }],
    });
    expect(specificationPrompt(replayAgentSpecification(artifact))).toContain('The entire prompt.');
    expect(() => compileAgentSpecification({ source, settings: [{ ref: 'bad', revision: 1, value: new Date() }] }))
      .toThrow(/not JSON-serializable/);
  });
  it('replays a serialized artifact with the exact prompt, source and addressed bytes', () => {
    const artifact = compile();
    const replayed = replayAgentSpecification(JSON.parse(JSON.stringify(artifact)));
    expect(replayed).toEqual(artifact);
    expect(specificationPrompt(replayed)).toContain('Addressed text.');
    expect(replayed.inputs.find((entry) => entry.kind === 'addressed-document')).toMatchObject({ bytes: 'Addressed text.' });
    expect(replayed.inputs.find((entry) => entry.kind === 'blueprint-layer')).toHaveProperty('document.id', source.id);
    expect(Object.isFrozen(replayed.inputs)).toBe(true);
  });

  it('pins transitive content and ignores resolver enumeration order', () => {
    const leaf = recipe();
    const parent = pinPackageInput({
      packageKind: 'rubric', ref: 'judge', revision: '2.0.0', files: [],
      dependencies: [reference(leaf)],
    });
    const a = compile([parent, leaf]);
    expect(compile([leaf, parent])).toEqual(a);
    expect(a.inputs).toContainEqual(parent);
    expect(() => compile([parent])).toThrow(/package-missing.*recipe:shared.*rubric:judge/);
    expect(() => compile([parent, recipe('return 2')])).toThrow(/package-pin-conflict.*recipe:shared.*rubric:judge/);
    expect(compile([recipe('return 2')]).specificationRevision).not.toBe(compile().specificationRevision);
  });

  it('refuses exact version conflicts and same-version content substitution', () => {
    const second = pinPackageInput({ packageKind: 'recipe', ref: 'shared', revision: '2.0.0', files: [] });
    expect(() => compile([second])).toThrow(/package-pin-conflict.*requires 1.0.0, selected 2.0.0/);
    expect(() => compile([recipe(), recipe('substitution')])).toThrow(/package-pin-conflict/);
  });

  it('checks bytes entering inputClosure, including prompts supplied by adapters', () => {
    const hash = createHash('sha256').update('original').digest('hex');
    expect(() => validateAgentInputClosure([{ kind: 'prompt-file', ref: 'caller', bytes: 'corrupt', contentHash: hash }]))
      .toThrow(/prompt-hash-mismatch/);
    expect(() => validateAgentInputClosure([{ kind: 'addressed-document', ref: 'caller', revision: '1', bytes: 'corrupt', contentHash: hash }]))
      .toThrow(/addressed-document-hash-mismatch/);
  });

  it('pins an exact capability provider in the same immutable closure', () => {
    const provider = {
      kind: 'capability-provider' as const,
      ref: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      conformanceRunId: 'run-1',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
    };
    const first = compileAgentSpecification({
      source: {
        ...source,
        grants: { requires: ['crm.email@1.0.0'] },
      },
      inputClosure: [provider],
    });
    expect(first.inputs).toContainEqual(provider);
    const rebound = compileAgentSpecification({
      source: {
        ...source,
        grants: { requires: ['crm.email@1.0.0'] },
      },
      inputClosure: [{
        ...provider,
        providerVersion: '2.1.0',
        conformanceRunId: 'run-2',
      }],
    });
    expect(rebound.specificationRevision).not.toBe(first.specificationRevision);
    expect(() => validateAgentInputClosure([
      provider,
      { ...provider, providerVersion: '2.1.0' },
    ])).toThrow(/input-conflict/);
    const tampered = JSON.parse(JSON.stringify(first));
    tampered.inputs.find((entry: { kind: string }) =>
      entry.kind === 'capability-provider').providerVersion = '9.0.0';
    expect(() => replayAgentSpecification(tampered)).toThrow(/specification-hash-mismatch/);
  });

  it.each(['prompt-file', 'addressed-document', 'package', 'blueprint-layer'])('refuses corrupted %s snapshots', (kind) => {
    const artifact = JSON.parse(JSON.stringify(compile()));
    const entry = artifact.inputs.find((value: { kind: string }) => value.kind === kind);
    if (kind === 'package') entry.value = { tampered: true };
    else if (kind === 'blueprint-layer') entry.document.id = 'substituted';
    else entry.bytes = 'tampered';
    expect(() => replayAgentSpecification(artifact)).toThrow(/mismatch|source-invalid/);
  });

  it('refuses changed configuration, a removed pin, and incomplete legacy replay', () => {
    const configuration = JSON.parse(JSON.stringify(compile()));
    configuration.configuration.description = 'changed';
    expect(() => replayAgentSpecification(configuration)).toThrow(/specification-hash-mismatch/);
    const missing = JSON.parse(JSON.stringify(compile()));
    missing.inputs = missing.inputs.filter((entry: { kind: string; packageKind?: string }) => entry.packageKind !== 'recipe');
    expect(() => replayAgentSpecification(missing)).toThrow(/package-missing/);
    const legacy = JSON.parse(JSON.stringify(compile()));
    delete legacy.inputs.find((entry: { kind: string }) => entry.kind === 'addressed-document').bytes;
    expect(() => replayAgentSpecification(legacy)).toThrow(/addressed-document-missing-content/);
  });

  it('snapshots complete binary package files independent of the installation directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'package-pins-'));
    try {
      for (const root of ['a', 'b']) {
        mkdirSync(join(dir, root, 'nested'), { recursive: true });
        writeFileSync(join(dir, root, 'nested', 'asset.bin'), Buffer.from([0, 255, 128]));
        writeFileSync(join(dir, root, 'manifest.yaml'), 'id: fixture');
      }
      const options = { packageKind: 'knowledge-pack' as const, ref: 'fixture', revision: '1' };
      const a = snapshotPackageDirectory({ ...options, dir: join(dir, 'a') });
      expect(snapshotPackageDirectory({ ...options, dir: join(dir, 'b') })).toEqual(a);
      expect(Buffer.from(a.files[1]!.bytes, 'base64')).toEqual(Buffer.from([0, 255, 128]));
      writeFileSync(join(dir, 'b', 'nested', 'asset.bin'), 'new');
      expect(snapshotPackageDirectory({ ...options, dir: join(dir, 'b') }).contentHash).not.toBe(a.contentHash);
      symlinkSync(join(dir, 'a'), join(dir, 'b', 'outside'));
      expect(() => snapshotPackageDirectory({ ...options, dir: join(dir, 'b') })).toThrow(/symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins every source layer prompt, including files not selected for the current role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-package-pins-'));
    try {
      mkdirSync(join(dir, 'prompts'));
      writeFileSync(join(dir, 'blueprint.yaml'), 'id: parent\nversion: 1.0.0\n');
      writeFileSync(join(dir, 'prompts', 'other-role.md'), 'first');
      const input = { source: { ...source, extends: 'parent' }, resolve: () => join(dir, 'blueprint.yaml'), prompt: { text: 'selected' } };
      const a = compileAgentSpecification(input);
      writeFileSync(join(dir, 'prompts', 'other-role.md'), 'second');
      const b = compileAgentSpecification(input);
      expect(a.source).toEqual(b.source);
      expect(a.configuration).toEqual(b.configuration);
      expect(a.specificationRevision).not.toBe(b.specificationRevision);
      const before = a.inputs.find((entry) => entry.kind === 'package' && entry.ref === source.id);
      const after = b.inputs.find((entry) => entry.kind === 'package' && entry.ref === source.id);
      expect(before).not.toEqual(after);
      rmSync(dir, { recursive: true, force: true });
      expect(replayAgentSpecification(JSON.parse(JSON.stringify(a)))).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P-002 component contribution binding', () => {
  it('compiles an abstract identity component with its existing structured provider output', () => {
    const file = builtinBlueprintPath('su.fleet-leader');
    const brief = { ok: true, summary: { fleet: 'alpha', members: 2 } };
    const artifact = compileAgentSpecification({
      source: parseYaml(readFileSync(file, 'utf8')),
      sourcePath: file,
      settings: [{ ref: 'fleet-leader-brief', revision: 'brief-1', value: brief,
        producerRef: 'papercusp.fleet-leader-brief@1' }],
    });
    expect(artifact.source.kind).toBe('identity');
    expect(artifact.configuration).toMatchObject({ id: 'su.fleet-leader' });
    expect(artifact.provenance.find((entry) => entry.path === 'contribution.fleet-leader-brief'))
      .toMatchObject({ sourceRef: 'setting:fleet-leader-brief', producerRef: 'papercusp.fleet-leader-brief@1' });
    expect(specificationPrompt(artifact)).toBe('');
    expect(replayAgentSpecification(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  const fixed = { id: 'instructions', purpose: 'prompt', source: 'fixed', refresh: 'source-change', inputKind: 'prompt-file', ref: 'fixed:instructions' } as const;
  const generated = { id: 'current-task', purpose: 'prompt', source: 'provider', refresh: 'turn', inputKind: 'prompt-file', ref: 'provider:task', producerRef: 'papercusp.turn-start-orientation@1', verb: 'render' } as const;
  const resource = { id: 'procedure', purpose: 'resource', source: 'fixed', refresh: 'source-change', inputKind: 'package', ref: 'recipe:shared' } as const;
  const operational = { id: 'runtime-mode', purpose: 'operational', source: 'provider', refresh: 'turn', inputKind: 'setting', ref: 'mode', producerRef: 'papercusp.mode-state@1', verb: 'read' } as const;
  const providerText = 'Current task supplied by the existing provider.';
  const providerInput = { kind: 'prompt-file' as const, ref: 'provider:task', bytes: providerText, producerRef: generated.producerRef,
    contentHash: createHash('sha256').update(providerText).digest('hex') };
  const genericIdentity = { id: 'pinned-agent', slots: [{ slot: 'domain' }],
    contributions: [fixed, generated, resource, operational] };

  it('composes fixed and generated prompt bytes with resource and state pins in a generic identity', () => {
    const artifact = compileAgentSpecification({
      source: genericIdentity,
      prompt: { files: [{ ref: fixed.ref, bytes: 'Fixed instructions.' }] },
      inputClosure: [providerInput, recipe()],
      settings: [{ ref: 'mode', revision: 'state-1', value: { mode: 'research' }, producerRef: operational.producerRef }],
    });
    expect(specificationPrompt(artifact)).toContain('Fixed instructions.');
    expect(specificationPrompt(artifact)).toContain(providerText);
    expect(artifact.provenance.filter((entry) => entry.path.startsWith('contribution.')).map((entry) => entry.path))
      .toEqual(['contribution.current-task', 'contribution.instructions', 'contribution.procedure', 'contribution.runtime-mode']);
    expect(artifact.provenance.find((entry) => entry.path === 'contribution.current-task'))
      .toMatchObject({ sourceRef: 'prompt-file:provider:task', sourceRevision: providerInput.contentHash,
        producerRef: generated.producerRef, decision: 'provider:turn' });
    expect(replayAgentSpecification(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it('refuses an absent required provider input and a prompt supplied through the wrong source', () => {
    expect(() => compileAgentSpecification({ source: { ...source, contributions: [generated] } }))
      .toThrow(/contribution-missing.*current-task:prompt-file:provider:task/);
    expect(() => compileAgentSpecification({
      source: { ...source, contributions: [generated] },
      prompt: { files: [{ ref: generated.ref, bytes: providerText }] },
    })).toThrow(/contribution-source-mismatch.*current-task:prompt-file:provider:task/);
    expect(() => compileAgentSpecification({
      source: { ...source, contributions: [generated] },
      inputClosure: [{ ...providerInput, producerRef: 'wrong.provider' }],
    })).toThrow(/contribution-source-mismatch.*current-task:prompt-file:provider:task/);
  });

  it('requires an explicit omission receipt for a conditional provider and pins its reason', () => {
    const optional = { ...generated, availability: 'optional' as const };
    const identity = { ...source, contributions: [optional] };
    expect(() => compileAgentSpecification({ source: identity }))
      .toThrow(/contribution-missing.*current-task/);
    const omitted = compileAgentSpecification({ source: identity,
      contributionOmissions: [{ id: optional.id, reason: 'not-requested' }] });
    expect(omitted.provenance.find((entry) => entry.path === 'contribution.current-task'))
      .toMatchObject({ decision: 'omitted:not-requested', producerRef: optional.producerRef });
    expect(specificationPrompt(omitted)).not.toContain(providerText);
    const delivered = compileAgentSpecification({ source: identity, inputClosure: [providerInput] });
    expect(specificationPrompt(delivered)).toContain(providerText);
    expect(omitted.specificationRevision).not.toBe(delivered.specificationRevision);
    expect(() => compileAgentSpecification({ source: identity,
      contributionOmissions: [{ id: optional.id, reason: 'unavailable' }] }))
      .toThrow(/input-invalid.*unavailable needs errorRef/);
    expect(() => compileAgentSpecification({ source: identity, inputClosure: [providerInput],
      contributionOmissions: [{ id: optional.id, reason: 'not-requested' }] }))
      .toThrow(/input-conflict.*both pinned and marked omitted/);
  });

  it('CONTROL catches a compiler that silently drops a missing required contribution', () => {
    const identity = { ...source, contributions: [generated] };
    const assertRequiredInput = (compiler: (input: CompositionCompilerInput) => CompiledAgentSpecification) => {
      // Calibration: refusal alone must not reward a compiler that rejects everything.
      const delivered = compiler({ source: identity, inputClosure: [providerInput] });
      assert.ok(specificationPrompt(delivered).includes(providerText));
      assert.throws(() => compiler({ source: identity }),
        /contribution-missing.*current-task:prompt-file:provider:task/);
    };
    assertRequiredInput(compileAgentSpecification);

    // Permanent wrong implementation models the missing-entry `continue` mutant.
    // Its delivered-input path is real; only the absent declaration is silently lost.
    const silentlyDropMissing = (input: CompositionCompilerInput) =>
      compileAgentSpecification(input.inputClosure?.length ? input : {
        ...input, source: { ...source, contributions: [] },
      });
    assert.throws(() => assertRequiredInput(silentlyDropMissing), {
      code: 'ERR_ASSERTION', message: /Missing expected exception/,
    });
  });

  it('refuses a declared addressed prompt when its render is disabled', () => {
    expect(() => compileAgentSpecification({
      source: { ...source, contributions: [{ id: 'guide', purpose: 'prompt', source: 'fixed',
        refresh: 'source-change', inputKind: 'addressed-document', ref: 'guide' }] },
      addressedDocuments: [{ ref: 'guide', revision: '1', body: 'Current guide.' }],
      includeAddressedDocuments: false,
    })).toThrow(/contribution-not-delivered.*guide:addressed-document:guide/);
    expect(() => compileAgentSpecification({
      source: { ...source, contributions: [{ id: 'guide', purpose: 'prompt', source: 'fixed',
        refresh: 'source-change', inputKind: 'addressed-document', ref: 'guide' }] },
      addressedDocuments: [{ ref: 'guide', revision: '1', contentHash: 'a'.repeat(64) }],
    })).toThrow(/contribution-not-delivered.*guide:addressed-document:guide/);
  });

  it('compiles a complete non-SU identity source without authored workflow or assignment fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-identity-'));
    try {
      const parent = join(dir, 'identity-root.yaml');
      writeFileSync(parent, 'id: identity-root\nslots: []\n');
      const identity = { id: 'react-identity', extends: 'identity-root', slots: [{ slot: 'domain' }],
        contributions: [fixed, generated] };
      expect(Object.keys(identity)).not.toContain('spine');
      const artifact = compileAgentSpecification({
        source: identity,
        resolve: (id) => id === 'identity-root' ? parent : null,
        prompt: { files: [{ ref: fixed.ref, bytes: 'Read, act and observe.' }] },
        inputClosure: [providerInput],
      });
      expect(artifact.source).toMatchObject({ id: 'react-identity', kind: 'identity' });
      expect(specificationPrompt(artifact)).toContain(providerText);
      expect(artifact.inputs.find((entry) => entry.kind === 'blueprint-layer' && entry.ref === 'react-identity'))
        .toMatchObject({ document: identity });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
