/**
 * The one composition boundary for an effective agent specification.
 *
 * `identities-v1-2026-08-30` P-038 / D-028 deliberately keeps this module on
 * top of the existing seams instead of introducing another loader or package
 * store.  The loader resolves the authored blueprint stack, prompt-resolve
 * resolves the prompt files, and render-stack remains the authority for a
 * sealed stack render.  This module snapshots the results and all externally
 * supplied inputs into one content-addressed, immutable artifact.
 *
 * There are two important rules here:
 *
 *  1. A missing or corrupt input is an error.  In particular, a failed prompt
 *     or addressed-document read must never quietly select a different
 *     identity or an older document.
 *  2. Mutable mode/policy state is an explicit `setting` input.  It is not
 *     merged into the runnable blueprint and therefore cannot masquerade as
 *     authored identity configuration.
 *
 * The compiler is synchronous on purpose.  Database-backed callers read
 * addressed document rows first (the operator-core projection owns that I/O)
 * and hand the exact rows/revision here.  Keeping the final boundary pure and
 * synchronous makes byte identity testable and lets chat, su, and spawn
 * adapters consume the same artifact.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import {
  ResolvedAgentSpecificationSchema,
  ResolvedAgentInputSchema,
  RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION,
  type BlueprintSourceKind,
  type ResolvedAgentInput,
  type ResolvedAgentProvenance,
} from './schema.js';
import {
  loadBlueprintFromFile,
  resolveBlueprint,
  type BlueprintValidateRegistry,
  type LoadedBlueprint,
  type ResolveExtendsPath,
} from './loader.js';
import { stableStringify } from './merge.js';
import {
  resolvePromptFiles,
  resolveReplacementSystemPromptStack,
  type PromptResolveContext,
} from '../prompt-resolve.js';
import { composeStack, type StackDocument } from './render-stack.js';
import type { IdentityLintOptions } from './identity-lint.js';

/** Compiler implementation version.  A semantic change requires a new value. */
export const COMPOSITION_COMPILER_VERSION = '1.0.0';
/** Alias used by callers that call the value a compiler revision. */
export const COMPOSITION_COMPILER_REVISION = COMPOSITION_COMPILER_VERSION;

const SHA256_RE = /^[0-9a-f]{64}$/;
const PROMPT_SEPARATOR = '\n\n---\n\n';

export type CompositionCompilerErrorCode =
  | 'missing-source'
  | 'source-resolution-failed'
  | 'source-invalid'
  | 'prompt-missing'
  | 'prompt-read-failed'
  | 'prompt-empty'
  | 'prompt-hash-mismatch'
  | 'addressed-document-invalid'
  | 'addressed-document-missing-revision'
  | 'addressed-document-missing-content'
  | 'addressed-document-hash-mismatch'
  | 'setting-invalid'
  | 'input-invalid'
  | 'input-conflict';

/** A diagnosable, machine-classifiable compiler refusal. */
export class CompositionCompilerError extends Error {
  readonly code: CompositionCompilerErrorCode;
  readonly ref?: string;

  constructor(code: CompositionCompilerErrorCode, message: string, ref?: string) {
    super(`composition compiler [${code}]${ref ? ` ${JSON.stringify(ref)}` : ''}: ${message}`);
    this.name = 'CompositionCompilerError';
    this.code = code;
    this.ref = ref;
  }
}

/** A prompt source supplied by a caller or discovered by prompt-resolve. */
export interface CompositionPromptFileInput {
  /** Stable input reference; defaults to `path` for file-backed inputs. */
  ref?: string;
  /** File path.  When omitted, `bytes` must be supplied. */
  path?: string;
  /** Exact UTF-8 prompt bytes as text. */
  bytes?: string;
  /** Optional expected sha256 of `bytes` / the file contents. */
  contentHash?: string;
}

