/**
 * @papercupai/jira-sync — sync harness state to Jira Cloud.
 *
 * Reference plugin demonstrating:
 *   - Multi-secret capability-gated config (token + email + base URL)
 *   - REST-with-Basic-auth pattern (vs. slack's webhook URL)
 *   - Three actions covering create / comment / list — the canonical
 *     CRUD shape most ticketing integrations need.
 *   - Optional event listener (`createOnFeaturePassed`) that demonstrates
 *     gating behavior on a config value the user can flip in a UI.
 *
 * Auth: Jira Cloud REST API uses Basic auth with `<email>:<api-token>`
 * encoded as base64. The capability gate makes sure the substrate only
 * gives us the secrets we declared we needed, not the entire env.
 *
 * Idempotency: create-issue auto-labels each issue 'papercusp-<slug>'
 * so re-runs can find existing issues via JQL before creating a duplicate
 * (current v1 doesn't yet do the find-first; that's a TODO worth doing
 * before any auto-create-on-pass behavior ships in production).
 */
import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

interface Config {
  defaultProjectKey?: string;
  defaultIssueType?: string;
  labelPrefix?: string;
  createOnFeaturePassed?: boolean;
}

interface CreateIssueParams {
  summary: string;
  description?: string;
  projectKey?: string;
  issueType?: string;
  labels?: string[];
  /**
   * Optional idempotency key. When set, the plugin auto-labels the new issue
   * `<labelPrefix>-key-<idempotencyKey>` and searches for a pre-existing
   * issue with that label before creating. Returns the existing issue's key
   * if found, otherwise creates and returns the new key.
   *
   * Recommended source: feature_id from the harness so re-running the action
   * doesn't duplicate the issue.
   */
  idempotencyKey?: string;
}

interface PostCommentParams {
  issueKey: string;
  body: string;
}

interface ListIssuesParams {
  jql?: string;
}

interface JiraCreds {
  token: string;
  email: string;
  baseUrl: string; // e.g. https://yourorg.atlassian.net
}

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function readCreds(): Promise<JiraCreds | null> {
  // Substrate's secrets proxy is the proper path. Until it's wired through
  // ctx, fall back to env. The capability check at the registry boundary
  // already gated us to JIRA_* keys.
  const token = process.env.JIRA_API_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const baseUrl = process.env.JIRA_BASE_URL;
  if (!token || !email || !baseUrl) return null;
  return { token, email, baseUrl: baseUrl.replace(/\/+$/, '') };
}

function authHeader(creds: JiraCreds): string {
  return 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
}

