/**
 * @papercupai/linear-sync — sync harness state to Linear.
 *
 * Reference plugin demonstrating:
 *   - Single-secret capability-gated config (LINEAR_API_KEY)
 *   - GraphQL-with-bearer-key pattern (vs. jira's Basic auth, slack's webhook)
 *   - Three actions (create / comment / list) — same canonical CRUD shape
 *     the other ticketing plugins offer, just over GraphQL.
 *   - Team-key → team-id resolution so users can configure a familiar
 *     "ENG" instead of a UUID.
 *
 * Auth: Linear's GraphQL endpoint accepts `Authorization: <api-key>` for
 * personal API keys (no `Bearer ` prefix) and `Authorization: Bearer <token>`
 * for OAuth. We forward whatever the user puts in LINEAR_API_KEY verbatim
 * if it already starts with `Bearer `; otherwise we send it bare.
 *
 * Idempotency: same shape as jira-sync. `idempotencyKey` → label
 * `<prefix>-key-<value>` → search-before-create.
 */
import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

interface Config {
  defaultTeamKey?: string;
  defaultTeamId?: string;
  labelPrefix?: string;
  createOnFeaturePassed?: boolean;
}

interface CreateIssueParams {
  title: string;
  description?: string;
  teamKey?: string;
  teamId?: string;
  labels?: string[];
  idempotencyKey?: string;
}

interface PostCommentParams {
  issueId?: string;
  identifier?: string;
  body: string;
}

interface ListIssuesParams {
  labelName?: string;
}

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function readKey(): Promise<string | null> {
  const k = process.env.LINEAR_API_KEY;
  if (!k) return null;
  return k;
}

function authHeader(key: string): string {
  return /^Bearer\s/i.test(key) ? key : key;
}

async function linearFetch(
  key: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
  const r = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: authHeader(key),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`linear-sync: HTTP ${r.status}${text ? ' — ' + text.slice(0, 300) : ''}`);
  }
  return (await r.json()) as { data?: any; errors?: Array<{ message: string }> };
}

async function resolveTeamId(
  key: string,
  teamKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await linearFetch(
    key,
    `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } } }`,
    { key: teamKey },
    signal,
  );
  return res.data?.teams?.nodes?.[0]?.id ?? null;
}