/** One addressed Project-guide document row, or a compatible DB projection row. */
export interface CompositionAddressedDocumentInput {
  ref?: string;
  partKey?: string;
  /** Compatibility spelling from `harness_doc_parts`. */
  part_key?: string;
  revision?: string | number;
  contentHash?: string;
  /** Compatibility spelling from raw rows. */
  content_hash?: string;
  text?: string;
  body?: string;
  ordinal?: number;
  targetSection?: string | null;
  target_section?: string | null;
}

/** A revision envelope for a set of addressed rows. */
export interface CompositionAddressedDocumentSet {
  revision?: string | number;
  contentHash?: string;
  parts: readonly CompositionAddressedDocumentInput[];
}

/** Mutable mode/policy state.  It is deliberately represented as an input, not config. */
export interface CompositionSettingInput {
  ref: string;
  revision: string | number;
  value: unknown;
}

/** A prompt descriptor.  `documents` uses the existing sealed render seam. */
export interface CompositionPromptInput {
  role?: string;
  kind?: string;
  context?: PromptResolveContext;
  files?: readonly (string | CompositionPromptFileInput)[];
  /** An already-rendered inline prompt (useful for a caller-owned adapter). */
  text?: string;
  /** Stack documents are ordered and sealed by `composeStack`; no hand-rendering is done here. */
  documents?: readonly StackDocument[];
}

/**
 * Inputs accepted by the compiler.  `source` may be a raw authored mapping or
 * an already loaded result; `sourcePath` is a convenience for a YAML source.
 * The aliases (`blueprint`, `loaded`, `promptFiles`, `addressedGuide`,
 * `mutableState`) keep migration adapters small while they converge on this
 * one boundary.
 */
export interface CompositionCompilerInput {
  source?: LoadedBlueprint | Record<string, unknown>;
  blueprint?: LoadedBlueprint | Record<string, unknown>;
  loaded?: LoadedBlueprint;
  sourcePath?: string;
  harnessDir?: string;
  resolve?: ResolveExtendsPath;
  registry?: BlueprintValidateRegistry;
  lint?: IdentityLintOptions;

  role?: string;
  promptRole?: string;
  promptContext?: PromptResolveContext;
  prompt?: CompositionPromptInput | readonly CompositionPromptInput[];
  prompts?: CompositionPromptInput | readonly CompositionPromptInput[];
  /** Top-level shorthand for one prompt descriptor's files. */
  promptFiles?: readonly (string | CompositionPromptFileInput)[];
  /** Existing render-stack seam, useful for su and replacement-system prompts. */
  stackDocuments?: readonly StackDocument[];

  addressedDocuments?: readonly CompositionAddressedDocumentInput[] | CompositionAddressedDocumentSet;
  addressedGuide?: CompositionAddressedDocumentSet;
  /** When false, addressed row bodies remain pinned inputs but are not appended to prompt text. */
  includeAddressedDocuments?: boolean;

  settings?: readonly CompositionSettingInput[];
  /** One explicit state input, normally `{ ref: 'mode', revision, value }`. */
  mutableState?: CompositionSettingInput;
  state?: CompositionSettingInput;

  /** Additional already-pinned closure entries (package/dependency adapters use this). */
  inputClosure?: readonly ResolvedAgentInput[];
  /** Optional externally known revisions for source layers; hashes remain the content identity. */
  layerRevisions?: Readonly<Record<string, string>>;
  compilerVersion?: string;
}

/** The output is the schema's deeply frozen `ResolvedAgentSpecification`. */
export type CompiledAgentSpecification = ReturnType<typeof ResolvedAgentSpecificationSchema.parse>;

function fail(code: CompositionCompilerErrorCode, message: string, ref?: string): never {
  throw new CompositionCompilerError(code, message, ref);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoadedBlueprint(value: unknown): value is LoadedBlueprint {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.blueprint) &&
    typeof value.contentHash === 'string' &&
    Array.isArray(value.layers) &&
    typeof value.sourceKind === 'string'
  );
}

function assertSha(value: string, what: string, ref?: string): string {
  if (!SHA256_RE.test(value)) fail('input-invalid', `${what} must be a lowercase sha256 hex digest`, ref);
  return value;
}