function adfDoc(text: string): unknown {
  // Atlassian Document Format. Single paragraph; sufficient for v1.
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

async function jiraFetch(
  creds: JiraCreds,
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(`${creds.baseUrl}/rest/api/3${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: authHeader(creds),
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

interface CreateIssueResult {
  ok: boolean;
  result?: { issueKey: string; id: string; url: string; reused: boolean };
  error?: string;
}

async function runCreateIssue(
  ctx: PapercuspContext,
  p: Partial<CreateIssueParams>,
  signal: AbortSignal | undefined,
): Promise<CreateIssueResult> {
  if (!p.summary || typeof p.summary !== 'string') {
    return { ok: false, error: 'jira-sync: params.summary is required (string)' };
  }
  const creds = await readCreds();
  if (!creds) {
    return {
      ok: false,
      error: 'jira-sync: JIRA_API_TOKEN, JIRA_EMAIL, JIRA_BASE_URL must all be set in the substrate process env',
    };
  }
  const config = await readConfig(ctx);
  const projectKey = p.projectKey ?? config.defaultProjectKey;
  if (!projectKey) {
    return { ok: false, error: 'jira-sync: projectKey not provided and config.defaultProjectKey is unset' };
  }
  const labelPrefix = config.labelPrefix ?? 'papercusp';
  const slugLabel = `${labelPrefix}-${ctx.installSlug ?? 'unknown'}`;
  const idempotencyLabel = p.idempotencyKey ? `${labelPrefix}-key-${p.idempotencyKey}` : null;
  const labels = Array.from(new Set([...(p.labels ?? []), slugLabel, ...(idempotencyLabel ? [idempotencyLabel] : [])]));

  try {
    if (idempotencyLabel) {
      const jql = `project = "${projectKey}" AND labels = "${idempotencyLabel}"`;
      const findUrl = `/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`;
      const findRes = await jiraFetch(creds, findUrl, { method: 'GET', signal });
      if (findRes.ok) {
        const findJson = (await findRes.json()) as { total: number; issues: Array<{ id: string; key: string }> };
        if (findJson.total > 0 && findJson.issues[0]) {
          const existing = findJson.issues[0];
          return {
            ok: true,
            result: {
              issueKey: existing.key,
              id: existing.id,
              url: `${creds.baseUrl}/browse/${existing.key}`,
              reused: true,
            },
          };
        }
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'jira-sync: aborted (timeout) during find-before-create' };
  }

  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: p.issueType ?? config.defaultIssueType ?? 'Task' },
      summary: p.summary,
      ...(p.description ? { description: adfDoc(p.description) } : {}),
      labels,
    },
  };
  try {
    const r = await jiraFetch(creds, '/issue', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: `jira-sync: HTTP ${r.status}${text ? ' — ' + text.slice(0, 300) : ''}` };
    }
    const json = (await r.json()) as { id: string; key: string; self: string };
    return { ok: true, result: { issueKey: json.key, id: json.id, url: `${creds.baseUrl}/browse/${json.key}`, reused: false } };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'jira-sync: aborted (timeout)' };
    return { ok: false, error: e?.message ?? String(e) };
  }
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/jira-sync',
  version: '0.1.1',
  papercusp: '^0.1.0',
  description: 'Sync harness state to Jira Cloud (issues, comments, JQL).',
  capabilities: [
    'secrets:read:JIRA_API_TOKEN',
    'secrets:read:JIRA_EMAIL',
    'secrets:read:JIRA_BASE_URL',
    'http:fetch:*.atlassian.net',
    'events:listen:feature-passed',
    'events:listen:feature-failed',
    'events:listen:proposal-accepted',
    'events:listen:mission-done',
  ],
  actions: [
    {
      name: 'create-issue',
      label: 'Create Jira issue',
      surfaces: ['harness-toolbar', 'feature-row', 'mission-done'],
      capabilities: [
        'secrets:read:JIRA_API_TOKEN',
        'secrets:read:JIRA_EMAIL',
        'secrets:read:JIRA_BASE_URL',
        'http:fetch:*.atlassian.net',
      ],
      serverHandler: { timeoutSec: 15 },
    },
    {
      name: 'post-comment',
      label: 'Post Jira comment',
      surfaces: ['feature-row'],
      capabilities: [
        'secrets:read:JIRA_API_TOKEN',
        'secrets:read:JIRA_EMAIL',
        'secrets:read:JIRA_BASE_URL',
        'http:fetch:*.atlassian.net',
      ],
      serverHandler: { timeoutSec: 10 },
    },
    {
      name: 'list-issues',
      label: 'List Jira issues for harness',
      surfaces: ['plugin-detail'],
      capabilities: [
        'secrets:read:JIRA_API_TOKEN',
        'secrets:read:JIRA_EMAIL',
        'secrets:read:JIRA_BASE_URL',
        'http:fetch:*.atlassian.net',
      ],
      serverHandler: { timeoutSec: 15 },
    },
  ],
  async init(ctx) {
    ctx.actions!.register('create-issue', async (innerCtx, params, signal) => {
      return runCreateIssue(innerCtx, (params ?? {}) as Partial<CreateIssueParams>, signal);
    });

    ctx.actions!.register('post-comment', async (_innerCtx, params, signal) => {
      const p = (params ?? {}) as Partial<PostCommentParams>;
      if (!p.issueKey || !p.body) {
        return { ok: false, error: 'jira-sync: params.issueKey and params.body are required' };
      }
      const creds = await readCreds();
      if (!creds) return { ok: false, error: 'jira-sync: credentials not configured' };
      try {
        const r = await jiraFetch(creds, `/issue/${encodeURIComponent(p.issueKey)}/comment`, {
          method: 'POST',
          body: JSON.stringify({ body: adfDoc(p.body) }),
          signal,
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          return { ok: false, error: `jira-sync: HTTP ${r.status}${text ? ' — ' + text.slice(0, 300) : ''}` };
        }
        const json = (await r.json()) as { id: string };
        return { ok: true, result: { commentId: json.id, issueKey: p.issueKey } };
      } catch (e: any) {
        if (e?.name === 'AbortError') return { ok: false, error: 'jira-sync: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
      }
    });

    ctx.actions!.register('list-issues', async (innerCtx, params, signal) => {
      const p = (params ?? {}) as Partial<ListIssuesParams>;
      const creds = await readCreds();
      if (!creds) return { ok: false, error: 'jira-sync: credentials not configured' };
      const config = await readConfig(innerCtx);
      const labelPrefix = config.labelPrefix ?? 'papercusp';
      const slug = innerCtx.installSlug ?? 'unknown';
      const jql = p.jql ?? `labels = "${labelPrefix}-${slug}" ORDER BY created DESC`;
      try {
        const r = await jiraFetch(creds, `/search?jql=${encodeURIComponent(jql)}&fields=summary,status,labels`, {
          method: 'GET',
          signal,
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          return { ok: false, error: `jira-sync: HTTP ${r.status}${text ? ' — ' + text.slice(0, 300) : ''}` };
        }
        const json = (await r.json()) as { total: number; issues: Array<{ key: string; fields: any }> };
        return {
          ok: true,
          result: {
            total: json.total,
            issues: json.issues.map((i) => ({
              key: i.key,
              summary: i.fields?.summary,
              status: i.fields?.status?.name,
              labels: i.fields?.labels ?? [],
              url: `${creds.baseUrl}/browse/${i.key}`,
            })),
          },
        };
      } catch (e: any) {
        if (e?.name === 'AbortError') return { ok: false, error: 'jira-sync: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
      }
    });
  },
  hooks: {
    // Mission completed — auto-create a "Mission complete" Jira issue.
    // Idempotent on installSlug so replays of the mission-done event don't
    // pile up. Silent skip when not configured (no projectKey or creds).
    async afterDone(ctx: PapercuspContext) {
      const cfg = await readConfig(ctx);
      if (!cfg.defaultProjectKey) {
        ctx.log('jira-sync: afterDone — skipped (defaultProjectKey not configured)');
        return;
      }
      try {
        const r = await runCreateIssue(
          ctx,
          {
            summary: `Mission complete: ${ctx.installSlug}`,
            description: `Harness ${ctx.installSlug} reported mission-done.`,
            idempotencyKey: `mission-${ctx.installSlug}`,
          },
          undefined,
        );
        if (r.ok) {
          ctx.log(`jira-sync: afterDone → ${r.result?.issueKey}${r.result?.reused ? ' (reused)' : ''}`);
        } else {
          ctx.log(`jira-sync: afterDone failed — ${r.error}`);
        }
      } catch (e: any) {
        ctx.log(`jira-sync: afterDone threw — ${e?.message ?? String(e)}`);
      }
    },
    // Feature passed — only fires when config.createOnFeaturePassed is true.
    // Idempotent on featureId so retries don't duplicate. We never throw;
    // a CI-tracker hiccup must not be reported as a feature regression.
    async onFeaturePassed(ctx: PapercuspContext, featureId: string) {
      const cfg = await readConfig(ctx);
      if (!cfg.createOnFeaturePassed) return;
      if (!cfg.defaultProjectKey) {
        ctx.log('jira-sync: onFeaturePassed — skipped (defaultProjectKey not configured)');
        return;
      }
      try {
        const r = await runCreateIssue(
          ctx,
          {
            summary: `Feature passed: ${featureId}`,
            description: `Harness ${ctx.installSlug} reported feature ${featureId} passed validation.`,
            idempotencyKey: `feature-${featureId}`,
          },
          undefined,
        );
        if (r.ok) {
          ctx.log(`jira-sync: onFeaturePassed(${featureId}) → ${r.result?.issueKey}${r.result?.reused ? ' (reused)' : ''}`);
        } else {
          ctx.log(`jira-sync: onFeaturePassed(${featureId}) failed — ${r.error}`);
        }
      } catch (e: any) {
        ctx.log(`jira-sync: onFeaturePassed(${featureId}) threw — ${e?.message ?? String(e)}`);
      }
    },
  },
};

/* ─────────────────────────────────────────────────────────────────────
 * apiRoutes — plugin-mounted HTTP endpoints. Mounted at
 * /api/plugins/_papercupai_jira-sync/* by the host. Plain Web-Fetch
 * handler so the plugin doesn't drag the host's bundler version of Hono.
 * ───────────────────────────────────────────────────────────────────── */
const apiRoutes = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;

    if (path === '/ping' || path.endsWith('/ping')) {
      const creds = await readCreds();
      return Response.json({
        ok: true,
        plugin: '@papercupai/jira-sync',
        version: '0.1.1',
        configured: creds !== null,
      });
    }

    if ((path === '/list' || path.endsWith('/list')) && req.method === 'GET') {
      const creds = await readCreds();
      if (!creds) {
        return Response.json({ ok: false, error: 'credentials not configured' }, { status: 503 });
      }
      const jql = url.searchParams.get('jql') ?? 'ORDER BY created DESC';
      try {
        const r = await jiraFetch(creds, `/search?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=20`);
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          return Response.json({ ok: false, error: `HTTP ${r.status}${t ? ' — ' + t.slice(0, 200) : ''}` }, { status: 502 });
        }
        const json = (await r.json()) as { total: number; issues: any[] };
        return Response.json({ ok: true, total: json.total, issues: json.issues });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
      }
    }

    return Response.json({ error: 'not found', path }, { status: 404 });
  },
};

(plugin as any).apiRoutes = apiRoutes;

export default plugin;
