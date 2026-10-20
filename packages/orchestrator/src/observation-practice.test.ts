import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OBSERVATION_PRACTICE_REL,
  loadObservationPractice,
} from './observation-practice.js';

const practice = (turn: string, friction: string, rubric: string) => [
  `<!-- OBSERVATION-PRACTICE:TURN_END_OBSERVATION:BEGIN -->\n${turn}\n<!-- OBSERVATION-PRACTICE:TURN_END_OBSERVATION:END -->`,
  `<!-- OBSERVATION-PRACTICE:FRICTION_TRIPWIRE:BEGIN -->\n${friction}\n<!-- OBSERVATION-PRACTICE:FRICTION_TRIPWIRE:END -->`,
  `<!-- OBSERVATION-PRACTICE:OBSERVATION_RUBRIC_NUDGE:BEGIN -->\n${rubric}\n<!-- OBSERVATION-PRACTICE:OBSERVATION_RUBRIC_NUDGE:END -->`,
].join('\n');

describe('identity-owned observation practice loader', () => {
  it('loads all three sections from the built-in practice document', () => {
    const loaded = loadObservationPractice();
    expect(loaded.sourcePath).toMatch(/blueprints[\\/]base[\\/]prompts[\\/]su\.practice\.md$/);
    expect(loaded.turnEndObservation).toContain('## Turn-end observation pass');
    expect(loaded.frictionTripwire).toContain('## Bug + friction trip-wire');
    expect(loaded.observationRubricNudge).toContain('## Filing an observation?');
  });

  it('prefers a selected harness practice document over the built-in copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'observation-practice-'));
    try {
      const path = join(root, OBSERVATION_PRACTICE_REL);
      mkdirSync(join(root, 'blueprints/base/prompts'), { recursive: true });
      writeFileSync(path, practice('custom turn', 'custom friction', 'custom rubric'));
      const loaded = loadObservationPractice(root);
      expect(loaded.sourcePath).toBe(path);
      expect(loaded.turnEndObservation).toBe('custom turn');
      expect(loaded.frictionTripwire).toBe('custom friction');
      expect(loaded.observationRubricNudge).toBe('custom rubric');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a present but incomplete selected document', () => {
    const root = mkdtempSync(join(tmpdir(), 'observation-practice-'));
    try {
      const path = join(root, OBSERVATION_PRACTICE_REL);
      mkdirSync(join(root, 'blueprints/base/prompts'), { recursive: true });
      writeFileSync(path, '<!-- OBSERVATION-PRACTICE:TURN_END_OBSERVATION:BEGIN -->\nonly one');
      expect(() => loadObservationPractice(root)).toThrow(/missing a complete TURN_END_OBSERVATION/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

