"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
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
async function runCreateIssue(ctx, p, signal) {
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
        }
    }
    catch (e) {
        if (e?.name === 'AbortError')
            return { ok: false, error: 'jira-sync: aborted (timeout) during find-before-create' };
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
            return runCreateIssue(innerCtx, (params ?? {}), signal);
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
    hooks: {
        // Mission completed — auto-create a "Mission complete" Jira issue.
        // Idempotent on installSlug so replays of the mission-done event don't
        // pile up. Silent skip when not configured (no projectKey or creds).
        async afterDone(ctx) {
            const cfg = await readConfig(ctx);
            if (!cfg.defaultProjectKey) {
                ctx.log('jira-sync: afterDone — skipped (defaultProjectKey not configured)');
                return;
            }
            try {
                const r = await runCreateIssue(ctx, {
                    summary: `Mission complete: ${ctx.installSlug}`,
                    description: `Harness ${ctx.installSlug} reported mission-done.`,
                    idempotencyKey: `mission-${ctx.installSlug}`,
                }, undefined);
                if (r.ok) {
                    ctx.log(`jira-sync: afterDone → ${r.result?.issueKey}${r.result?.reused ? ' (reused)' : ''}`);
                }
                else {
                    ctx.log(`jira-sync: afterDone failed — ${r.error}`);
                }
            }
            catch (e) {
                ctx.log(`jira-sync: afterDone threw — ${e?.message ?? String(e)}`);
            }
        },
        // Feature passed — only fires when config.createOnFeaturePassed is true.
        // Idempotent on featureId so retries don't duplicate. We never throw;
        // a CI-tracker hiccup must not be reported as a feature regression.
        async onFeaturePassed(ctx, featureId) {
            const cfg = await readConfig(ctx);
            if (!cfg.createOnFeaturePassed)
                return;
            if (!cfg.defaultProjectKey) {
                ctx.log('jira-sync: onFeaturePassed — skipped (defaultProjectKey not configured)');
                return;
            }
            try {
                const r = await runCreateIssue(ctx, {
                    summary: `Feature passed: ${featureId}`,
                    description: `Harness ${ctx.installSlug} reported feature ${featureId} passed validation.`,
                    idempotencyKey: `feature-${featureId}`,
                }, undefined);
                if (r.ok) {
                    ctx.log(`jira-sync: onFeaturePassed(${featureId}) → ${r.result?.issueKey}${r.result?.reused ? ' (reused)' : ''}`);
                }
                else {
                    ctx.log(`jira-sync: onFeaturePassed(${featureId}) failed — ${r.error}`);
                }
            }
            catch (e) {
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
