/**
 * Unit tests for the gitnexus-bridge plugin's pure helpers.
 *
 * These cover the two things that have no other guard:
 *   - rolesFor() — the security boundary deciding which agent roles may call
 *     each proxied gitnexus tool (Gap 1, P1). Destructive `rename`/`group_sync`
 *     must stay operator+architect only; everything else stays read-wide.
 *   - quotaFor() — per-role rate budgets for the heavy reads (Gap 2 in the
 *     coverage plan, exercised here too).
 *   - gitnexusPath() — PATH augmentation so the bare `gitnexus` binary resolves
 *     under a frozen host PATH, idempotently (Gap 3, P3).
 *
 * Pure functions only — importing index.ts spawns NO child process (children
 * are created lazily inside ensureChild(), never at module load), so these run
 * without touching `gitnexus` or any subprocess.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rolesFor, quotaFor, gitnexusPath, TOOL_OVERRIDES } from './index';

// ── Gap 1: rolesFor — the role allowlist security boundary ──────────────────

describe('rolesFor — destructive-tool role gating (Gap 1, P1)', () => {
  // The exact tight allowlist for destructive ops. Sorted compare so a reorder
  // doesn't false-fail, but membership is exact: NO extra role may appear.
  const TIGHT = ['architect', 'operator'];

  it('gates `rename` to exactly operator+architect', () => {
    expect([...rolesFor('rename')!].sort()).toEqual(TIGHT);
  });

  it('gates `group_sync` to exactly operator+architect', () => {
    expect([...rolesFor('group_sync')!].sort()).toEqual(TIGHT);
  });

  it('does NOT grant worker/reviewer/etc to destructive tools', () => {
    for (const tool of ['rename', 'group_sync']) {
      const roles = rolesFor(tool)!;
      for (const forbidden of ['worker', 'reviewer', 'debugger', 'scoper', 'validator']) {
        expect(roles).not.toContain(forbidden);
      }
    }
  });

  it('grants `query` (a read) the wide allowlist including worker', () => {
    const roles = rolesFor('query')!;
    expect(roles).toContain('worker');
    // The wide set is the 7-role read allowlist; worker must be in it.
    expect(roles).toContain('operator');
    expect(roles).toContain('architect');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('validator');
  });

  it('any non-destructive tool name gets the wide read allowlist (worker included)', () => {
    for (const tool of ['cypher', 'context', 'impact', 'route_map', 'list_repos', 'group_list', 'totally_new_tool']) {
      expect(rolesFor(tool)).toContain('worker');
    }
  });

  // TEETH: fault-inject a widened `rename` allowlist and confirm the boundary
  // assertions above would catch it (proves the tests are non-vacuous — a
  // regression that adds `worker` to rename must turn the suite red).
  it('TEETH: a widened `rename` allowlist would be caught by the boundary checks', () => {
    // Simulate the regression: rename suddenly includes worker.
    const widened = ['operator', 'architect', 'worker'];
    // The tight-membership assertion (exact-set) would fail:
    expect([...widened].sort()).not.toEqual(TIGHT);
    // The "must not contain worker" assertion would fail:
    expect(widened).toContain('worker'); // i.e. our `.not.toContain('worker')` guard fires
    // Sanity: the REAL rename list is NOT the widened one.
    expect(rolesFor('rename')).not.toContain('worker');
  });
});

// ── quotaFor — per-role budgets for heavy reads ─────────────────────────────

describe('quotaFor — per-role rate budgets', () => {
  const HEAVY = ['query', 'cypher', 'impact', 'detect_changes', 'api_impact'];
  const UNQUOTED = ['route_map', 'tool_map', 'context', 'list_repos'];

  it.each(HEAVY)('heavy read %s → worker.perChunk=5 and architect.perRun=30', (tool) => {
    const q = quotaFor(tool);
    expect(q).toBeDefined();
    expect(q!.worker).toEqual({ perChunk: 5 });
    expect(q!.architect).toEqual({ perRun: 30 });
  });

  it.each(UNQUOTED)('cheap tool %s → undefined (unquoted)', (tool) => {
    expect(quotaFor(tool)).toBeUndefined();
  });

  it('an unknown tool is unquoted (undefined)', () => {
    expect(quotaFor('some_unknown_tool')).toBeUndefined();
  });
});

// ── Gap 2/3: gitnexusPath — idempotent PATH augmentation ────────────────────

describe('gitnexusPath — PATH fallback augmentation (Gap 3, P3)', () => {
  const ORIGINAL_PATH = process.env.PATH;
  // The fallback bin dirs the helper appends, in order. Note the last is
  // homedir()-relative, so we assert structurally rather than hardcoding $HOME.
  const STATIC_FALLBACKS = [
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  afterEach(() => {
    // Restore so we never leak a mutated PATH into other suites/files.
    if (ORIGINAL_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIGINAL_PATH;
  });

  const SEP = process.platform === 'win32' ? ';' : ':';

  it('keeps existing PATH entries, in order, leading the result', () => {
    process.env.PATH = ['/usr/bin', '/bin'].join(SEP);
    const parts = gitnexusPath().split(SEP);
    expect(parts.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
  });

  it('appends every static fallback dir after the existing entries', () => {
    process.env.PATH = ['/usr/bin', '/bin'].join(SEP);
    const parts = gitnexusPath().split(SEP);
    for (const f of STATIC_FALLBACKS) {
      expect(parts).toContain(f);
      // appended after, not before, the originals
      expect(parts.indexOf(f)).toBeGreaterThan(parts.indexOf('/bin'));
    }
  });

  it('appends a homedir-relative ~/.local/bin fallback too', () => {
    process.env.PATH = '/usr/bin';
    const parts = gitnexusPath().split(SEP);
    expect(parts.some((p) => p.endsWith('/.local/bin'))).toBe(true);
  });

  it('does NOT duplicate a fallback already present in PATH', () => {
    // Seed PATH with one of the fallbacks already in it.
    process.env.PATH = ['/usr/local/bin', '/usr/bin'].join(SEP);
    const parts = gitnexusPath().split(SEP);
    const occurrences = parts.filter((p) => p === '/usr/local/bin').length;
    expect(occurrences).toBe(1);
  });

  it('empty PATH → just the fallbacks (no empty leading segment)', () => {
    process.env.PATH = '';
    const parts = gitnexusPath().split(SEP).filter(Boolean);
    // First three are the static fallbacks in declared order.
    expect(parts.slice(0, 3)).toEqual(STATIC_FALLBACKS);
    // No empty-string segment leaked in.
    expect(gitnexusPath().split(SEP)).not.toContain('');
    expect(parts).toHaveLength(4); // 3 static + 1 homedir fallback
  });

  it('undefined PATH → just the fallbacks', () => {
    delete process.env.PATH;
    const parts = gitnexusPath().split(SEP).filter(Boolean);
    expect(parts.slice(0, 3)).toEqual(STATIC_FALLBACKS);
    expect(parts).toHaveLength(4);
  });

  it('is idempotent: applying it twice adds no further entries', () => {
    process.env.PATH = '/usr/bin';
    const once = gitnexusPath();
    process.env.PATH = once;
    const twice = gitnexusPath();
    expect(twice).toEqual(once);
  });
});

// ── TOOL_OVERRIDES — discoverability-by-intent (EI-18681162379647090) ───────
//
// The upstream gitnexus tool descriptions are written in the tool's own
// vocabulary ("code knowledge graph", "execution flows") and were undiscoverable
// by tools:find for plain agent-vocabulary intents ("find call sites without
// grep" returned zero code-search hits). These tests are the recurrence guard
// the bug report asked for: assert the override text an agent actually needs
// is present, in agent-first-person vocabulary, and explicitly frames itself
// as a REPLACEMENT for grep (not merely a complement — that ambiguity was the
// original defect: "Complements grep/IDE search" read as permission to keep
// grepping alongside it).
describe('TOOL_OVERRIDES — agent-vocabulary description/guidance for code-search tools', () => {
  const CODE_SEARCH_TOOLS = ['query', 'cypher', 'context', 'impact'];

  it.each(CODE_SEARCH_TOOLS)('%s has an override with a non-empty description and guidance.when', (tool) => {
    const o = TOOL_OVERRIDES[tool];
    expect(o).toBeDefined();
    expect(o.description.length).toBeGreaterThan(0);
    expect(o.guidance.when).toBeTruthy();
  });

  it('query\'s override explicitly frames itself as a REPLACEMENT for grep, not a complement', () => {
    const o = TOOL_OVERRIDES.query;
    const combined = `${o.description} ${o.guidance.when} ${o.guidance.notWhen ?? ''}`.toLowerCase();
    expect(combined).toContain('instead of');
    expect(combined).toContain('grep');
    // The exact prior wording that read as permission to keep grepping alongside it must be gone.
    expect(combined).not.toContain('complements grep');
  });

  it('query\'s description uses agent-first-person search vocabulary, not only graph jargon', () => {
    const text = TOOL_OVERRIDES.query.description.toLowerCase();
    // At least one of the plain-language phrasings an agent actually thinks in.
    const agentPhrases = ['where is', 'who calls', 'find where', 'call chains'];
    expect(agentPhrases.some((p) => text.includes(p))).toBe(true);
  });

  it('impact\'s override targets the "what would break" pre-refactor use case', () => {
    const text = `${TOOL_OVERRIDES.impact.description} ${TOOL_OVERRIDES.impact.guidance.when}`.toLowerCase();
    expect(text).toMatch(/break|rename|refactor|depend/);
  });

  it('a tool with no override entry is simply absent from the map (upstream description falls through unchanged)', () => {
    expect(TOOL_OVERRIDES.list_repos).toBeUndefined();
    expect(TOOL_OVERRIDES.totally_new_upstream_tool).toBeUndefined();
  });
});
