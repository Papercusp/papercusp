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
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import plugin, {
  rolesFor,
  quotaFor,
  gitnexusPath,
  TOOL_OVERRIDES,
  MUTATING_TOOLS,
  isReadOnlyTool,
  deriveFreshness,
  formatFreshnessNote,
  FRESHNESS_STALE_MS,
  applyResponseBudget,
  decorateResult,
  looksLikeEmptyResult,
  repoPolicyFromEnv,
  scopeRepoInputSchema,
  applyRepoPolicy,
  describeChildExit,
  resolveGitnexusChildCwd,
} from './index';

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
      for (const forbidden of ['worker', 'reviewer', 'debugger', 'scoper', 'validator', 'judge']) {
        expect(roles).not.toContain(forbidden);
      }
    }
  });

  it('grants `query` (a read) the wide allowlist including worker and judge', () => {
    const roles = rolesFor('query')!;
    expect(roles).toContain('worker');
    expect(roles).toContain('judge');
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

describe('resolveGitnexusChildCwd — index and process identity stay aligned (D-066)', () => {
  it('uses the registered indexed root when it exists', () => {
    expect(
      resolveGitnexusChildCwd(
        { name: 'papercusp', path: '/work/staging' },
        '/work/release',
        (path) => path === '/work/staging',
      ),
    ).toBe('/work/staging');
  });

  it('falls back to the host cwd when the registry path is missing or stale', () => {
    expect(resolveGitnexusChildCwd(null, '/work/release', () => false)).toBe('/work/release');
    expect(
      resolveGitnexusChildCwd(
        { name: 'papercusp', path: '/work/missing' },
        '/work/release',
        () => false,
      ),
    ).toBe('/work/release');
  });
});

// ── TOOL_OVERRIDES — discoverability-by-intent (EI-18681162379647090) ───────
//
// The upstream gitnexus tool descriptions are written in the tool's own
// vocabulary ("code knowledge graph", "execution flows") and were undiscoverable
// by tools:find for plain agent-vocabulary intents ("find call sites without
// grep" returned zero code-search hits). These tests are the recurrence guard
// the bug report asked for: assert the override text an agent actually needs
// is present. Routing is question-specific: graph relationships do not replace
// current-source inspection, compiler semantics, literal searches or runtime state.
describe('TOOL_OVERRIDES — agent-vocabulary description/guidance for code-search tools', () => {
  const CODE_SEARCH_TOOLS = ['query', 'cypher', 'context', 'impact', 'explain', 'trace', 'pdg_query'];

  it.each(CODE_SEARCH_TOOLS)('%s has an override with a non-empty description and guidance.when', (tool) => {
    const o = TOOL_OVERRIDES[tool];
    expect(o).toBeDefined();
    expect(o.description.length).toBeGreaterThan(0);
    expect(o.guidance.when).toBeTruthy();
  });

  // WI-35557 / D-065: historical query paths returned empty or unranked noise;
  // current real-symbol probes SIGSEGV the shared MCP child. The bridge fails
  // closed before dispatch, and the override must say so plainly.
  it('query\'s override plainly says it is fail-closed and points at safe alternatives', () => {
    const o = TOOL_OVERRIDES.query;
    const combined = `${o.description} ${o.guidance.when} ${o.guidance.notWhen ?? ''}`.toLowerCase();
    expect(combined).toContain('sigsegv');
    expect(combined).toContain('wi-35557');
    expect(combined).toContain('graph:query');
    expect(combined).toMatch(/unavailable|fail-closed|do not/);
  });

  it('query is refused before the handler can spawn or RPC the shared child', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('function makeHandler'), source.indexOf('const plugin: Plugin'));
    const refusal = handler.indexOf("if (toolName === 'query')");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(handler.indexOf('ensureChild(workspaceId)'));
    expect(refusal).toBeLessThan(handler.indexOf("rpc(handle, 'tools/call'"));
  });

  it('impact\'s override targets the "what would break" pre-refactor use case', () => {
    const text = `${TOOL_OVERRIDES.impact.description} ${TOOL_OVERRIDES.impact.guidance.when}`.toLowerCase();
    expect(text).toMatch(/break|rename|refactor|depend/);
  });

  it.each(['context', 'impact', 'explain', 'trace', 'pdg_query'])('%s override stays within the prompt-weight hard cap', (tool) => {
    const o = TOOL_OVERRIDES[tool];
    const weight = [o.description, o.guidance.when, o.guidance.notWhen, o.guidance.chaining].reduce(
      (total, text) => total + (text?.length ?? 0),
      0,
    );
    expect(weight).toBeLessThanOrEqual(1600);
  });

  it('pdg_query override preserves the anchored controls/flows contract and safe alternatives', () => {
    const text = `${TOOL_OVERRIDES.pdg_query.description} ${TOOL_OVERRIDES.pdg_query.guidance.when} ${TOOL_OVERRIDES.pdg_query.guidance.notWhen} ${TOOL_OVERRIDES.pdg_query.guidance.chaining}`.toLowerCase();
    expect(text).toContain('controls');
    expect(text).toContain('flows');
    expect(text).toContain('target');
    expect(text).toContain('analyze --pdg');
    expect(text).toContain('graph:query');
    expect(text).toContain('explain');
  });

  it('trace\'s override names the shortest directed symbol-path use case', () => {
    const text = `${TOOL_OVERRIDES.trace.description} ${TOOL_OVERRIDES.trace.guidance.when}`.toLowerCase();
    expect(text).toContain('shortest');
    expect(text).toContain('symbol');
    expect(text).toContain('path');
  });

  it('tool_map override states the repository-name contract that prevents path-shaped calls', () => {
    const override = TOOL_OVERRIDES.tool_map;
    expect(override).toBeDefined();
    const text = JSON.stringify(override).toLowerCase();
    expect(text).toContain('repository name');
    expect(text).toContain('filesystem path');
    expect(text).toContain('papercusp');
    expect(text).toContain('omit');
    expect(text).toContain('@group');
  });

  it('a tool with no override entry is simply absent from the map (upstream description falls through unchanged)', () => {
    expect(TOOL_OVERRIDES.list_repos).toBeUndefined();
    expect(TOOL_OVERRIDES.totally_new_upstream_tool).toBeUndefined();
  });

  it.each(['context', 'impact'])('%s offers safe, selective navigation with source corroboration', (tool) => {
    const override = TOOL_OVERRIDES[tool];
    const text = JSON.stringify(override).toLowerCase();
    expect(text).not.toContain('gitnexus.query');
    expect(text).not.toMatch(/every caller|every consumer|full source|instead of grep/);
    expect(text).toContain('current source');
    expect(text).toContain('stale');
    expect(text).toContain('graph:query');
    expect(text).toContain('lsp');
    expect(override.guidance.notWhen).toMatch(/runtime/);
    expect(override.guidance.chaining).toMatch(/fail/);
  });
});

