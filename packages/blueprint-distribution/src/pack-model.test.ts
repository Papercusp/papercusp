import { describe, expect, it } from 'vitest';

import {
  availableToolNames,
  buildPackCatalogView,
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
