/**
 * The interactive su's COMPOSED SOURCE — `identities-v1-2026-08-30` P-003 switching
 * the render that P-002 classified (rulings D-007 as amended, D-009, D-018 §4).
 *
 * `blueprints/base/prompts/su.md` is one file in which kernel, identity and instance
 * text interleave; P-002 tiled it (`SU_TILES`) and derived one verbatim document per
 * part. This module builds the SU_DEFAULT_STACK from those tiles and renders it with
 * the seal (`composeStack`): client seam → domain (papercusp-engineer) → [fleet
 * posture, when bound] → practices (su-collaborator stance, su.practice) → instance
 * → the precedence statement → kernel (agent-base-preamble.md, then su.md's kernel
 * tiles). The output is the SOURCE `renderSuPlaybook` splices its generated sections
 * into: every `<!-- PAPERCUSP-SU:… -->` seam survives in its tile (the client seam
 * renders AS the `client` layer, so step 1 still splices the per-client overlay
 * there; AUTO-MODE / RESULT-DOOR / COORD-LEGEND / WIRE-SCHEMAS sit inside kernel
 * tiles and render under the seal).
 *
 * D-018 §4 DEDUPE. The preamble is the kernel's base text on EVERY tier; a kernel tile
 * that duplicates one of its sections carries `dedupeWithPreamble` naming the heading,
 * and this composer keeps the text ONCE — in the preamble — by DROPPING the tile. The
 * drop is guarded: a tile whose named heading is NOT actually in the preamble is KEPT
 * (and reported in `keptDedupeTiles`), so an edit to the preamble can never silently
 * lose kernel text.
 *
 * LOSSLESS by construction otherwise: every tile of su.md that is not a dropped
 * dedupe tile renders exactly once — `su-stack.test.ts` proves it over the real tree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from '@papercusp/harness/paths';
import { composeStack, type ComposeStackOptions, type ComposedStack, type StackDocument } from './render-stack.js';
import {
  applyStackMutation,
  attachLayer,
  normalizeStackBinding,
  type AppliedStackMutation,
  type BoundLayer,
  type StackBinding,
  type StackMutationOp,
} from './stack-mutation.js';
import type { SlotId } from './slots.js';
import {
  SU_PART_DOCUMENTS,
  SU_PREAMBLE_REL,
  locateSuTiles,
  readSuSource,
  tilesOfDocument,
  type FleetPostureRole,
  type LocatedSuTile,
  type SuPartDocument,
} from './su-decomposition.js';

export interface SuStackComposeOptions extends ComposeStackOptions {
  /** The harness install dir (default: the built-in harness via `harnessPath`). */
  harnessDir?: string;
  /** su.md text override (tests); default: read from the harness. */
  suText?: string;
  /** Preamble text override (tests); default: read from the harness. */
  preambleText?: string;
  /**
   * Bind a fleet posture (attached at fleet:launch-on-plan / fleet:join / fleet:take-leadership);
   * default none. Sugar for `binding: suPostureBinding(posture)` — disagreeing with an
   * explicit `binding` on the `fleet-posture` slot is an error, not a silent precedence.
   */
  posture?: FleetPostureRole | null;
  /**
   * P-012: the layers bound on the LIVE session beyond the static su stack — the fleet
   * posture, mode-axis documents (P-021), further practices. Applied over
   * `SU_STATIC_LAYERS` with attach semantics, so an exclusive layer here REPLACES the
   * static one (a different `domain` document swaps the profession).
   */
  binding?: StackBinding | null;
  /**
   * Resolve a bound layer that is NOT one of su.md's part documents (a Cupboard
   * identity, a P-021 mode document). Called only for ids `suBoundLayerDocument`
   * cannot serve; returning null refuses the binding loudly.
   */
  resolveLayer?: (layer: BoundLayer, located: readonly LocatedSuTile[]) => StackDocument | null;
}

export interface SuStackDocuments {
  docs: StackDocument[];
  located: LocatedSuTile[];
  /** Kernel tiles dropped because the preamble carries the section (D-018 §4). */
  droppedTiles: LocatedSuTile[];
  /** Dedupe-marked tiles KEPT because the preamble does NOT carry the named heading. */
  keptDedupeTiles: LocatedSuTile[];
  /** The effective binding the documents were built from (static layers + the runtime binding). */
  binding: StackBinding;
}

/**
 * The layers the interactive su ALWAYS carries (SU_DEFAULT_STACK's `binding: 'static'`
 * rows that are slot documents). A runtime binding is applied OVER these with attach
 * semantics. The client seam, the instance tile and the kernel are not layers of the
 * binding — the seam is a splice point, the other two are reserved layers.
 */
export const SU_STATIC_LAYERS: readonly BoundLayer[] = [
  { slot: 'domain', id: 'papercusp-engineer' },
  { slot: 'collaboration-stance', id: 'su-collaborator' },
  { slot: 'practice', id: 'su.practice' },
];

/** The fleet-posture layer for a role — what fleet:join / take-leadership attach. */
export function suPostureLayer(role: FleetPostureRole): BoundLayer {
  return { slot: 'fleet-posture', id: role === 'leader' ? 'su.fleet-leader' : 'su.fleet-member' };
}

export function suPostureBinding(role: FleetPostureRole | null | undefined): StackBinding {
  return normalizeStackBinding(role ? [suPostureLayer(role)] : []);
}

/**
 * The binding a live session's EXISTING facts imply — presence's `fleet_role` today,
 * the mode axes once P-021 supplies documents for them. This is the whole "no new
 * table" of P-012: the binding is derived, and the control anchor projects it.
 */