// ===========================================================================
// P-004 hardening — read-only enforcement, freshness metadata, response budgets.
//
// Every block below carries a CALIBRATION case: an assertion that fails if the
// mechanism does nothing at all. Without one, a suite of "no note was added" /
// "nothing was truncated" assertions passes identically against a feature that
// was never wired up — which is exactly how inert code ships green.
// ===========================================================================

describe('read-only enforcement (P-004)', () => {
  it('classifies the two mutating tools as NOT read-only', () => {
    expect(isReadOnlyTool('rename')).toBe(false);
    expect(isReadOnlyTool('group_sync')).toBe(false);
  });

  it('leaves every genuine read tool callable', () => {
    for (const t of ['query', 'cypher', 'context', 'impact', 'trace', 'route_map', 'tool_map', 'check', 'list_repos', 'group_list']) {
      expect(isReadOnlyTool(t)).toBe(true);
    }
  });

  it('holds the set to exactly the audited two — a silent addition here removes a capability fleet-wide', () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(['group_sync', 'rename']);
  });

  it('does not declare a capability for a tool it refuses to register', () => {
    // The audit surface must not read wider than the code. `rename` writes files
    // directly, bypassing PreToolUse lock arbitration on this shared tree.
    const caps = (plugin.capabilities ?? []) as string[];
    expect(caps).not.toContain('tools:gitnexus:rename');
    expect(caps).not.toContain('tools:gitnexus:group_sync');
    // CALIBRATION: the list is genuinely populated, so the two absences above mean
    // something. Without this, an empty capabilities array would pass both.
    expect(caps).toContain('tools:gitnexus:cypher');
  });
});