async function resolveLabelIds(
  key: string,
  teamId: string,
  names: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (names.length === 0) return [];
  const res = await linearFetch(
    key,
    `query($teamId: String!) { team(id: $teamId) { labels(first: 250) { nodes { id name } } } }`,
    { teamId },
    signal,
  );
  const existing: Array<{ id: string; name: string }> = res.data?.team?.labels?.nodes ?? [];
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  for (const n of names) {
    const hit = byName.get(n.toLowerCase());
    if (hit) {
      ids.push(hit);
      continue;
    }
    const created = await linearFetch(
      key,
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }`,
      { input: { name: n, teamId } },
      signal,
    );
    const newId = created.data?.issueLabelCreate?.issueLabel?.id;
    if (newId) ids.push(newId);
  }
  return ids;
}

async function findIssueByLabel(
  key: string,
  labelName: string,
  signal?: AbortSignal,
): Promise<{ id: string; identifier: string; url: string } | null> {
  const res = await linearFetch(
    key,
    `query($name: String!) {
       issues(filter: { labels: { name: { eq: $name } } }, first: 1) {
         nodes { id identifier url }
       }
     }`,
    { name: labelName },
    signal,
  );
  const node = res.data?.issues?.nodes?.[0];
  return node ?? null;
}

interface CreateIssueResult {
  ok: boolean;
  result?: { id: string; identifier: string; url: string; reused: boolean };
  error?: string;
}

async function runCreateIssue(
  ctx: PapercuspContext,
  p: Partial<CreateIssueParams>,
  signal: AbortSignal | undefined,
): Promise<CreateIssueResult> {
  if (!p.title || typeof p.title !== 'string') {
    return { ok: false, error: 'linear-sync: params.title is required (string)' };
  }
  const key = await readKey();
  if (!key) {
    return { ok: false, error: 'linear-sync: LINEAR_API_KEY must be set in the substrate process env' };
  }
  const config = await readConfig(ctx);
  const labelPrefix = config.labelPrefix ?? 'papercusp';
  const slugLabel = `${labelPrefix}-${ctx.installSlug ?? 'unknown'}`;
  const idempotencyLabel = p.idempotencyKey ? `${labelPrefix}-key-${p.idempotencyKey}` : null;

  try {
    let teamId = p.teamId ?? config.defaultTeamId;
    if (!teamId) {
      const teamKey = p.teamKey ?? config.defaultTeamKey;
      if (!teamKey) {
        return {
          ok: false,
          error: 'linear-sync: provide teamId or teamKey (or set defaultTeamKey/defaultTeamId in config)',
        };
      }
      teamId = (await resolveTeamId(key, teamKey, signal)) ?? undefined;
      if (!teamId) {
        return { ok: false, error: `linear-sync: no team found with key '${teamKey}'` };
      }
    }

    if (idempotencyLabel) {
      const existing = await findIssueByLabel(key, idempotencyLabel, signal);
      if (existing) {
        return {
          ok: true,
          result: {
            id: existing.id,
            identifier: existing.identifier,
            url: existing.url,
            reused: true,
          },
        };
      }
    }

    const labelNames = Array.from(
      new Set([...(p.labels ?? []), slugLabel, ...(idempotencyLabel ? [idempotencyLabel] : [])]),
    );
    const labelIds = await resolveLabelIds(key, teamId, labelNames, signal);

    const res = await linearFetch(
      key,
      `mutation($input: IssueCreateInput!) {
         issueCreate(input: $input) {
           success
           issue { id identifier url title }
         }
       }`,
      {
        input: {
          teamId,
          title: p.title,
          description: p.description ?? undefined,
          labelIds: labelIds.length > 0 ? labelIds : undefined,
        },
      },
      signal,
    );
    if (res.errors?.length) {
      return { ok: false, error: `linear-sync: ${res.errors.map((e) => e.message).join('; ')}` };
    }
    const issue = res.data?.issueCreate?.issue;
    if (!res.data?.issueCreate?.success || !issue) {
      return { ok: false, error: 'linear-sync: issueCreate returned success=false' };
    }
    return {
      ok: true,
      result: { id: issue.id, identifier: issue.identifier, url: issue.url, reused: false },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'linear-sync: aborted (timeout)' };
    return { ok: false, error: e?.message ?? String(e) };
  }
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/linear-sync',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Sync harness state to Linear (issues, comments, label search).',
  capabilities: [
    'secrets:read:LINEAR_API_KEY',
    'http:fetch:api.linear.app',
    'events:listen:feature-passed',
    'events:listen:feature-failed',
    'events:listen:proposal-accepted',
    'events:listen:mission-done',
  ],
  actions: [
    {
      name: 'create-issue',
      label: 'Create Linear issue',
      surfaces: ['harness-toolbar', 'feature-row', 'mission-done'],
      capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'],
      serverHandler: { timeoutSec: 15 },
    },
    {
      name: 'post-comment',
      label: 'Post Linear comment',
      surfaces: ['feature-row'],
      capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'],
      serverHandler: { timeoutSec: 10 },
    },
    {
      name: 'list-issues',
      label: 'List Linear issues for harness',
      surfaces: ['plugin-detail'],
      capabilities: ['secrets:read:LINEAR_API_KEY', 'http:fetch:api.linear.app'],
      serverHandler: { timeoutSec: 15 },
    },
  ],
  async init(ctx) {
    ctx.actions!.register('create-issue', async (innerCtx, params, signal) => {
      return runCreateIssue(innerCtx, (params ?? {}) as Partial<CreateIssueParams>, signal);
    });

    ctx.actions!.register('post-comment', async (_innerCtx, params, signal) => {
      const p = (params ?? {}) as Partial<PostCommentParams>;
      if (!p.body || (!p.issueId && !p.identifier)) {
        return { ok: false, error: 'linear-sync: params.body and one of issueId/identifier are required' };
      }
      const key = await readKey();
      if (!key) return { ok: false, error: 'linear-sync: LINEAR_API_KEY not configured' };
      try {
        let issueId = p.issueId;
        if (!issueId && p.identifier) {
          const res = await linearFetch(
            key,
            `query($id: String!) { issue(id: $id) { id } }`,
            { id: p.identifier },
            signal,
          );
          issueId = res.data?.issue?.id;
          if (!issueId) {
            return { ok: false, error: `linear-sync: no issue found with identifier '${p.identifier}'` };
          }
        }
        const res = await linearFetch(
          key,
          `mutation($input: CommentCreateInput!) {
             commentCreate(input: $input) {
               success
               comment { id url }
             }
           }`,
          { input: { issueId, body: p.body } },
          signal,
        );
        if (res.errors?.length) {
          return { ok: false, error: `linear-sync: ${res.errors.map((e) => e.message).join('; ')}` };
        }
        const c = res.data?.commentCreate?.comment;
        if (!res.data?.commentCreate?.success || !c) {
          return { ok: false, error: 'linear-sync: commentCreate returned success=false' };
        }
        return { ok: true, result: { commentId: c.id, url: c.url, issueId } };
      } catch (e: any) {
        if (e?.name === 'AbortError') return { ok: false, error: 'linear-sync: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
      }
    });

    ctx.actions!.register('list-issues', async (innerCtx, params, signal) => {
      const p = (params ?? {}) as Partial<ListIssuesParams>;
      const key = await readKey();
      if (!key) return { ok: false, error: 'linear-sync: LINEAR_API_KEY not configured' };
      const config = await readConfig(innerCtx);
      const labelPrefix = config.labelPrefix ?? 'papercusp';
      const slug = innerCtx.installSlug ?? 'unknown';
      const labelName = p.labelName ?? `${labelPrefix}-${slug}`;
      try {
        const res = await linearFetch(
          key,
          `query($name: String!) {
             issues(filter: { labels: { name: { eq: $name } } }, first: 50, orderBy: createdAt) {
               nodes {
                 id
                 identifier
                 title
                 url
                 state { name type }
                 labels { nodes { name } }
               }
             }
           }`,
          { name: labelName },
          signal,
        );
        if (res.errors?.length) {
          return { ok: false, error: `linear-sync: ${res.errors.map((e) => e.message).join('; ')}` };
        }
        const nodes: any[] = res.data?.issues?.nodes ?? [];
        return {
          ok: true,
          result: {
            total: nodes.length,
            issues: nodes.map((i) => ({
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              url: i.url,
              state: i.state?.name,
              stateType: i.state?.type,
              labels: (i.labels?.nodes ?? []).map((l: any) => l.name),
            })),
          },
        };
      } catch (e: any) {
        if (e?.name === 'AbortError') return { ok: false, error: 'linear-sync: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
      }
    });
  },
  hooks: {
    async afterDone(ctx: PapercuspContext) {
      const cfg = await readConfig(ctx);
      if (!cfg.defaultTeamKey && !cfg.defaultTeamId) {
        ctx.log('linear-sync: afterDone — skipped (no defaultTeamKey/defaultTeamId configured)');
        return;
      }
      const key = await readKey();
      if (!key) {
        ctx.log('linear-sync: afterDone — skipped (LINEAR_API_KEY not configured)');
        return;
      }
      try {
        const r = await runCreateIssue(
          ctx,
          {
            title: `Mission complete: ${ctx.installSlug}`,
            description: `Harness ${ctx.installSlug} reported mission-done.`,
            idempotencyKey: `mission-${ctx.installSlug}`,
          },
          undefined,
        );
        if (r.ok) {
          ctx.log(`linear-sync: afterDone → ${r.result?.identifier}${r.result?.reused ? ' (reused)' : ''}`);
        } else {
          ctx.log(`linear-sync: afterDone failed — ${r.error}`);
        }
      } catch (e: any) {
        ctx.log(`linear-sync: afterDone threw — ${e?.message ?? String(e)}`);
      }
    },
    async onFeaturePassed(ctx: PapercuspContext, featureId: string) {
      const cfg = await readConfig(ctx);
      if (!cfg.createOnFeaturePassed) return;
      if (!cfg.defaultTeamKey && !cfg.defaultTeamId) {
        ctx.log('linear-sync: onFeaturePassed — skipped (no defaultTeamKey/defaultTeamId configured)');
        return;
      }
      const key = await readKey();
      if (!key) {
        ctx.log('linear-sync: onFeaturePassed — skipped (LINEAR_API_KEY not configured)');
        return;
      }
      try {
        const r = await runCreateIssue(
          ctx,
          {
            title: `Feature passed: ${featureId}`,
            description: `Harness ${ctx.installSlug} reported feature ${featureId} passed validation.`,
            idempotencyKey: `feature-${featureId}`,
          },
          undefined,
        );
        if (r.ok) {
          ctx.log(`linear-sync: onFeaturePassed(${featureId}) → ${r.result?.identifier}${r.result?.reused ? ' (reused)' : ''}`);
        } else {
          ctx.log(`linear-sync: onFeaturePassed(${featureId}) failed — ${r.error}`);
        }
      } catch (e: any) {
        ctx.log(`linear-sync: onFeaturePassed(${featureId}) threw — ${e?.message ?? String(e)}`);
      }
    },
  },
};

/* ─────────────────────────────────────────────────────────────────────
 * apiRoutes — plugin-mounted HTTP endpoints.
 * Mounted at /api/plugins/_papercupai_linear-sync/* by the host.
 * ───────────────────────────────────────────────────────────────────── */
const apiRoutes = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;

    if (path === '/ping' || path.endsWith('/ping')) {
      const key = await readKey();
      return Response.json({
        ok: true,
        plugin: '@papercupai/linear-sync',
        version: '0.1.0',
        configured: key !== null,
      });
    }

    if ((path === '/viewer' || path.endsWith('/viewer')) && req.method === 'GET') {
      const key = await readKey();
      if (!key) {
        return Response.json({ ok: false, error: 'LINEAR_API_KEY not configured' }, { status: 503 });
      }
      try {
        const res = await linearFetch(
          key,
          `query { viewer { id name email } organization { id name urlKey } }`,
          {},
        );
        if (res.errors?.length) {
          return Response.json(
            { ok: false, error: res.errors.map((e) => e.message).join('; ') },
            { status: 502 },
          );
        }
        return Response.json({ ok: true, viewer: res.data?.viewer, organization: res.data?.organization });
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
      }
    }

    return Response.json({ error: 'not found', path }, { status: 404 });
  },
};

(plugin as any).apiRoutes = apiRoutes;

export default plugin;
