/**
 * gen:su-decomposition — (re)derive the su.md PART DOCUMENTS and the pinned
 * COMPOSITION_MODEL.md §9 from `src/blueprint/su-decomposition.ts` + the live
 * `blueprints/base/prompts/su.md` (identities-v1-2026-08-30 P-002).
 *
 *   npm run gen:su-decomposition          # write (from the superproject or libs/papercusp)
 *   npm run gen:su-decomposition:check    # exit 1 on drift
 *
 * The part documents are VERBATIM extractions (byte-equal to the concatenation of
 * their tiles) — never edit one by hand; edit su.md (or the tiling) and re-run.
 * `su-decomposition.test.ts` refuses drift, so a forgotten re-run fails the gate
 * with this command in the message. Lives under `bin/` (not `scripts/`) so the
 * package tsconfig compiles it — `lint:tsc:orchestrator` includes `bin/**`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSuDecompositionMarkdown, suPartDocumentDrift, writeSuPartDocuments } from '../src/blueprint/su-decomposition.js';

const here = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR = join(here, '..');
const HARNESS = join(ORCHESTRATOR, '..', 'harness');
const DOC = join(ORCHESTRATOR, 'docs', 'COMPOSITION_MODEL.md');
const BEGIN = '<!-- SU-DECOMPOSITION:BEGIN -->';
const END = '<!-- SU-DECOMPOSITION:END -->';

function splicedDoc(current: string): string {
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  if (!re.test(current)) throw new Error(`${DOC} lacks the ${BEGIN} / ${END} markers — add a §9 with them first`);
  return current.replace(re, `${BEGIN}\n${renderSuDecompositionMarkdown()}\n${END}`);
}

const check = process.argv.includes('--check');
const cwd = process.cwd();
const doc = readFileSync(DOC, 'utf8');
const wantDoc = splicedDoc(doc);

if (check) {
  const drift = suPartDocumentDrift(HARNESS).filter((d) => d.status !== 'ok');
  const docStale = doc !== wantDoc;
  if (drift.length === 0 && !docStale) {
    console.log('gen:su-decomposition: up to date');
    process.exit(0);
  }
  for (const d of drift) console.error(`DRIFT ${d.status}: ${join('libs/papercusp/packages/harness', d.path)}`);
  if (docStale) console.error(`DRIFT stale: ${relative(cwd, DOC)} §9`);
  // This checker is also exposed from packages/operator-core, whose package.json
  // deliberately declares only the gate. Name the writer's real package boundary so
  // the remediation does not send callers to a nonexistent local npm script.
  console.error('run from the repository root or libs/papercusp: npm run gen:su-decomposition');
  process.exit(1);
}

for (const p of writeSuPartDocuments(HARNESS)) console.log(`wrote ${relative(cwd, p)}`);
if (doc !== wantDoc) {
  writeFileSync(DOC, wantDoc, 'utf8');
  console.log(`wrote ${relative(cwd, DOC)} §9`);
} else {
  console.log(`${relative(cwd, DOC)} §9 unchanged`);
}