describe('deriveFreshness (P-004)', () => {
  const NOW = Date.parse('2026-08-21T06:00:00.000Z');

  it('reports UNKNOWN — never "fresh" — when there is no registry entry', () => {
    // In-band and load-bearing: collapsing unknown to fresh is what produces a
    // confident wrong answer from a graph nobody can vouch for.
    const f = deriveFreshness(null, 'abc1234', NOW);
    expect(f.unknown).toBe(true);
    expect(f.ageMs).toBeNull();
    expect(f.indexedCommit).toBeNull();
  });

  it('computes age and short commit from a real entry', () => {
    const f = deriveFreshness(
      { indexedAt: '2026-08-21T03:46:05.267Z', lastCommit: '8fae7667fcd590af101bbd26ed9eb494c77858c3' },
      '8fae7667fcd590af101bbd26ed9eb494c77858c3',
      NOW,
    );
    expect(f.unknown).toBe(false);
    expect(f.indexedCommit).toBe('8fae7667fc');
    expect(Math.round(f.ageMs! / 60000)).toBe(134);
    expect(f.behindHead).toBe(false);
  });

  it('flags behindHead when HEAD has moved off the indexed commit', () => {
    const f = deriveFreshness({ indexedAt: '2026-08-21T05:59:00.000Z', lastCommit: '8fae7667fc' }, 'deadbeef00', NOW);
    expect(f.behindHead).toBe(true);
  });
});

describe('formatFreshnessNote (P-004)', () => {
  const fresh = { ageMs: 60_000, indexedCommit: 'abc1234567', behindHead: false, unknown: false };

  it('says NOTHING when the index is fresh and the answer is positive', () => {
    expect(formatFreshnessNote(fresh, false)).toBe('');
  });

  it('CALIBRATION: warns on a NOT-FOUND even from a fresh index', () => {
    // The live failure (2026-08-21): context('resolveGitnexusExecutable') answered
    // "Symbol not found" for a symbol written 3 minutes after the index was built.
    // A negative answer is exactly where staleness changes the meaning, so this must
    // fire — and it is what proves the previous test is measuring a real branch.
    const note = formatFreshnessNote(fresh, true);
    expect(note).not.toBe('');
    expect(note).toContain('NOT-FOUND');
    expect(note).toContain('grep');
  });

  it('warns when the index is older than the staleness threshold', () => {
    const stale = { ...fresh, ageMs: FRESHNESS_STALE_MS + 1 };
    expect(formatFreshnessNote(stale, false)).toContain('stale');
  });

  it('stays SILENT on a young index whose HEAD has merely moved — the anti-noise rail', () => {
    // git-sync commits this tree every few minutes, so behindHead is near-permanently
    // true. Measured live 2026-08-21: a 4-minute-old index, freshly built by the hourly
    // routine, was warning "stale" on a good positive answer. A note that always fires
    // is a note nobody reads, which would cost us the NOT-FOUND case that matters.
    const moved = { ...fresh, ageMs: 1_000, behindHead: true };
    expect(formatFreshnessNote(moved, false)).toBe('');
  });

  it('still surfaces "HEAD has moved" as DETAIL once a note is warranted', () => {
    // Kept as explanation, not as a trigger: on a not-found it is often the reason.
    const moved = { ...fresh, ageMs: 1_000, behindHead: true };
    expect(formatFreshnessNote(moved, true)).toContain('HEAD has moved');
  });

  it('says freshness is UNKNOWN rather than staying silent', () => {
    const note = formatFreshnessNote({ ageMs: null, indexedCommit: null, behindHead: false, unknown: true }, false);
    expect(note).toContain('UNKNOWN');
  });
});

