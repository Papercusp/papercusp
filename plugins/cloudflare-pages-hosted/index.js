"use strict";
/**
 * @papercupai/cloudflare-pages-hosted — one-click publish to
 * *.preview.papercuspai.com. No Cloudflare account required.
 *
 * Two paths:
 *   - HOSTED (default): calls publish.papercuspai.com which fronts
 *     our master CF account. Auto-registers a per-machine tenant on
 *     first publish.
 *   - BYO (eject path, §15.7): when both `byoCloudflareToken` and
 *     `byoCloudflareAccountId` are configured, bypasses our service
 *     entirely and publishes directly to the user's own CF account.
 *
 * Plugin scope is gated to coding-kind harnesses via
 * requiresTemplateKinds: ["coding"] in papercusp.json.
 */
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
const credentials_ts_1 = require("./credentials.ts");
const publish_client_ts_1 = require("./publish-client.ts");
const byo_direct_ts_1 = require("./byo-direct.ts");
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        const raw = await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
const plugin = {
    name: '@papercupai/cloudflare-pages-hosted',
    version: '0.1.0',
    papercusp: '^0.1.0',
    description: 'One-click hosted publishing to *.preview.papercuspai.com.',
    capabilities: [
        'http:fetch:publish.papercuspai.com',
        'http:fetch:api.cloudflare.com',
        'storage:plugin-private',
        'events:listen:mission-done',
    ],
    actions: [
        {
            name: 'publish',
            label: 'Publish website',
            surfaces: ['harness-toolbar', 'mission-done'],
            capabilities: ['http:fetch:publish.papercuspai.com'],
            serverHandler: { timeoutSec: 300 },
        },
    ],
    async init(ctx) {
        const actions = ctx.actions;
        if (!actions || typeof actions.register !== 'function') {
            ctx.log('cloudflare-pages-hosted: actions surface not present; plugin registered without action handler');
            return;
        }
        actions.register('publish', async (innerCtx, params, signal) => {
            const p = (params ?? {});
            const config = await readConfig(innerCtx);
            const exportDir = await absolutize(innerCtx, p.exportDir ?? config.exportDir ?? 'out');
            const deploymentSlug = p.deploymentSlug ?? innerCtx.installSlug;
            if (p.dryRun) {
                return {
                    ok: true,
                    result: {
                        dryRun: true,
                        mode: usingByo(config) ? 'byo' : 'hosted',
                        exportDir,
                        deploymentSlug,
                    },
                };
            }
            const onProgress = (prog) => innerCtx.log(`[publish:${prog.phase}] ${prog.message}`);
            try {
                let result;
                if (usingByo(config)) {
                    result = await (0, byo_direct_ts_1.publishToBYO)({
                        exportDir,
                        deploymentSlug,
                        cloudflareToken: config.byoCloudflareToken,
                        cloudflareAccountId: config.byoCloudflareAccountId,
                        onProgress,
                        signal,
                    });
                }
                else {
                    const publishHost = config.publishHost ?? 'publish.papercuspai.com';
                    const creds = await (0, credentials_ts_1.ensureRegistered)(publishHost);
                    result = await (0, publish_client_ts_1.publishToHosted)({
                        exportDir,
                        deploymentSlug,
                        creds,
                        onProgress,
                        signal,
                    });
                }
                return result.status === 'live'
                    ? { ok: true, result }
                    : { ok: false, error: result.failureReason ?? 'publish failed', result };
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                innerCtx.log(`publish error: ${msg}`);
                return { ok: false, error: msg };
            }
        });
    },
};
function usingByo(c) {
    return !!(c.byoCloudflareToken && c.byoCloudflareAccountId);
}
async function absolutize(ctx, p) {
    if (p.startsWith('/'))
        return p;
    const path = await Promise.resolve().then(() => __importStar(require('node:path')));
    return path.join(ctx.projectDir, p);
}
exports.default = plugin;
