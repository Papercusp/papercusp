/**
 * E1a — the composed `extends` resolver: **local → installed → built-in**.
 *
 * `harness-blueprint-distribution-2026-06-03` P-001 / D-001 / D-002.
 *
 * The frozen loader (`@papercusp/orchestrator/blueprint`) resolves `extends`
 * parents through a `ResolveExtendsPath` seam whose default
 * (`resolveBuiltinExtends`) only finds the BUILT-IN blueprints shipped under
 * `@papercusp/harness/blueprints/<id>/`. The distribution layer widens that to
 * the three distribution tiers (D-001):
 *
 *   1. **local**     — a project's own `<project>/.papercusp/blueprints/<id>/blueprint.yaml`
 *   2. **installed** — a Cupboard-installed `~/.papercusp/blueprints/<id>/blueprint.yaml`
 *   3. **built-in**  — `resolveBuiltinExtends` (the engine default)
 *
 * First hit wins (local shadows installed shadows built-in), so a project can
 * override a shared/built-in parent without forking it. This is the only thing
 * the loader needs from the distribution layer — pass the composed resolver as
 * `resolveBlueprint(raw, { resolve })` / `loadBlueprintFromFile(path, resolve)`
 * and the engine's existing depth-first merge handles the rest unchanged.
 *
 * **Pure + borrowable.** The host-specific roots are INJECTED (`localDirs`,
 * `installedDir`) — the module names no `~/.papercusp` path itself (the CLI /
 * operator supply them), and the filesystem probe (`exists`) is injectable so
 * the composition is unit-testable without touching disk. We touch only the
 * engine's PUBLIC seam (`resolveBuiltinExtends` + the `ResolveExtendsPath` type);
 * the engine barrel stays frozen.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseBlueprintSourceDocument,
  resolveBuiltinExtends,
  type ResolveExtendsPath,
} from '@papercusp/orchestrator/blueprint';

/**
 * Why a bundled built-in replaced an installed copy of the same id
 * (WI-6554700010054458). Installed copies normally shadow built-ins, but an
 * installed copy that the current source schema rejects must not shadow the
 * built-in that ships with this platform build. Such a copy would make every
 * resolution through it throw, so swapping in the built-in can never change how
 * a copy that LOADS resolves. Version is deliberately NOT a criterion: a valid
 * installed copy keeps first-hit order even when it is older, because an
 * installed id may be a different document kind (an identity root named `base`
 * versus the built-in workspace blueprint `base`) or a deliberate pin. A
 * stale Cupboard install of `papercusp-engineer` still carried `visibility:` after
 * identities stopped accepting it. Because it shadowed the built-in, every
 * headless and judge launch failed.
 */
export interface BuiltinSupersession {
  id: string;
  installedFile: string;
  builtinFile: string;
  /** The document kind the consumer reads. The replacing built-in is always of this kind. */
  kind: SourceDocumentKind;
  reason: 'invalid-source';
  detail: string;
}

export interface SupersessionInput {
  id: string;
  installedFile: string;
  builtinFile: string;
}

/**
 * The engine's own source classification (`parseBlueprintSourceDocument`): an
 * authored layer with its own `slots` is an `identity`, anything else a
 * workspace `blueprint`. Reused rather than restated, so the policy cannot drift
 * from the loader's discriminator.
 */
export type SourceDocumentKind = ReturnType<typeof parseBlueprintSourceDocument>['kind'];