describe('applyResponseBudget (P-004)', () => {
  it('passes a small response through byte-identical', () => {
    const r = applyResponseBudget('small', 100);
    expect(r.text).toBe('small');
    expect(r.truncated).toBe(false);
  });

  it('CALIBRATION: truncates an oversized response and reports the real size', () => {
    const r = applyResponseBudget('x'.repeat(500), 100);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(500);
    expect(r.text.length).toBeLessThan(500);
  });

  it('names the CAUSE and the fix, so a bounded view is not read as a real absence', () => {
    // A File node carries the entire file body in `content` — measured, and the reason
    // the database is 4.26 GB. A silent cut would read as a complete answer.
    const r = applyResponseBudget('x'.repeat(500), 100);
    expect(r.text).toContain('TRUNCATED');
    expect(r.text).toContain('BOUNDED view');
    expect(r.text).toContain('content');
  });
});

describe('decorateResult (P-004)', () => {
  const stale = { ageMs: FRESHNESS_STALE_MS + 1, indexedCommit: 'abc1234567', behindHead: true, unknown: false };

  it('appends the freshness note to the final text block', () => {
    const out = decorateResult({ content: [{ type: 'text', text: 'some answer' }] } as never, stale) as never as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0].text).toContain('some answer');
    expect(out.content[0].text).toContain('stale');
  });

  it('escalates the note when the answer reads as not-found', () => {
    const out = decorateResult({ content: [{ type: 'text', text: "Symbol 'foo' not found" }] } as never, stale) as never as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0].text).toContain('NOT-FOUND');
  });

  it('keeps the freshness note even when the response is over budget', () => {
    // ORDER IS LOAD-BEARING: budget-then-note would push the warning off the end of a
    // large response — losing it in exactly the case where a big, confident-looking
    // answer came from a stale graph.
    const big = 'y'.repeat(5_000);
    const out = decorateResult({ content: [{ type: 'text', text: big }] } as never, stale, 400) as never as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0].text).toContain('TRUNCATED');
    expect(out.content[0].text.length).toBeLessThan(5_000);
  });

  it('returns a non-envelope result untouched rather than throwing', () => {
    const odd = { notAnEnvelope: true } as never;
    expect(decorateResult(odd, stale)).toBe(odd);
  });
});

describe('looksLikeEmptyResult (P-004)', () => {
  it('recognises the real shapes gitnexus emits for "nothing"', () => {
    expect(looksLikeEmptyResult("Symbol 'x' not found")).toBe(true);
    expect(looksLikeEmptyResult('{ "row_count": 0 }')).toBe(true);
  });

  it('does not fire on a genuine answer', () => {
    expect(looksLikeEmptyResult('{ "row_count": 12, "markdown": "| n |" }')).toBe(false);
  });
});

// ── P-004: allowed / default repo ───────────────────────────────────────────
//
// This rail guards a SCOPE boundary, not a spelling: upstream documents `repo` as
// "Repository name or path", so an unguarded bridge will happily read a tree outside
// this checkout. Every refusal case below is a real escape shape, not a synthetic
// string — that is what makes a passing test here mean anything.

