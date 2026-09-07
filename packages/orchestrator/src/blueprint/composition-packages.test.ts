import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileAgentSpecification,
  pinPackageInput,
  replayAgentSpecification,
  snapshotPackageDirectory,
  specificationPrompt,
  validateAgentInputClosure,
} from './composition-compiler.js';
import type { ResolvedPackageInput } from './schema.js';

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
