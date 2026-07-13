import { describe, expect, it } from 'vitest';

import {
  availableEventFamilies,
  availableToolNames,
  buildPackCatalogView,
  resolveEventProvider,
  resolveToolProvider,
  type PackDescriptor,
} from './pack-model.js';

const repomix: PackDescriptor = {
  name: 'repomix',
  tools: ['repomix.pack'],
  hasRuntime: true,
  kind: 'plugin',
  source: 'installed',
  version: '1.0.0',
};

const gitTools: PackDescriptor = {
  name: 'git-tools',
  tools: ['git-tools.blame', 'git-tools.churn'],
  hasRuntime: false,
  kind: 'pack',
  source: 'installed',
};

const firecrawlListing: PackDescriptor = {
  name: 'firecrawl',
  tools: ['firecrawl.scrape', 'firecrawl.map'],
  hasRuntime: true,
  kind: 'plugin',
  source: 'cupboard',
  listingId: 'listing-ff',
};

const auditPackListing: PackDescriptor = {
  name: 'audit-pack',
  tools: ['audit-pack.scan'],
  hasRuntime: false,
  kind: 'pack',
  source: 'cupboard',
  listingId: 'listing-ap',
};

const BUILTINS = new Set(['plans:list', 'coord:send']);

function view(packs: PackDescriptor[] = [repomix, gitTools, firecrawlListing, auditPackListing]) {
  return buildPackCatalogView(packs, BUILTINS);
}

describe('buildPackCatalogView', () => {
  it('indexes installed and cupboard units separately', () => {
    const v = view();
    expect(v.installedToolIndex.get('repomix.pack')?.name).toBe('repomix');
    expect(v.installedToolIndex.get('git-tools.blame')?.name).toBe('git-tools');
    expect(v.cupboardToolIndex.get('firecrawl.scrape')?.name).toBe('firecrawl');
    expect(v.installedToolIndex.has('firecrawl.scrape')).toBe(false);
  });

  it('an installed copy shadows its own cupboard listing regardless of input order', () => {
    const installedFirecrawl: PackDescriptor = { ...firecrawlListing, source: 'installed', listingId: null };
    // cupboard listing FIRST in input — installed must still win the name.
    const v = buildPackCatalogView([firecrawlListing, installedFirecrawl], BUILTINS);
    expect(v.byName.get('firecrawl')?.source).toBe('installed');
    expect(v.packs).toHaveLength(1);
    expect(v.installedToolIndex.get('firecrawl.scrape')?.source).toBe('installed');
    expect(v.cupboardToolIndex.has('firecrawl.scrape')).toBe(false);
  });

  it('dedups units by name, first-of-source wins per tool', () => {
    const otherListing: PackDescriptor = {
      name: 'scrapers',
      tools: ['firecrawl.scrape'], // claims a tool firecrawl's listing also claims
      hasRuntime: false,
      kind: 'pack',
      source: 'cupboard',
      listingId: 'listing-sc',
    };
    const v = buildPackCatalogView([firecrawlListing, otherListing], BUILTINS);
    expect(v.cupboardToolIndex.get('firecrawl.scrape')?.name).toBe('firecrawl');
    expect(v.packs).toHaveLength(2);
  });
});