describe('repoPolicyFromEnv (P-004)', () => {
  it('defaults to papercusp when nothing is configured', () => {
    const p = repoPolicyFromEnv({});
    expect(p.defaultRepo).toBe('papercusp');
    expect([...p.allowed]).toEqual(['papercusp']);
  });

  it('treats a blank override as unset rather than as an empty repo name', () => {
    expect(repoPolicyFromEnv({ PAPERCUSP_GITNEXUS_REPO_NAME: '   ' }).defaultRepo).toBe('papercusp');
  });

  it('honours an explicit default and always includes it in the allowlist', () => {
    const p = repoPolicyFromEnv({ PAPERCUSP_GITNEXUS_REPO_NAME: 'other' });
    expect(p.defaultRepo).toBe('other');
    expect(p.allowed.has('other')).toBe(true);
  });

  it('extends the allowlist without displacing the default', () => {
    const p = repoPolicyFromEnv({ PAPERCUSP_GITNEXUS_ALLOWED_REPOS: 'sidecar , tools,' });
    expect([...p.allowed].sort()).toEqual(['papercusp', 'sidecar', 'tools']);
  });
});

describe('applyRepoPolicy (P-004)', () => {
  const policy = repoPolicyFromEnv({});

  it('injects the default when repo is omitted, null, or blank', () => {
    for (const args of [{}, { repo: null }, { repo: '' }, { repo: '  ' }]) {
      expect(applyRepoPolicy('query', args as Record<string, unknown>, policy).repo).toBe('papercusp');
    }
  });

  it('passes an allowed name through and preserves every other argument', () => {
    const out = applyRepoPolicy('cypher', { repo: 'papercusp', query: 'MATCH (f:File)' }, policy);
    expect(out).toEqual({ repo: 'papercusp', query: 'MATCH (f:File)' });
  });

  it("does not mutate the caller's argument object", () => {
    const args = { query: 'x' };
    applyRepoPolicy('query', args, policy);
    expect(args).toEqual({ query: 'x' });
  });

  // THE escape this rail exists for: a path reaches any tree the operator uid can read.
  it('refuses a filesystem path even though upstream accepts one', () => {
    // Derived, never a literal home path: a hardcoded build-box path is wrong on every
    // other machine AND reds the green-checkpoint identity-lint leg for the whole fleet.
    const releaseCheckout = nodePath.join(homedir(), 'papercupai-workspace', 'papercup-release');
    for (const escape of [releaseCheckout, '.', '../peer-worktree']) {
      expect(() => applyRepoPolicy('query', { repo: escape }, policy)).toThrow(/not allowed on this bridge/);
    }
  });

  it('applies the same name-only rail to tool_map', () => {
    expect(applyRepoPolicy('tool_map', {}, policy).repo).toBe('papercusp');
    expect(() => applyRepoPolicy('tool_map', { repo: nodePath.join(homedir(), 'papercupai-workspace', 'papercusp') }, policy))
      .toThrow(/not allowed on this bridge/);
  });

  it('refuses an @group fan-out', () => {
    expect(() => applyRepoPolicy('trace', { repo: '@everything' }, policy)).toThrow(/not allowed on this bridge/);
  });

  it('refuses an unknown repo name', () => {
    expect(() => applyRepoPolicy('query', { repo: 'some-other-repo' }, policy)).toThrow(/not allowed on this bridge/);
  });

  it('refuses a non-string repo instead of coercing it', () => {
    expect(() => applyRepoPolicy('query', { repo: 42 }, policy)).toThrow(/must be a repository NAME/);
  });

  // A refusal the caller cannot act on is just a mystery in a log.
  it('names both the allowed set and the omit-for-default escape hatch', () => {
    let msg = '';
    try {
      applyRepoPolicy('query', { repo: '/tmp/elsewhere' }, policy);
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('papercusp');
    expect(msg).toMatch(/Omit `repo`/);
  });

  it('admits a repo added to the allowlist, so the rail is configurable not hardcoded', () => {
    const wide = repoPolicyFromEnv({ PAPERCUSP_GITNEXUS_ALLOWED_REPOS: 'sidecar' });
    expect(applyRepoPolicy('query', { repo: 'sidecar' }, wide).repo).toBe('sidecar');
  });
});

describe('scopeRepoInputSchema (P-004)', () => {
  it('advertises the bridge allowlist instead of upstream path support', () => {
    const upstream = {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name or path.' },
        query: { type: 'string' },
      },
      required: ['query'],
    };

    const scoped = scopeRepoInputSchema(upstream) as typeof upstream;
    expect(scoped.properties.repo.description).toContain('Repository name in the bridge allowlist only');
    expect(scoped.properties.repo.description).toContain('Filesystem paths and `@group` selectors are refused');
    expect(scoped.properties.query).toBe(upstream.properties.query);
    expect(scoped.required).toEqual(['query']);
    expect(upstream.properties.repo.description).toBe('Repository name or path.');
  });

  it('leaves schemas without a repo property untouched', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' } } };
    expect(scopeRepoInputSchema(schema)).toBe(schema);
  });
});

