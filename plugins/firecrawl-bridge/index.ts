/**
 * @papercupai/firecrawl-bridge — managed Firecrawl access for heavy
 * research workloads.
 *
 * Typed source. Runtime artifact lives in index.cjs (loader uses
 * createRequire); edit both in lockstep until we add a build step.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import type { Plugin, ToolHandler } from '@papercusp/plugin-sdk';

interface ScrapeInput {
  url: string;
  formats?: Array<'markdown' | 'html' | 'rawHtml' | 'screenshot' | 'links'>;
  onlyMainContent?: boolean;
}

interface ExtractInput {
  urls: string[];
  schema: Record<string, unknown>;
  prompt?: string;
}

interface MapInput {
  url: string;
  limit?: number;
}

interface CrawlInput {
  url: string;
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  formats?: Array<'markdown' | 'html' | 'rawHtml' | 'links'>;
  onlyMainContent?: boolean;
}

interface FirecrawlConfig {
  apiBase?: string;
  inlineThresholdChars?: number;
  crawlPollIntervalMs?: number;
  crawlMaxWaitSec?: number;
}

const DEFAULT_API_BASE = 'https://api.firecrawl.dev';
const DEFAULT_INLINE_THRESHOLD = 50_000;
// Firecrawl's own crawl default is 10,000 pages — every page costs a credit,
// so the bridge sets its own small default and a hard ceiling.
const CRAWL_DEFAULT_LIMIT = 10;
const CRAWL_MAX_LIMIT = 100;
const CRAWL_DEFAULT_DEPTH = 2;
const CRAWL_MAX_DEPTH = 10;
const CRAWL_DEFAULT_POLL_MS = 2_000;
// The manifest gives crawl timeoutSec 300; stop waiting (and cancel the remote
// job) well before the host kills the call.
const CRAWL_DEFAULT_MAX_WAIT_SEC = 240;
const CRAWL_MAX_WAIT_CEILING_SEC = 280;
const CRAWL_PAGE_FIELDS = ['markdown', 'html', 'rawHtml', 'links'] as const;

async function readConfig(stateDir: string | undefined): Promise<FirecrawlConfig> {
  if (!stateDir) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_firecrawl-bridge', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as FirecrawlConfig;
  } catch {
    return {};
  }
}

type FirecrawlResult = { ok: true; data: any } | { ok: false; error: string };

/**
 * One authenticated Firecrawl request. `target` is an API path (`/v1/...`) or
 * an absolute URL the caller has already checked is on the API origin.
 */
