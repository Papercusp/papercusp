/**
 * Identity-owned observation practice sections.
 *
 * The prose lives in the selected harness's `su.practice.md` document. The
 * orchestrator and operator-core are consumers of that practice identity, so
 * they must load the same sections instead of carrying parallel TypeScript
 * constants that can drift from the interactive su render.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from '@papercusp/harness/paths';

/** Harness-relative path of the base practice identity document. */
export const OBSERVATION_PRACTICE_REL = 'blueprints/base/prompts/su.practice.md';

export const OBSERVATION_PRACTICE_MARKERS = {
  turnEndObservation: 'TURN_END_OBSERVATION',
  frictionTripwire: 'FRICTION_TRIPWIRE',
  observationRubricNudge: 'OBSERVATION_RUBRIC_NUDGE',
} as const;

export interface ObservationPracticeSections {
  turnEndObservation: string;
  frictionTripwire: string;
  observationRubricNudge: string;
  /** Absolute path of the practice document that supplied these sections. */
  sourcePath: string;
}

type ObservationPracticeKey = keyof typeof OBSERVATION_PRACTICE_MARKERS;

function marker(name: string, edge: 'BEGIN' | 'END'): string {
  return `<!-- OBSERVATION-PRACTICE:${name}:${edge} -->`;
}

function extractSection(source: string, name: string, sourcePath: string): string {
  const begin = marker(name, 'BEGIN');
  const end = marker(name, 'END');
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0 || finish < start) {
    throw new Error(
      `observation-practice: ${sourcePath} is missing a complete ${name} section ` +
        `(expected ${begin} … ${end})`,
    );
  }
  const text = source.slice(start + begin.length, finish).trim();
  if (!text) throw new Error(`observation-practice: ${sourcePath} has an empty ${name} section`);
  return text;
}

function practiceCandidates(harnessDir?: string): string[] {
  const builtIn = harnessPath(...OBSERVATION_PRACTICE_REL.split('/'));
  const selected = harnessDir ? join(harnessDir, OBSERVATION_PRACTICE_REL) : null;
  return selected && selected !== builtIn ? [selected, builtIn] : [builtIn];
}

/**
 * Load the observation clauses from the selected harness practice identity.
 * A harness without a local base practice document uses the built-in identity;
 * a present but malformed override fails loudly instead of silently mixing text.
 */
export function loadObservationPractice(harnessDir?: string): ObservationPracticeSections {
  const sourcePath = practiceCandidates(harnessDir).find((path) => existsSync(path));
  if (!sourcePath) {
    throw new Error(
      `observation-practice: no ${OBSERVATION_PRACTICE_REL} found for harness ${harnessDir ?? '(built-in)'}`,
    );
  }
  const source = readFileSync(sourcePath, 'utf8');
  const sections = Object.fromEntries(
    (Object.entries(OBSERVATION_PRACTICE_MARKERS) as Array<[ObservationPracticeKey, string]>).map(([key, name]) => [
      key,
      extractSection(source, name, sourcePath),
    ]),
  ) as Pick<ObservationPracticeSections, 'turnEndObservation' | 'frictionTripwire' | 'observationRubricNudge'>;
  return { ...sections, sourcePath };
}