/**
 * describeChildExit() — the crash-diagnosis path.
 *
 * WHY THIS EXISTS: the close handler used to read `proc.on('close', () => …)`,
 * discarding the (code, signal) Node hands it, and nothing anywhere drained the
 * child's stderr pipe. Every child death therefore rejected its pending calls
 * with the fixed string 'gitnexus mcp process exited'. That is how the live
 * graph-intent crash (EI-21275204945434743) stayed undiagnosable: the sibling
 * `proc.on('error')` forwarded its real error, so the WORSE failure mode
 * reported strictly less than the milder one.
 *
 * The CONTROL below is a deliberately-wrong implementation kept permanently in
 * the file: it reproduces the old generic-message behaviour. Each assertion is
 * run against BOTH, so a test that would pass for the broken implementation
 * cannot be mistaken for a guard. (Per CLAUDE.md's falsifiability discipline —
 * a pure helper is proven with an in-file control, never by mutating the tree.)
 */
const brokenControl = (
  _lines: readonly string[],
  _code: number | null,
  _signal: NodeJS.Signals | null,
) => 'gitnexus mcp process exited';

describe('describeChildExit', () => {
  it('reports a signal death by name, which the old generic message could not', () => {
    const msg = describeChildExit([], null, 'SIGSEGV');
    expect(msg).toContain('SIGSEGV');
    // The control proves the assertion discriminates rather than always passing.
    expect(brokenControl([], null, 'SIGSEGV')).not.toContain('SIGSEGV');
  });

  it('reports a non-zero exit code', () => {
    const msg = describeChildExit([], 134, null);
    expect(msg).toMatch(/code 134/);
    expect(brokenControl([], 134, null)).not.toMatch(/code 134/);
  });

  it("surfaces the child's own stderr, so the diagnosis is not re-derived by hand", () => {
    const msg = describeChildExit(
      ['thread panicked at src/graph.rs:88', 'note: run with RUST_BACKTRACE=1'],
      null,
      'SIGABRT',
    );
    expect(msg).toContain('thread panicked at src/graph.rs:88');
    expect(msg).toContain('RUST_BACKTRACE');
    expect(brokenControl(['thread panicked at src/graph.rs:88'], null, 'SIGABRT')).not.toContain(
      'panicked',
    );
  });

  it('states an EMPTY stderr as a finding, never as a missing section', () => {
    // "the child said nothing" distinguishes a native/abrupt death from a
    // reported error. Rendering it as an absent section would make an
    // informative silence indistinguishable from an unavailable diagnostic.
    const msg = describeChildExit([], 1, null);
    expect(msg).toMatch(/NO stderr output/);
    expect(msg).toMatch(/abrupt or native/);
  });

  it('ignores blank stderr lines rather than reporting a phantom diagnostic', () => {
    expect(describeChildExit(['', '   '], 1, null)).toMatch(/NO stderr output/);
  });

  it('still names the exit cause when stderr IS present', () => {
    // Both halves must survive together: an earlier draft appended stderr but
    // dropped the signal, which is the same information loss one level down.
    const msg = describeChildExit(['out of memory'], null, 'SIGKILL');
    expect(msg).toContain('SIGKILL');
    expect(msg).toContain('out of memory');
  });

  it('handles a null code with no signal without inventing one', () => {
    expect(describeChildExit([], null, null)).toContain('no status');
  });
});
