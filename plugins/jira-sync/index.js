"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => require('node:fs'));
    const { join } = await Promise.resolve().then(() => require('node:path'));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
async function readCreds() {
    // Substrate's secrets proxy is the proper path. Until it's wired through
    // ctx, fall back to env. The capability check at the registry boundary
    // already gated us to JIRA_* keys.
    const token = process.env.JIRA_API_TOKEN;
    const email = process.env.JIRA_EMAIL;
    const baseUrl = process.env.JIRA_BASE_URL;
    if (!token || !email || !baseUrl)
        return null;
    return { token, email, baseUrl: baseUrl.replace(/\/+$/, '') };
}
function authHeader(creds) {
    return 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
}
function adfDoc(text) {
    // Atlassian Document Format. Single paragraph; sufficient for v1.
    return {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    };
}
async function jiraFetch(creds, path, init = {}) {
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
const plugin = {
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
        ctx.actions.register('create-issue', async (innerCtx, params, signal) => {
            const p = (params ?? {});
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
            const config = await readConfig(innerCtx);
            const projectKey = p.projectKey ?? config.defaultProjectKey;
            if (!projectKey) {
                return { ok: false, error: 'jira-sync: projectKey not provided and config.defaultProjectKey is unset' };
            }
            const labelPrefix = config.labelPrefix ?? 'papercusp';
            const slugLabel = `${labelPrefix}-${innerCtx.harness?.slug ?? 'unknown'}`;
            const idempotencyLabel = p.idempotencyKey ? `${labelPrefix}-key-${p.idempotencyKey}` : null;
            const labels = Array.from(new Set([...(p.labels ?? []), slugLabel, ...(idempotencyLabel ? [idempotencyLabel] : [])]));
            // Find-before-create: if an idempotency label is set, search for an
            // existing issue with it first. If found, return that issue's key
            // instead of creating a duplicate. Re-running an action mid-flight
            // (retries, replays of mission-done events) won't pile up dupes.
            try {
                if (idempotencyLabel) {
                    const jql = `project = "${projectKey}" AND labels = "${idempotencyLabel}"`;
                    const findUrl = `/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`;
                    const findRes = await jiraFetch(creds, findUrl, { method: 'GET', signal });
                    if (findRes.ok) {
                        const findJson = (await findRes.json());
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
                    // If find fails (network error, perms), fall through to create —
                    // the create call will fail with a clearer error if creds are bad.
                }
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    return { ok: false, error: 'jira-sync: aborted (timeout) during find-before-create' };
                // Non-abort errors fall through to create. Tracked at the issue
                // level — Jira's tolerance for stale label searches is uncertain.
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
                const json = (await r.json());
                return { ok: true, result: { issueKey: json.key, id: json.id, url: `${creds.baseUrl}/browse/${json.key}`, reused: false } };
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    return { ok: false, error: 'jira-sync: aborted (timeout)' };
                return { ok: false, error: e?.message ?? String(e) };
            }
        });
        ctx.actions.register('post-comment', async (_innerCtx, params, signal) => {
            const p = (params ?? {});
            if (!p.issueKey || !p.body) {
                return { ok: false, error: 'jira-sync: params.issueKey and params.body are required' };
            }
            const creds = await readCreds();
            if (!creds)
                return { ok: false, error: 'jira-sync: credentials not configured' };
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
                const json = (await r.json());
                return { ok: true, result: { commentId: json.id, issueKey: p.issueKey } };
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    return { ok: false, error: 'jira-sync: aborted (timeout)' };
                return { ok: false, error: e?.message ?? String(e) };
            }
        });
        ctx.actions.register('list-issues', async (innerCtx, params, signal) => {
            const p = (params ?? {});
            const creds = await readCreds();
            if (!creds)
                return { ok: false, error: 'jira-sync: credentials not configured' };
            const config = await readConfig(innerCtx);
            const labelPrefix = config.labelPrefix ?? 'papercusp';
            const slug = innerCtx.harness?.slug ?? 'unknown';
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
                const json = (await r.json());
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
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    return { ok: false, error: 'jira-sync: aborted (timeout)' };
                return { ok: false, error: e?.message ?? String(e) };
            }
        });
    },
};
/* ─────────────────────────────────────────────────────────────────────
 * apiRoutes — plugin-mounted HTTP endpoints. Mounted at
 * /api/plugins/_papercupai_jira-sync/* by the host. Plain Web-Fetch
 * handler so the plugin doesn't drag the host's bundler version of Hono.
 * ───────────────────────────────────────────────────────────────────── */
const apiRoutes = {
    async fetch(req) {
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
                const json = (await r.json());
                return Response.json({ ok: true, total: json.total, issues: json.issues });
            }
            catch (e) {
                return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
            }
        }
        return Response.json({ error: 'not found', path }, { status: 404 });
    },
};
plugin.apiRoutes = apiRoutes;
exports.default = plugin;