/** Canonical JSON-ish clone.  It both prevents caller mutation and omits undefined object keys. */
function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = cloneJson(value[key]);
    }
    return out;
  }
  // Dates, functions, Buffers, and class instances are not valid serialized
  // setting values.  Refuse them instead of hashing an implementation detail.
  fail('input-invalid', `value at ${whatPath(value)} is not JSON-serializable`);
}

function whatPath(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalHash(value: unknown): string {
  return sha256(stableStringify(cloneJson(value)));
}

function asRevision(value: string | number | undefined, what: string, ref?: string): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    fail('addressed-document-missing-revision', `${what} needs an explicit non-empty revision`, ref);
  }
  return String(value);
}

function sourceFor(input: CompositionCompilerInput): LoadedBlueprint {
  const candidate = input.loaded ?? input.source ?? input.blueprint;
  if (candidate !== undefined) {
    if (isLoadedBlueprint(candidate)) {
      if (!candidate.validation?.ok) fail('source-invalid', 'the supplied LoadedBlueprint has validation errors');
      if (!candidate.layers.length) fail('source-invalid', 'the supplied LoadedBlueprint has no source layers');
      assertSha(candidate.contentHash, 'loaded blueprint contentHash');
      return candidate;
    }
    if (!isRecord(candidate)) fail('source-invalid', 'source must be a YAML mapping or LoadedBlueprint');
    try {
      return resolveBlueprint(candidate, {
        resolve: input.resolve,
        sourcePath: input.sourcePath ?? null,
        registry: input.registry,
        lint: input.lint,
      });
    } catch (error) {
      fail(
        'source-resolution-failed',
        error instanceof Error ? error.message : String(error),
        input.sourcePath,
      );
    }
  }
  if (input.sourcePath) {
    try {
      return loadBlueprintFromFile(input.sourcePath, input.resolve, input.registry);
    } catch (error) {
      fail('source-resolution-failed', error instanceof Error ? error.message : String(error), input.sourcePath);
    }
  }
  fail('missing-source', 'a raw source, LoadedBlueprint, or sourcePath is required; no identity fallback is attempted');
}

function defaultPromptContext(
  input: CompositionCompilerInput,
  loaded: LoadedBlueprint,
): PromptResolveContext {
  const supplied = input.promptContext;
  const harnessDir = supplied?.harnessDir ?? input.harnessDir ?? harnessRoot();
  const chain = supplied?.extendsChain ?? loaded.layers.map((layer) => layer.id).reverse();
  return {
    harnessDir,
    phase: supplied?.phase ?? '',
    dept: supplied?.dept ?? '',
    ...supplied,
    blueprintId: supplied?.blueprintId ?? loaded.blueprint.id,
    extendsChain: chain,
  };
}

function normalizePromptDescriptors(input: CompositionCompilerInput): CompositionPromptInput[] {
  const supplied = input.prompts ?? input.prompt;
  const descriptors: CompositionPromptInput[] = supplied
    ? (Array.isArray(supplied) ? [...supplied] : [supplied])
    : [];
  if (descriptors.length === 0 && (input.role || input.promptRole || input.promptFiles || input.stackDocuments)) {
    descriptors.push({
      role: input.role ?? input.promptRole,
      files: input.promptFiles,
      documents: input.stackDocuments,
    });
  }
  return descriptors;
}

function promptFileFromPath(path: string, expectedHash?: string, ref?: string): CompositionPromptFileInput {
  const resolved = isAbsolute(path) ? path : resolvePath(path);
  if (!existsSync(resolved)) fail('prompt-missing', 'prompt file does not exist', ref ?? path);
  try {
    if (!statSync(resolved).isFile()) fail('prompt-read-failed', 'prompt path is not a regular file', ref ?? path);
    const bytes = readFileSync(resolved, 'utf8');
    if (bytes.length === 0) fail('prompt-empty', 'prompt file is empty', ref ?? resolved);
    const contentHash = sha256(bytes);
    if (expectedHash !== undefined && assertSha(expectedHash, 'prompt contentHash', ref ?? resolved) !== contentHash) {
      fail('prompt-hash-mismatch', `expected ${expectedHash}, read ${contentHash}`, ref ?? resolved);
    }
    return { ref: ref ?? resolved, path: resolved, bytes, contentHash };
  } catch (error) {
    if (error instanceof CompositionCompilerError) throw error;
    fail('prompt-read-failed', error instanceof Error ? error.message : String(error), ref ?? resolved);
  }
}