describe('resolveToolProvider', () => {
  it('resolves an installed plugin tool as available', () => {
    expect(resolveToolProvider('repomix.pack', view())).toEqual({
      tool: 'repomix.pack',
      status: 'available',
      provider: { kind: 'plugin', name: 'repomix' },
    });
  });

  it('resolves an installed code-pack tool as available with kind pack', () => {
    expect(resolveToolProvider('git-tools.churn', view())).toEqual({
      tool: 'git-tools.churn',
      status: 'available',
      provider: { kind: 'pack', name: 'git-tools' },
    });
  });

  it('resolves a built-in as available builtin', () => {
    expect(resolveToolProvider('plans:list', view())).toEqual({
      tool: 'plans:list',
      status: 'available',
      provider: { kind: 'builtin', name: 'builtin' },
    });
  });

  it('resolves a cupboard-declared tool as installable with the listing id', () => {
    expect(resolveToolProvider('firecrawl.map', view())).toEqual({
      tool: 'firecrawl.map',
      status: 'installable',
      provider: { kind: 'plugin', name: 'firecrawl', listingId: 'listing-ff' },
    });
    expect(resolveToolProvider('audit-pack.scan', view())).toEqual({
      tool: 'audit-pack.scan',
      status: 'installable',
      provider: { kind: 'pack', name: 'audit-pack', listingId: 'listing-ap' },
    });
  });

  it('returns unknown for a tool nobody provides', () => {
    expect(resolveToolProvider('nope:never', view())).toEqual({ tool: 'nope:never', status: 'unknown' });
  });
});

describe('availableToolNames', () => {
  it('is builtins ∪ installed-unit tools, excluding cupboard-only tools', () => {
    const names = availableToolNames(view());
    expect(names).toEqual(
      new Set(['plans:list', 'coord:send', 'repomix.pack', 'git-tools.blame', 'git-tools.churn']),
    );
  });
});

/* ───────────────────────────────────────────────────────────────────────
 * The EVENT axis (D-003, cupboard-public-release P-007) — the twin of the
 * tool axis above, plus the one deliberate asymmetry (builtin outranks
 * installed) that keeps this resolver consistent with the P-006 catalog merge.
 * ─────────────────────────────────────────────────────────────────────── */

/** An installed pack that provides an event family (and no tools — legal: events are their own axis). */
const deployWatcher: PackDescriptor = {
  name: 'deploy-watcher',
  tools: [],
  events: [{ family: 'deploy-watcher:settled', keyTemplate: 'deploy-watcher:settled:<env>' }],
  hasRuntime: true,
  kind: 'plugin',
  source: 'installed',
};

/** A Cupboard listing (NOT installed) that declares an event family. */
const canaryPack: PackDescriptor = {
  name: 'canary',
  tools: ['canary.check'],
  events: [{ family: 'canary:flipped', keyTemplate: 'canary:flipped:<flag>', describe: 'a canary flag flipped' }],
  hasRuntime: false,
  kind: 'pack',
  source: 'cupboard',
  listingId: 'listing-canary',
};

/** The host's builtin event registry (operator-core EVENT_CATALOG), injected. */
const builtinEvents = new Map<string, string>([
  ['deploy', 'deploy:<env>'],
  ['work-item:done', 'work-item:done:<id>'],
]);

const eventView = (extra: PackDescriptor[] = []) =>
  buildPackCatalogView([deployWatcher, canaryPack, ...extra], new Set(['plans:list']), builtinEvents);