async function requestFirecrawl(
  ctx: any,
  method: 'GET' | 'POST' | 'DELETE',
  target: string,
  payload?: Record<string, unknown>,
  signal: AbortSignal | undefined = ctx.signal,
): Promise<FirecrawlResult> {
  const cfg = await readConfig(ctx.stateDir);
  const apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
  const apiKey = ctx.secret ? await ctx.secret('FIRECRAWL_API_KEY') : null;
  if (!apiKey) {
    return { ok: false, error: 'FIRECRAWL_API_KEY not configured.' };
  }
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (payload) headers['content-type'] = 'application/json';
  const res = await fetch(/^https?:\/\//.test(target) ? target : `${apiBase}${target}`, {
    method,
    headers,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Firecrawl API ${res.status} ${res.statusText}: ${text.slice(0, 1000)}` };
  }
  return { ok: true, data: await res.json() };
}

function callFirecrawl(ctx: any, endpoint: string, payload: Record<string, unknown>): Promise<FirecrawlResult> {
  return requestFirecrawl(ctx, 'POST', endpoint, payload);
}

async function shapeOutput(content: string, ctx: any, tag: string) {
  const cfg = await readConfig(ctx.stateDir);
  const inlineThreshold = cfg.inlineThresholdChars ?? DEFAULT_INLINE_THRESHOLD;
  if (content.length < inlineThreshold) {
    return { content: [{ type: 'text' as const, text: content }] };
  }
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const ts = Date.now();
  const scratchDir = join(ctx.stateDir ?? ctx.projectDir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const fullPath = join(scratchDir, `firecrawl-${tag}-${sha}-${ts}.json`);
  await writeFile(fullPath, content, 'utf8');
  const summary = {
    path: fullPath,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    charCount: content.length,
    sample: content.slice(0, 500),
    note: `Output exceeded inline threshold (${inlineThreshold} chars).`,
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
}

const scrape: ToolHandler<ScrapeInput> = async (input, ctx) => {
  if (!input || typeof input.url !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'scrape: input.url is required' }] };
  }
  ctx.progress(0, `firecrawl scrape ${input.url}`);
  const r = await callFirecrawl(ctx, '/v1/scrape', {
    url: input.url,
    formats: input.formats ?? ['markdown'],
    onlyMainContent: input.onlyMainContent !== false,
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  const data = (r.data && r.data.data) ?? r.data;
  return shapeOutput(JSON.stringify(data, null, 2), ctx, 'scrape');
};

const extract: ToolHandler<ExtractInput> = async (input, ctx) => {
  if (!input || !Array.isArray(input.urls) || input.urls.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'extract: input.urls must be a non-empty array' }] };
  }
  if (!input.schema || typeof input.schema !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'extract: input.schema must be a JSON Schema object' }] };
  }
  ctx.progress(0, `firecrawl extract ${input.urls.length} URL(s)`);
  const r = await callFirecrawl(ctx, '/v1/extract', {
    urls: input.urls,
    schema: input.schema,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  return shapeOutput(JSON.stringify(r.data, null, 2), ctx, 'extract');
};

const map: ToolHandler<MapInput> = async (input, ctx) => {
  if (!input || typeof input.url !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'map: input.url is required' }] };
  }
  ctx.progress(0, `firecrawl map ${input.url}`);
  const r = await callFirecrawl(ctx, '/v1/map', {
    url: input.url,
    limit: typeof input.limit === 'number' ? input.limit : 100,
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  return shapeOutput(JSON.stringify(r.data, null, 2), ctx, 'map');
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function shapeCrawlPage(page: any): Record<string, unknown> {
  const meta = (page && page.metadata) || {};
  const out: Record<string, unknown> = {
    url: meta.sourceURL ?? meta.url ?? null,
    title: meta.title ?? null,
    statusCode: meta.statusCode ?? null,
  };
  for (const field of CRAWL_PAGE_FIELDS) {
    if (page && page[field] !== undefined) out[field] = page[field];
  }
  return out;
}

/** Best-effort cancel so an abandoned crawl stops spending credits. */
async function cancelCrawl(ctx: any, id: string): Promise<boolean> {
  try {
    const r = await requestFirecrawl(ctx, 'DELETE', `/v1/crawl/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(10_000));
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Bounded site crawl: start an async Firecrawl crawl job, poll it until it
 * finishes or the wait budget runs out, then return the pages. A crawl that
 * outlives the budget (or is aborted) is cancelled remotely and its partial
 * pages are returned with `incomplete: true`.
 */
const crawl: ToolHandler<CrawlInput> = async (input, ctx) => {
  if (!input || typeof input.url !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'crawl: input.url is required' }] };
  }
  const cfg = await readConfig(ctx.stateDir);
  const apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
  const limit = clampInt(input.limit, CRAWL_DEFAULT_LIMIT, 1, CRAWL_MAX_LIMIT);
  const maxDepth = clampInt(input.maxDepth, CRAWL_DEFAULT_DEPTH, 0, CRAWL_MAX_DEPTH);
  const pollMs = clampInt(cfg.crawlPollIntervalMs, CRAWL_DEFAULT_POLL_MS, 1, 60_000);
  const maxWaitMs = clampInt(cfg.crawlMaxWaitSec, CRAWL_DEFAULT_MAX_WAIT_SEC, 1, CRAWL_MAX_WAIT_CEILING_SEC) * 1000;
  const formats = Array.isArray(input.formats) && input.formats.length > 0 ? input.formats : ['markdown'];

  ctx.progress(0, `firecrawl crawl ${input.url} (limit ${limit}, depth ${maxDepth})`);
  const started = await callFirecrawl(ctx, '/v1/crawl', {
    url: input.url,
    limit,
    maxDepth,
    ...(Array.isArray(input.includePaths) && input.includePaths.length > 0 ? { includePaths: input.includePaths } : {}),
    ...(Array.isArray(input.excludePaths) && input.excludePaths.length > 0 ? { excludePaths: input.excludePaths } : {}),
    scrapeOptions: { formats, onlyMainContent: input.onlyMainContent !== false },
  });
  if (!started.ok) {
    return { isError: true, content: [{ type: 'text', text: started.error }] };
  }
  const id = started.data && typeof started.data.id === 'string' ? started.data.id : null;
  if (!id) {
    return {
      isError: true,
      content: [{ type: 'text', text: `crawl: Firecrawl did not return a crawl id: ${JSON.stringify(started.data).slice(0, 500)}` }],
    };
  }

  const statusPath = `/v1/crawl/${encodeURIComponent(id)}`;
  const deadline = Date.now() + maxWaitMs;
  let status: any = null;
  let stopReason: 'timeout' | 'aborted' | null = null;
  for (;;) {
    let r: FirecrawlResult;
    try {
      r = await requestFirecrawl(ctx, 'GET', statusPath);
    } catch (err) {
      if (ctx.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      throw err;
    }
    if (!r.ok) {
      await cancelCrawl(ctx, id);
      return { isError: true, content: [{ type: 'text', text: `crawl ${id}: ${r.error}` }] };
    }
    status = r.data;
    const total = typeof status?.total === 'number' ? status.total : 0;
    const completed = typeof status?.completed === 'number' ? status.completed : 0;
    if (status?.status === 'completed') break;
    if (status?.status === 'failed' || status?.status === 'cancelled') {
      return {
        isError: true,
        content: [{ type: 'text', text: `crawl ${id} ended with status '${status.status}' (${completed}/${total} pages).` }],
      };
    }
    ctx.progress(total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : 1, `crawl ${id}: ${completed}/${total} pages`);
    if (Date.now() + pollMs > deadline) {
      stopReason = 'timeout';
      break;
    }
    try {
      await sleep(pollMs, ctx.signal);
    } catch {
      stopReason = 'aborted';
      break;
    }
  }

  const pages: Record<string, unknown>[] = [];
  const addPages = (data: unknown) => {
    if (!Array.isArray(data)) return;
    for (const page of data) {
      if (pages.length >= limit) return;
      pages.push(shapeCrawlPage(page));
    }
  };
  addPages(status?.data);

  let nextRefused: string | null = null;
  if (!stopReason) {
    // A completed crawl pages its data through `next` (absolute URLs). Follow
    // them only on the API origin: the request carries the API key.
    const apiOrigin = new URL(apiBase).origin;
    let next: unknown = status?.next;
    while (typeof next === 'string' && next.length > 0 && pages.length < limit) {
      let nextOrigin: string | null = null;
      try {
        nextOrigin = new URL(next).origin;
      } catch {
        nextOrigin = null;
      }
      if (nextOrigin !== apiOrigin) {
        nextRefused = next;
        break;
      }
      const r = await requestFirecrawl(ctx, 'GET', next);
      if (!r.ok) {
        return { isError: true, content: [{ type: 'text', text: `crawl ${id}: ${r.error}` }] };
      }
      addPages(r.data?.data);
      next = r.data?.next;
    }
  }

  const cancelled = stopReason ? await cancelCrawl(ctx, id) : false;
  ctx.progress(100, stopReason ? `crawl ${id} stopped (${stopReason})` : 'done');
  const result = {
    id,
    status: stopReason ? (stopReason === 'timeout' ? 'timed-out' : 'aborted') : 'completed',
    incomplete: stopReason !== null,
    ...(stopReason ? { cancelled, note: `Crawl did not finish within ${Math.round(maxWaitMs / 1000)}s; returning the pages collected so far.` } : {}),
    total: typeof status?.total === 'number' ? status.total : null,
    completed: typeof status?.completed === 'number' ? status.completed : null,
    creditsUsed: typeof status?.creditsUsed === 'number' ? status.creditsUsed : null,
    pageCount: pages.length,
    ...(nextRefused ? { nextRefused: `Did not follow off-origin pagination URL ${nextRefused}` } : {}),
    pages,
  };
  return shapeOutput(JSON.stringify(result, null, 2), ctx, 'crawl');
};

export const tools: Record<string, ToolHandler> = {
  scrape: scrape as ToolHandler,
  extract: extract as ToolHandler,
  crawl: crawl as ToolHandler,
  map: map as ToolHandler,
};

const plugin: Plugin = {
  name: '@papercupai/firecrawl-bridge',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Managed Firecrawl access — scrape, extract, crawl, map.',
  capabilities: [
    'tools:firecrawl:scrape',
    'tools:firecrawl:extract',
    'tools:firecrawl:crawl',
    'tools:firecrawl:map',
    'http:fetch:api.firecrawl.dev',
    'secrets:read:FIRECRAWL_API_KEY',
  ],
  tools,
};

export default plugin;