function normalizePromptFile(
  value: string | CompositionPromptFileInput,
  descriptorRef: string,
): CompositionPromptFileInput {
  if (typeof value === 'string') return promptFileFromPath(value, undefined, value);
  if (!isRecord(value)) fail('prompt-read-failed', 'prompt file descriptor must be a path or mapping', descriptorRef);
  const path = typeof value.path === 'string' ? value.path : undefined;
  const ref = typeof value.ref === 'string' && value.ref.trim() ? value.ref : path;
  const bytes = typeof value.bytes === 'string' ? value.bytes : undefined;
  const expectedHash = value.contentHash;
  if (expectedHash !== undefined && typeof expectedHash !== 'string') {
    fail('prompt-hash-mismatch', 'contentHash must be a string', ref ?? descriptorRef);
  }
  if (bytes !== undefined) {
    if (bytes.length === 0) fail('prompt-empty', 'inline prompt bytes are empty', ref ?? descriptorRef);
    const actual = sha256(bytes);
    if (expectedHash !== undefined && assertSha(expectedHash, 'prompt contentHash', ref ?? descriptorRef) !== actual) {
      fail('prompt-hash-mismatch', `expected ${expectedHash}, supplied ${actual}`, ref ?? descriptorRef);
    }
    // When both a path and bytes are supplied, verify the path rather than
    // accepting an untrusted replacement for the file the caller named.
    if (path !== undefined) {
      const fromDisk = promptFileFromPath(path, undefined, ref ?? path);
      if (fromDisk.bytes !== bytes) fail('prompt-hash-mismatch', 'inline bytes differ from the named file', ref ?? path);
    }
    return { ref: ref ?? `inline:${descriptorRef}`, ...(path ? { path: resolvePath(path) } : {}), bytes, contentHash: actual };
  }
  if (!path) fail('prompt-missing', 'prompt descriptor needs path or bytes', descriptorRef);
  return promptFileFromPath(path, expectedHash, ref);
}

function promptDescriptorFiles(
  descriptor: CompositionPromptInput,
  context: PromptResolveContext,
  descriptorIndex: number,
): { files: CompositionPromptFileInput[]; rendered: string; key: string } {
  const role = descriptor.role?.trim() || '';
  const key = `${role || 'inline'}${descriptor.kind ? `:${descriptor.kind}` : ''}#${descriptorIndex}`;
  if (descriptor.documents) {
    let composed;
    try {
      composed = composeStack(descriptor.documents);
    } catch (error) {
      fail('prompt-read-failed', error instanceof Error ? error.message : String(error), key);
    }
    const sourceFiles = descriptor.documents.map((doc, i) =>
      normalizePromptFile(
        {
          ref: doc.sourcePath ?? `stack:${doc.id}:${i}`,
          bytes: doc.text,
        },
        key,
      ),
    );
    // Keep the final sealed bytes as an explicit input as well as the source
    // documents.  This lets every adapter consume the same ready-to-use text
    // without reimplementing render-stack's seal/order rules.
    sourceFiles.push(
      normalizePromptFile(
        { ref: `rendered:${key}`, bytes: composed.text },
        key,
      ),
    );
    return { files: sourceFiles, rendered: composed.text, key };
  }
  if (descriptor.text !== undefined) {
    const file = normalizePromptFile({ ref: `inline:${key}`, bytes: descriptor.text }, key);
    return { files: [file], rendered: file.bytes!, key };
  }
  const paths = descriptor.files;
  const resolvedPaths = paths && paths.length > 0
    ? paths
    : role
      ? resolvePromptFiles(context, role)
      : [];
  if (resolvedPaths.length === 0) {
    fail(
      'prompt-missing',
      role
        ? `no prompt resolved for role ${JSON.stringify(role)} (the declared chain was searched)`
        : 'prompt descriptor has no role, files, documents, or inline text',
      key,
    );
  }
  const files = resolvedPaths.map((entry) => normalizePromptFile(entry, key));
  return {
    files,
    rendered: files.map((file) => file.bytes).join(PROMPT_SEPARATOR),
    key,
  };
}