describe('resolveEventProvider', () => {
  it('resolves a BUILTIN family as available, handing back its key template', () => {
    expect(resolveEventProvider('deploy', eventView())).toEqual({
      family: 'deploy',
      status: 'available',
      provider: { kind: 'builtin', name: 'builtin' },
      keyTemplate: 'deploy:<env>',
    });
  });

  it('resolves an INSTALLED unit’s declared family as available, attributed to that unit', () => {
    expect(resolveEventProvider('deploy-watcher:settled', eventView())).toEqual({
      family: 'deploy-watcher:settled',
      status: 'available',
      provider: { kind: 'plugin', name: 'deploy-watcher' },
      keyTemplate: 'deploy-watcher:settled:<env>',
    });
  });

  it('resolves a CUPBOARD-declared family as installable, with the listing id + template', () => {
    expect(resolveEventProvider('canary:flipped', eventView())).toEqual({
      family: 'canary:flipped',
      status: 'installable',
      provider: { kind: 'pack', name: 'canary', listingId: 'listing-canary' },
      keyTemplate: 'canary:flipped:<flag>',
    });
  });

  it('returns unknown for a family nobody provides', () => {
    expect(resolveEventProvider('nobody:emits-this', eventView())).toEqual({
      family: 'nobody:emits-this',
      status: 'unknown',
    });
  });

  // ── The load-bearing one. ────────────────────────────────────────────────
  // A pack that re-declares a BUILTIN family must NOT be reported as its
  // provider: the P-006 catalog merge REFUSES that declaration (builtin always
  // wins), and if this resolver answered "the pack provides it" the two would
  // disagree about the same family. The concrete harm of the disagreement:
  // `deploy:await` resolves its key template BY FAMILY ID, so a pack that
  // silently re-pointed `deploy` would leave every awaiter parked on a key
  // nothing ever emits — a permanent, silent hang.
  it('REFUSES to let an installed unit shadow a builtin family — builtin wins, with the BUILTIN template', () => {
    const shadower: PackDescriptor = {
      name: 'evil-pack',
      tools: [],
      events: [{ family: 'deploy', keyTemplate: 'evil-pack:deploy:<whatever>' }],
      hasRuntime: true,
      kind: 'plugin',
      source: 'installed',
    };
    const r = resolveEventProvider('deploy', eventView([shadower]));
    expect(r.status).toBe('available');
    expect(r.provider).toEqual({ kind: 'builtin', name: 'builtin' });
    // The template is the BUILTIN's — never the shadower's. This is the exact
    // byte that would strand an awaiter if the ladder were the other way round.
    expect(r.keyTemplate).toBe('deploy:<env>');
  });

  it('also refuses a CUPBOARD listing that shadows a builtin family (never even installable)', () => {
    const shadowListing: PackDescriptor = {
      name: 'squatter',
      tools: [],
      events: [{ family: 'work-item:done', keyTemplate: 'squatter:wi:<id>' }],
      hasRuntime: false,
      kind: 'pack',
      source: 'cupboard',
      listingId: 'listing-squatter',
    };
    const r = resolveEventProvider('work-item:done', eventView([shadowListing]));
    expect(r.status).toBe('available');
    expect(r.provider).toEqual({ kind: 'builtin', name: 'builtin' });
  });

  it('an INSTALLED unit still shadows a CUPBOARD listing for the same family (install beats listing)', () => {
    const installedCanary: PackDescriptor = {
      name: 'canary-local',
      tools: [],
      events: [{ family: 'canary:flipped', keyTemplate: 'canary:flipped:<flag>' }],
      hasRuntime: false,
      kind: 'pack',
      source: 'installed',
    };
    const r = resolveEventProvider('canary:flipped', eventView([installedCanary]));
    expect(r.status).toBe('available');
    expect(r.provider).toEqual({ kind: 'pack', name: 'canary-local' });
  });

  it('a unit with no events at all is inert on this axis (the common case stays unaffected)', () => {
    const view = buildPackCatalogView([repomix, gitTools], new Set(['plans:list']), builtinEvents);
    expect(resolveEventProvider('anything', view)).toEqual({ family: 'anything', status: 'unknown' });
    expect(resolveEventProvider('deploy', view).status).toBe('available');
  });

  it('defaults builtinEvents to empty when a caller omits it (back-compat with the tool-only callers)', () => {
    const view = buildPackCatalogView([deployWatcher], new Set(['plans:list']));
    expect(resolveEventProvider('deploy', view)).toEqual({ family: 'deploy', status: 'unknown' });
    // …but the installed unit's own family still resolves.
    expect(resolveEventProvider('deploy-watcher:settled', view).status).toBe('available');
  });
});

describe('availableEventFamilies', () => {
  it('is builtins ∪ installed-unit families, excluding cupboard-only ones', () => {
    expect(availableEventFamilies(eventView())).toEqual(
      new Set(['deploy', 'work-item:done', 'deploy-watcher:settled']),
    );
  });
});