function classifySource(document: unknown): { kind: SourceDocumentKind; problem: null } | { kind: null; problem: string } {
  try {
    return { kind: parseBlueprintSourceDocument(document).kind, problem: null };
  } catch (error) {
    const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string; keys?: unknown[] }> }).issues;
    const first = Array.isArray(issues) ? issues[0] : undefined;
    if (first) {
      const keys = Array.isArray(first.keys) && first.keys.length > 0 ? ` [${first.keys.join(', ')}]` : '';
      const path = Array.isArray(first.path) && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      return { kind: null, problem: `${path}${first.message ?? 'invalid'}${keys}` };
    }
    return { kind: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The OPT-IN, KIND-AWARE supersession policy (WI-6554700010055768). It decides
 * whether the bundled built-in replaces an installed copy with the same id, for
 * a consumer that reads `deps.kind` documents. The only arm is `invalid-source`:
 * the installed YAML does not parse, or the engine's classify-and-validate
 * rejects it, while the built-in is a VALID document of the consumer's kind.
 *
 * The built-in must be of the consumer's kind, so a same-id built-in of another
 * kind is never swapped in. The installed identity root `base` and the built-in
 * workspace blueprint `base` are the measured case (WI-6554700010054458: 23
 * install-blueprint-core / identity-activation reds while the old
 * harness-schema-only policy was on by default). Pass `supersedesInstalledFor(kind)`
 * with the kind the consumer actually loads.
 *
 * A valid installed copy always wins, whatever its version or kind, so the
 * documented first-hit tier order holds for every copy that loads. If either side
 * cannot be read, or the built-in is invalid or of another kind, the policy
 * returns `null` and resolution keeps the documented first-hit order.
 */
export function builtinSupersedesInstalled(
  input: SupersessionInput,
  deps: { kind: SourceDocumentKind; readFile?: (path: string) => string },
): BuiltinSupersession | null {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let builtinDocument: unknown;
  try {
    builtinDocument = parseYaml(readFile(input.builtinFile));
  } catch {
    return null;
  }
  if (classifySource(builtinDocument).kind !== deps.kind) return null;
  let installedText: string;
  try {
    installedText = readFile(input.installedFile);
  } catch {
    return null;
  }
  let installedDocument: unknown;
  try {
    installedDocument = parseYaml(installedText);
  } catch (error) {
    return { ...input, kind: deps.kind, reason: 'invalid-source',
      detail: `installed YAML does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { problem } = classifySource(installedDocument);
  return problem === null ? null : { ...input, kind: deps.kind, reason: 'invalid-source', detail: problem };
}

/** The supersession policy for a consumer that loads `kind` documents (pass as `supersedes`). */
export function supersedesInstalledFor(
  kind: SourceDocumentKind,
  deps: { readFile?: (path: string) => string } = {},
): (input: SupersessionInput) => BuiltinSupersession | null {
  return (input) => builtinSupersedesInstalled(input, { ...deps, kind });
}

export interface ComposedResolveOptions {
  /**
   * Project-local blueprint roots, **highest precedence first**. Each is a
   * directory holding `<id>/blueprint.yaml` (typically a single
   * `<project>/.papercusp/blueprints`). Empty/omitted → no local tier.
   */
  localDirs?: string[];
  /**
   * The installed/global blueprint root (typically `~/.papercusp/blueprints`),
   * holding `<id>/blueprint.yaml`. `null`/omitted → no installed tier.
   */
  installedDir?: string | null;
  /**
   * The built-in tier resolver. Defaults to the engine's `resolveBuiltinExtends`;
   * injectable so tests can stub the built-in floor without a real harness dir.
   */
  builtin?: ResolveExtendsPath;
  /**
   * Existence predicate (defaults to `fs.existsSync`). Injectable so the
   * composition is unit-testable purely (no disk), and so a host can supply a
   * virtualized lookup.
   */
  exists?: (path: string) => boolean;
  /**
   * Decides whether the built-in replaces an installed copy of the same id.
   * Omitted or `null` keeps strict first-hit order, which is the default:
   * supersession is OPT-IN. Pass `supersedesInstalledFor(kind)` with the
   * document kind this consumer actually loads (see `builtinSupersedesInstalled`).
   * Local roots are never superseded, because they are deliberate project authoring.
   */
  supersedes?: ((input: SupersessionInput) => BuiltinSupersession | null) | null;
  /** Called each time a built-in replaces an installed copy, so the replacement is visible. */
  onSuperseded?: (verdict: BuiltinSupersession) => void;
}

/**
 * The on-disk path of a blueprint `id` under a `<root>/<id>/blueprint.yaml`
 * layout — the convention every distribution tier uses.
 */
export function blueprintFileIn(root: string, id: string): string {
  return join(root, id, 'blueprint.yaml');
}

/**
 * Build a `ResolveExtendsPath` that tries each local root (in order), then the
 * installed root, then the built-in resolver — returning the first existing
 * file, or `null` when no tier has the id. Drop-in for the loader's `resolve`
 * arg; the default-only `resolveBuiltinExtends` is the `localDirs:[],
 * installedDir:null` degenerate case.
 */
export function makeComposedResolveExtends(opts: ComposedResolveOptions = {}): ResolveExtendsPath {
  const localDirs = opts.localDirs ?? [];
  const installedDir = opts.installedDir ?? null;
  const builtin = opts.builtin ?? resolveBuiltinExtends;
  const exists = opts.exists ?? existsSync;
  const supersedes = opts.supersedes ?? null;

  return (id: string): string | null => {
    for (const dir of localDirs) {
      const candidate = blueprintFileIn(dir, id);
      if (exists(candidate)) return candidate;
    }
    if (installedDir) {
      const candidate = blueprintFileIn(installedDir, id);
      if (exists(candidate)) {
        const builtinFile = supersedes ? builtin(id) : null;
        const verdict = builtinFile ? supersedes!({ id, installedFile: candidate, builtinFile }) : null;
        if (verdict && builtinFile) {
          opts.onSuperseded?.(verdict);
          return builtinFile;
        }
        return candidate;
      }
    }
    return builtin(id);
  };
}