function normalizeAddressedRows(input: CompositionCompilerInput): CompositionAddressedDocumentInput[] {
  const supplied = input.addressedGuide ?? input.addressedDocuments;
  if (!supplied) return [];
  // `Array.isArray` narrows mutable arrays but not a readonly-array union in
  // older TypeScript versions used by the harness, so make the two branches
  // explicit after the runtime check.
  const envelope = Array.isArray(supplied) ? undefined : (supplied as CompositionAddressedDocumentSet);
  const rows: readonly CompositionAddressedDocumentInput[] = envelope
    ? envelope.parts
    : (supplied as readonly CompositionAddressedDocumentInput[]);
  const envelopeRevision = envelope?.revision;
  const envelopeHash = envelope?.contentHash;
  const normalized = rows.map((row, index) => {
    if (!isRecord(row)) fail('addressed-document-invalid', 'addressed document must be a mapping', String(index));
    const ref =
      (typeof row.ref === 'string' && row.ref.trim() ? row.ref : undefined) ??
      (typeof row.partKey === 'string' && row.partKey.trim() ? row.partKey : undefined) ??
      (typeof row.part_key === 'string' && row.part_key.trim() ? row.part_key : undefined);
    if (!ref) fail('addressed-document-invalid', 'addressed document needs ref/partKey', String(index));
    const rowRevision = typeof row.revision === 'string' || typeof row.revision === 'number' ? row.revision : undefined;
    const revision = rowRevision ?? envelopeRevision;
    const text = typeof row.text === 'string' ? row.text : typeof row.body === 'string' ? row.body : undefined;
    const rowContentHash =
      typeof row.contentHash === 'string'
        ? row.contentHash
        : typeof row.content_hash === 'string'
          ? row.content_hash
          : undefined;
    const contentHash = rowContentHash ?? (text !== undefined ? sha256(text) : envelopeHash);
    if (typeof contentHash !== 'string') {
      fail('addressed-document-missing-content', 'pin contentHash when no document body is supplied', ref);
    }
    assertSha(contentHash, 'addressed document contentHash', ref);
    if (text !== undefined && sha256(text) !== contentHash) {
      fail('addressed-document-hash-mismatch', `body hashes to ${sha256(text)}, not ${contentHash}`, ref);
    }
    const rowTargetSection =
      row.targetSection === null || typeof row.targetSection === 'string'
        ? row.targetSection
        : row.target_section === null || typeof row.target_section === 'string'
          ? row.target_section
          : undefined;
    return {
      ref,
      revision: asRevision(revision, 'addressed document', ref),
      contentHash,
      ...(text !== undefined ? { text } : {}),
      ...(typeof row.ordinal === 'number' ? { ordinal: row.ordinal } : {}),
      ...(rowTargetSection !== undefined ? { targetSection: rowTargetSection } : {}),
    } satisfies CompositionAddressedDocumentInput;
  });
  // DB reads are normally ordered, but the artifact must not depend on an
  // accidental query order.  Ordinal is the projector's order; ref breaks ties.
  normalized.sort((a, b) =>
    (typeof a.ordinal === 'number' ? a.ordinal : Number.MAX_SAFE_INTEGER) -
      (typeof b.ordinal === 'number' ? b.ordinal : Number.MAX_SAFE_INTEGER) ||
    String(a.ref).localeCompare(String(b.ref)),
  );
  return normalized;
}

function addressedInput(row: CompositionAddressedDocumentInput): ResolvedAgentInput {
  const ref = String(row.ref);
  return {
    kind: 'addressed-document',
    ref,
    revision: String(row.revision),
    contentHash: String(row.contentHash),
  };
}