export function suSessionBinding(session: { fleetRole?: string | null; modes?: readonly string[] | null }): StackBinding {
  const layers: BoundLayer[] = [];
  const role = (session.fleetRole ?? '').trim().toLowerCase();
  if (role === 'leader' || role === 'member') layers.push(suPostureLayer(role));
  // `modes` is accepted for the P-021 seam: no mode-axis document exists in v1 (D-008 —
  // the AUTO / IDEATE / DRAIN text is kernel), so a mode binds no layer yet.
  return normalizeStackBinding(layers);
}

/** Static layers + the runtime binding (attach semantics — exclusive layers replace). */
export function suEffectiveBinding(runtime: StackBinding | null | undefined, posture?: FleetPostureRole | null): StackBinding {
  let binding = normalizeStackBinding([...SU_STATIC_LAYERS]);
  const runtimeLayers = runtime ? normalizeStackBinding(runtime).layers : [];
  if (posture) {
    const wanted = suPostureLayer(posture);
    const bound = runtimeLayers.find((l) => l.slot === 'fleet-posture');
    if (bound && bound.id !== wanted.id) throw new Error(`su-stack: posture "${posture}" disagrees with the binding's fleet-posture layer "${bound.id}"`);
    if (!bound) runtimeLayers.push(wanted);
  }
  for (const layer of runtimeLayers) binding = attachLayer(binding, layer).after;
  return binding;
}

export interface ComposedSuStack extends ComposedStack {
  droppedTiles: LocatedSuTile[];
  keptDedupeTiles: LocatedSuTile[];
}

/** The preamble's `# ` headings (its sections are H1). */
function preambleHeadings(preamble: string): Set<string> {
  const out = new Set<string>();
  for (const l of preamble.split('\n')) {
    const m = /^#\s+(.+?)\s*$/.exec(l);
    if (m) out.add(m[1]!);
  }
  return out;
}

function readPreamble(opts: SuStackComposeOptions): string {
  if (opts.preambleText != null) return opts.preambleText;
  const p = opts.harnessDir ? join(opts.harnessDir, SU_PREAMBLE_REL) : harnessPath(...SU_PREAMBLE_REL.split('/'));
  return readFileSync(p, 'utf8');
}

function partDoc(id: SuPartDocument['id']): SuPartDocument {
  const d = SU_PART_DOCUMENTS.find((x) => x.id === id);
  if (!d) throw new Error(`su-stack: unknown part document ${id}`);
  return d;
}

function textOf(located: readonly LocatedSuTile[], doc: SuPartDocument, drop: ReadonlySet<LocatedSuTile> = new Set()): string {
  return tilesOfDocument(located, doc)
    .filter((t) => !drop.has(t))
    .map((t) => t.text)
    .join('');
}

/**
 * The SU_DEFAULT_STACK as `StackDocument`s, derived from su.md's tiles + the
 * preamble. Order is immaterial (`composeStack` orders); ids are the part-document
 * ids so a render's `order` reads like the decomposition table.
 */
export function suStackDocuments(opts: SuStackComposeOptions = {}): SuStackDocuments {
  const suText = opts.suText ?? readSuSource(opts.harnessDir);
  const preamble = readPreamble(opts);
  const located = locateSuTiles(suText);
  const headings = preambleHeadings(preamble);
  const droppedTiles: LocatedSuTile[] = [];
  const keptDedupeTiles: LocatedSuTile[] = [];
  for (const t of located) {
    if (!t.dedupeWithPreamble) continue;
    if (t.part !== 'kernel') throw new Error(`su-stack: only a kernel tile may dedupe with the preamble (${JSON.stringify(t.anchor)} is ${t.part})`);
    if (headings.has(t.dedupeWithPreamble)) droppedTiles.push(t);
    else keptDedupeTiles.push(t);
  }
  const drop = new Set(droppedTiles);

  const kernelDoc = partDoc('su.kernel');
  const docs: StackDocument[] = [
    { id: 'agent-base-preamble', layer: 'kernel', text: preamble, sourcePath: SU_PREAMBLE_REL },
    { id: kernelDoc.id, layer: 'kernel', text: textOf(located, kernelDoc, drop), sourcePath: kernelDoc.path },
  ];
  // The client seam tile renders AS the client layer — the per-client overlay is spliced there.
  const seam = located.filter((t) => t.part === 'client');
  if (seam.length) docs.push({ id: 'client-seam', layer: 'client', slot: 'client', text: seam.map((t) => t.text).join(''), sourcePath: null });
  const domain = partDoc('papercusp-engineer');
  docs.push({ id: domain.id, layer: 'domain', slot: 'domain', text: textOf(located, domain), sourcePath: domain.path });
  if (opts.posture) {
    const posture = partDoc(opts.posture === 'leader' ? 'su.fleet-leader' : 'su.fleet-member');
    docs.push({ id: posture.id, layer: 'fleet-posture', slot: 'fleet-posture', text: textOf(located, posture), sourcePath: posture.path });
  }
  const stance = partDoc('su-collaborator');
  docs.push({ id: stance.id, layer: 'practices', slot: 'collaboration-stance', text: textOf(located, stance), sourcePath: stance.path });
  const practice = partDoc('su.practice');
  docs.push({ id: practice.id, layer: 'practices', slot: 'practice', text: textOf(located, practice), sourcePath: practice.path });
  const instance = partDoc('su.instance');
  docs.push({ id: instance.id, layer: 'instance', text: textOf(located, instance), sourcePath: instance.path });
  return { docs, located, droppedTiles, keptDedupeTiles };
}

/** Compose the interactive su's source text under the seal. Throws on a block finding (D-009). */
export function composeSuStackSource(opts: SuStackComposeOptions = {}): ComposedSuStack {
  const { docs, droppedTiles, keptDedupeTiles } = suStackDocuments(opts);
  const composed = composeStack(docs, opts);
  return { ...composed, droppedTiles, keptDedupeTiles };
}
