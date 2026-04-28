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
async function readWebhookUrl() {
    // Substrate's secrets proxy is the proper path. Until that's wired through
    // ctx, fall back to env. Either way the capability check at the registry
    // boundary already gated us.
    return process.env.SLACK_WEBHOOK_URL ?? null;
}
const plugin = {
    kind: 'plugin',
    name: '@papercupai/slack-notifier',
    version: '0.1.0',
    papercusp: '^0.1.0',
    description: 'Post a message to a Slack incoming webhook.',
    capabilities: [
        'secrets:read:SLACK_WEBHOOK_URL',
        'http:fetch:hooks.slack.com',
        'events:listen:mission-done',
        'events:listen:action-failed',
    ],
    actions: [
        {
            name: 'notify',
            label: 'Send to Slack',
            surfaces: ['harness-toolbar', 'mission-done'],
            capabilities: ['secrets:read:SLACK_WEBHOOK_URL', 'http:fetch:hooks.slack.com'],
            serverHandler: { timeoutSec: 10 },
        },
    ],
    routines: [
        {
            name: 'notify-on-action-failed',
            trigger: { kind: 'webhook' },
            targetRole: 'slack-notifier-broadcaster',
            payloadTemplate: { text: 'A plugin action failed in this harness — see the ops dashboard.' },
            concurrency: 'queue',
            catchup: 'skip-old',
        },
    ],
    async init(ctx) {
        ctx.actions.register('notify', async (innerCtx, params, signal) => {
            const p = (params ?? {});
            if (!p.text || typeof p.text !== 'string') {
                return { ok: false, error: 'slack-notifier: params.text is required (string)' };
            }
            const url = await readWebhookUrl();
            if (!url) {
                return { ok: false, error: 'slack-notifier: SLACK_WEBHOOK_URL not configured (export it in the substrate process env)' };
            }
            const config = await readConfig(innerCtx);
            const body = {
                text: p.text,
                channel: p.channel ?? config.defaultChannel,
                username: config.username ?? 'papercusp',
                icon_emoji: config.icon ?? ':paperclip:',
            };
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal,
                });
                if (!r.ok) {
                    const text = await r.text().catch(() => '');
                    return { ok: false, error: `slack-notifier: HTTP ${r.status}${text ? ' — ' + text.slice(0, 200) : ''}` };
                }
                return { ok: true, result: { posted: true, channel: body.channel } };
            }
            catch (e) {
                if (e?.name === 'AbortError')
                    return { ok: false, error: 'slack-notifier: aborted (timeout)' };
                return { ok: false, error: e?.message ?? String(e) };
            }
        });
    },
};
/* ─────────────────────────────────────────────────────────────────────
 * apiRoutes — plugin-mounted HTTP endpoints. Mounted at
 * /api/plugins/_papercupai_slack-notifier/* by the host.
 *
 * Implemented as a plain Web-Fetch handler (no Hono dependency) so the
 * plugin doesn't need to drag the host's bundler version of Hono. The
 * mount path strips the prefix; this handler sees the relative path
 * directly (e.g. '/ping', '/notify').
 * ───────────────────────────────────────────────────────────────────── */
const apiRoutes = {
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname.replace(/^.*\/plugins\/[^/]+/, '') || url.pathname;
        if (path === '/ping' || path.endsWith('/ping')) {
            return Response.json({ ok: true, plugin: '@papercupai/slack-notifier', version: '0.1.0' });
        }
        if ((path === '/notify' || path.endsWith('/notify')) && req.method === 'POST') {
            let body;
            try {
                body = await req.json();
            }
            catch {
                body = {};
            }
            const text = typeof body?.text === 'string' ? body.text : null;
            if (!text) {
                return Response.json({ ok: false, error: 'params.text required (string)' }, { status: 400 });
            }
            const webhookUrl = await readWebhookUrl();
            if (!webhookUrl) {
                return Response.json({ ok: false, error: 'SLACK_WEBHOOK_URL not configured' }, { status: 503 });
            }
            try {
                const r = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        text,
                        channel: body?.channel,
                        username: 'papercusp',
                        icon_emoji: ':paperclip:',
                    }),
                });
                if (!r.ok) {
                    const t = await r.text().catch(() => '');
                    return Response.json({ ok: false, error: `HTTP ${r.status}${t ? ' — ' + t.slice(0, 200) : ''}` }, { status: 502 });
                }
                return Response.json({ ok: true, posted: true });
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