function renderAddressedRows(rows: readonly CompositionAddressedDocumentInput[]): string {
  const withBodies = rows.filter((row) => typeof row.text === 'string' && row.text.length > 0);
  if (withBodies.length === 0) return '';
  const blocks: string[] = [
    '## Addressed guidance — for this session’s stack',
    '> These sections are pinned to the addressed-document revisions in the effective agent specification.',
  ];
  let section: string | null | undefined;
  for (const row of withBodies) {
    const next = row.targetSection;
    if (next !== section) {
      section = next;
      if (section) blocks.push(`## ${section}`);
    }
    blocks.push(String(row.text));
  }
  return `${blocks.join('\n\n')}\n`;
}

function normalizeSettings(input: CompositionCompilerInput): CompositionSettingInput[] {
  const settings = [...(input.settings ?? [])];
  for (const state of [input.mutableState, input.state]) {
    if (state) settings.push(state);
  }
  const seen = new Set<string>();
  return settings
    .map((setting, index) => {
      if (!isRecord(setting) || typeof setting.ref !== 'string' || !setting.ref.trim()) {
        fail('setting-invalid', 'setting needs a non-empty ref', String(index));
      }
      const ref = setting.ref.trim();
      const revision = asRevision(setting.revision, 'setting', ref);
      const key = `${ref}\u0000${revision}`;
      if (seen.has(key)) fail('input-conflict', `duplicate setting ${ref}@${revision}`, ref);
      seen.add(key);
      return { ref, revision, value: cloneJson(setting.value) };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref) || String(a.revision).localeCompare(String(b.revision)));
}

function layerInput(loaded: LoadedBlueprint, layerIndex: number, revisions?: Readonly<Record<string, string>>): ResolvedAgentInput {
  const layer = loaded.layers[layerIndex]!;
  const revision = revisions?.[layer.id] ?? layer.contentHash;
  assertSha(layer.contentHash, `layer ${layer.id} contentHash`, layer.id);
  if (revision.trim() === '') fail('input-invalid', `layer ${layer.id} revision is empty`, layer.id);
  return {
    kind: 'blueprint-layer',
    ref: layer.id,
    revision,
    contentHash: layer.contentHash,
    sourceKind: layer.sourceKind as BlueprintSourceKind,
  };
}

