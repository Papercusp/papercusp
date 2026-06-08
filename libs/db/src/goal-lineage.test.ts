/**
 * Tests for formatLineageForPrompt — the pure markdown renderer that injects a
 * feature's goal lineage into worker prompts ("## Why this matters").
 * Run with: npx vitest run packages/.../libs/db/src/goal-lineage.test.ts
 */
import { describe, expect, it } from 'vitest';
import { formatLineageForPrompt, type LineageRow } from './goal-lineage';

describe('formatLineageForPrompt', () => {
  it('returns "" for an empty lineage', () => {
    expect(formatLineageForPrompt([])).toBe('');
  });

  it('renders a single task as the root', () => {
    const out = formatLineageForPrompt([{ level: 0, kind: 'task', id: 'F-1', title: 'Implement OAuth' }]);
    expect(out).toBe('## Why this matters (your goal lineage)\n- Task: Implement OAuth');
  });

  it('nests parent tasks with increasing indent and "(parent task)"', () => {
    const lineage: LineageRow[] = [
      { level: 0, kind: 'task', id: 'F-1', title: 'Implement OAuth' },
      { level: 1, kind: 'task', id: 'F-0', title: 'Auth system' },
    ];
    expect(formatLineageForPrompt(lineage)).toBe(
      '## Why this matters (your goal lineage)\n' +
      '- Task: Implement OAuth\n' +
      '  - because → Auth system (parent task)',
    );
  });

  it('renders the goal row as a bolded GOAL at the deepest indent', () => {
    const lineage: LineageRow[] = [
      { level: 0, kind: 'task', id: 'F-1', title: 'Implement OAuth' },
      { level: 1, kind: 'task', id: 'F-0', title: 'Auth system' },
      { level: 99, kind: 'goal', id: 'G-1', title: 'Ship to TestFlight' },
    ];
    const out = formatLineageForPrompt(lineage);
    expect(out).toContain('    - because → **GOAL**: Ship to TestFlight');
    // Goal indent (4 spaces) is deeper than the parent task (2 spaces).
    expect(out.split('\n')[3]).toBe('    - because → **GOAL**: Ship to TestFlight');
  });
});