function validateClosure(entries: readonly ResolvedAgentInput[]): ResolvedAgentInput[] {
  const byKey = new Map<string, ResolvedAgentInput>();
  for (const raw of entries) {
    const parsed = ResolvedAgentInputSchema.safeParse(cloneJson(raw));
    if (!parsed.success) {
      fail('input-invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const entry = parsed.data as ResolvedAgentInput;
    const key = `${entry.kind}\u0000${entry.ref}`;
    const prior = byKey.get(key);
    if (prior && stableStringify(prior) !== stableStringify(entry)) {
      fail('input-conflict', `two closure entries disagree for ${entry.kind}:${entry.ref}`, entry.ref);
    }
    if (!prior) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function leafPaths(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) return [prefix];
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [prefix];
    return keys.flatMap((key) => leafPaths(value[key], `${prefix}.${key}`));
  }
  return [prefix];
}

function configProvenance(
  loaded: LoadedBlueprint,
  compilerVersion: string,
): ResolvedAgentProvenance[] {
  const out: ResolvedAgentProvenance[] = [];
  for (const path of leafPaths(loaded.blueprint, 'configuration')) {
    const relative = path.slice('configuration.'.length);
    const top = relative.split('.')[0]!;
    const contributors = loaded.layers.filter((layer) => layer.fields.includes(top as never));
    const effective = contributors.at(-1);
    const sourceRef = effective?.id ?? 'schema:default';
    const sourceRevision = effective?.contentHash ?? compilerVersion;
    out.push({
      path,
      sourceRef,
      sourceRevision,
      ...(contributors.length > 1
        ? { decision: 'override', sources: contributors.map((layer) => ({ sourceRef: layer.id, sourceRevision: layer.contentHash })) }
        : { decision: contributors.length === 1 ? 'declared' : 'default' }),
    } as ResolvedAgentProvenance);
  }
  return out;
}

function inputProvenance(
  inputs: readonly ResolvedAgentInput[],
  promptKeys: readonly string[],
): ResolvedAgentProvenance[] {
  const out: ResolvedAgentProvenance[] = [];
  let promptOrdinal = 0;
  for (const input of inputs) {
    if (input.kind === 'blueprint-layer') continue; // configuration paths carry layer origins
    let prefix: string;
    if (input.kind === 'prompt-file') prefix = `prompt.${promptKeys[promptOrdinal++] ?? 'default'}`;
    else if (input.kind === 'addressed-document') prefix = `addressed.${input.ref}`;
    else prefix = `setting.${input.ref}`;
    const sourceRevision = input.kind === 'prompt-file' ? input.contentHash : input.revision;
    out.push({
      path: prefix,
      sourceRef: input.ref,
      sourceRevision,
      decision: input.kind === 'setting' ? 'explicit-state' : 'resolved-input',
    } as ResolvedAgentProvenance);
  }
  return out;
}

function promptTextFromInputs(inputs: readonly ResolvedAgentInput[]): string {
  const rendered = inputs.find((input) => input.kind === 'prompt-file' && input.ref.startsWith('rendered:'));
  if (rendered && rendered.kind === 'prompt-file') return rendered.bytes;
  return inputs
    .filter((input): input is Extract<ResolvedAgentInput, { kind: 'prompt-file' }> => input.kind === 'prompt-file')
    .map((input) => input.bytes)
    .join(PROMPT_SEPARATOR);
}

/** Return the exact ready-to-send prompt bytes captured in a compiled artifact. */
export function specificationPrompt(specification: CompiledAgentSpecification): string {
  return promptTextFromInputs(specification.inputs);
}

/** Compatibility alias for adapters migrating from their local prompt assemblers. */
export const promptBytesFromSpecification = specificationPrompt;

function compileFromInput(input: CompositionCompilerInput): CompiledAgentSpecification {
  const loaded = sourceFor(input);
  const compilerVersion = input.compilerVersion ?? COMPOSITION_COMPILER_VERSION;
  if (!compilerVersion.trim()) fail('input-invalid', 'compilerVersion must be non-empty');

  const inputs: ResolvedAgentInput[] = loaded.layers.map((_, i) => layerInput(loaded, i, input.layerRevisions));
  const promptKeys: string[] = [];
  const descriptors = normalizePromptDescriptors(input);
  const promptSegments: string[] = [];
  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i]!;
    const context = { ...defaultPromptContext(input, loaded), ...(descriptor.context ?? {}) };
    if (context.blueprintId && context.blueprintId !== loaded.blueprint.id && !descriptor.documents && !descriptor.text && !descriptor.files) {
      fail('source-invalid', `prompt context selects blueprint ${context.blueprintId}, but source is ${loaded.blueprint.id}`);
    }
    const resolved = promptDescriptorFiles(descriptor, context, i);
    promptKeys.push(...resolved.files.map(() => resolved.key));
    for (const file of resolved.files) {
      const hash = file.contentHash ?? sha256(file.bytes ?? '');
      inputs.push({ kind: 'prompt-file', ref: file.ref ?? file.path ?? `prompt:${resolved.key}`, contentHash: hash, bytes: file.bytes ?? '' });
    }
    promptSegments.push(resolved.rendered);
  }

  const addressedRows = normalizeAddressedRows(input);
  for (const row of addressedRows) inputs.push(addressedInput(row));
  const settings = normalizeSettings(input);
  for (const setting of settings) {
    inputs.push({ kind: 'setting', ref: setting.ref, revision: String(setting.revision), value: setting.value });
  }
  if (input.inputClosure) inputs.push(...input.inputClosure.map((entry) => cloneJson(entry) as ResolvedAgentInput));

  const closure = validateClosure(inputs);
  const addressedText = input.includeAddressedDocuments === false ? '' : renderAddressedRows(addressedRows);
  const joinedPromptText = promptSegments.join(PROMPT_SEPARATOR);
  const promptText = promptSegments.length
    ? addressedText
      ? `${joinedPromptText.replace(/\n+$/, '')}\n\n${addressedText}`
      : joinedPromptText
    : addressedText;
  // If addressed rows were added after a stack's synthetic rendered entry,
  // replace that entry with the final bytes so adapters never see stale text.
  if (promptText && closure.some((entry) => entry.kind === 'prompt-file')) {
    const renderedIndex = closure.findIndex((entry) => entry.kind === 'prompt-file' && entry.ref.startsWith('rendered:'));
    if (renderedIndex >= 0) {
      const existing = closure[renderedIndex]!;
      closure[renderedIndex] = {
        kind: 'prompt-file',
        ref: existing.ref,
        bytes: promptText,
        contentHash: sha256(promptText),
      };
    } else {
      closure.push({ kind: 'prompt-file', ref: 'rendered:effective', bytes: promptText, contentHash: sha256(promptText) });
    }
  }

  const provenance = [
    ...configProvenance(loaded, compilerVersion),
    ...inputProvenance(closure, promptKeys),
  ].sort((a, b) => a.path.localeCompare(b.path) || a.sourceRef.localeCompare(b.sourceRef));
  const sourceLayer = loaded.layers.at(-1)!;
  const source = {
    id: sourceLayer.id,
    kind: sourceLayer.sourceKind,
    contentHash: sourceLayer.contentHash,
  } satisfies { id: string; kind: BlueprintSourceKind; contentHash: string };
  const candidateWithoutRevision = {
    schemaVersion: RESOLVED_AGENT_SPECIFICATION_SCHEMA_VERSION,
    compilerVersion,
    source,
    configuration: loaded.blueprint,
    inputs: closure,
    provenance,
  };
  const specificationRevision = canonicalHash(candidateWithoutRevision);
  return ResolvedAgentSpecificationSchema.parse({ ...candidateWithoutRevision, specificationRevision });
}

/** Compile one immutable effective-agent artifact. */
export function compileAgentSpecification(input: CompositionCompilerInput): CompiledAgentSpecification;
export function compileAgentSpecification(
  source: LoadedBlueprint | Record<string, unknown>,
  options?: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded'>,
): CompiledAgentSpecification;
export function compileAgentSpecification(
  inputOrSource: CompositionCompilerInput | LoadedBlueprint | Record<string, unknown>,
  options: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded'> = {},
): CompiledAgentSpecification {
  const input = isLoadedBlueprint(inputOrSource) || isRecord(inputOrSource) && !('source' in inputOrSource)
    ? { ...options, source: inputOrSource as LoadedBlueprint | Record<string, unknown> }
    : inputOrSource as CompositionCompilerInput;
  return compileFromInput(input);
}

/** Explicitly named alias used by activation/projection adapters. */
export const compileResolvedAgentSpecification = compileAgentSpecification;
export const compileResolvedSpecification = compileAgentSpecification;
export const compileComposition = compileAgentSpecification;

/** Compile the existing replacement-system-prompt stack through this same boundary. */
export function compileReplacementSystemPromptSpecification(
  input: CompositionCompilerInput & { promptContext: PromptResolveContext },
): CompiledAgentSpecification {
  const docs = resolveReplacementSystemPromptStack(input.promptContext);
  if (!docs) fail('prompt-missing', 'replacement system prompt preamble is absent', input.role ?? 'replacement-system-prompt');
  return compileAgentSpecification({
    ...input,
    stackDocuments: docs,
    prompt: { role: input.role ?? 'replacement-system-prompt', documents: docs },
  });
}

/** A small adapter for su/chat callers that already have StackDocuments. */
export function compileStackSpecification(
  input: CompositionCompilerInput & { stackDocuments: readonly StackDocument[] },
): CompiledAgentSpecification {
  return compileAgentSpecification(input);
}
