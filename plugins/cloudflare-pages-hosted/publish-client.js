"use strict";
/**
 * Substrate-side client for publish.papercuspai.com.
 *
 *   1. Walk <exportDir>/ → ManifestFile[]
 *   2. Build canonical manifest
 *   3. Mint JWT (HS256, derived publishKey)
 *   4. POST /publish/start → { deploymentId, missing[], vanityUrl }
 *   5. PUT each file at its signed URL (parallel, capped concurrency)
 *   6. POST /publish/finalize
 *   7. Poll /publish/status until live | failed | timeout
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishToHosted = publishToHosted;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const publish_auth_1 = require("@papercusp/publish-auth");
const walk_ts_1 = require("./walk.ts");
async function publishToHosted(opts) {
    const { creds } = opts;
    const onProgress = opts.onProgress ?? (() => { });
    const concurrency = opts.uploadConcurrency ?? 4;
    onProgress({ phase: 'walk', message: `walking ${opts.exportDir}` });
    const files = await (0, walk_ts_1.walkExportDir)(opts.exportDir);
    if (files.length === 0)
        throw new Error(`exportDir is empty: ${opts.exportDir}`);
    const manifest = {
        files,
        deployment_slug: opts.deploymentSlug,
    };
    const sha = await (0, publish_auth_1.manifestSha256Hex)(manifest);
    const tenantSecretBytes = (0, publish_auth_1.b64uDecode)(creds.tenantSecret);
    const publishKey = await (0, publish_auth_1.derivePublishKey)(tenantSecretBytes);
    const startResp = await postJson(`https://${creds.publishHost}/publish/start`, manifest, await (0, publish_auth_1.mintJwt)(publishKey, {
        sub: creds.tenantId,
        jti: (0, publish_auth_1.jti)(),
        sha256: sha,
        aud: 'publish',
    }), opts.signal);
    onProgress({
        phase: 'start',
        message: `deployment ${startResp.deploymentId} created (${startResp.missing.length}/${files.length} files to upload)`,
        totalFiles: files.length,
        vanityUrl: startResp.vanityUrl,
    });
    let uploaded = 0;
    await runWithConcurrency(startResp.missing, concurrency, async (entry) => {
        if (opts.signal?.aborted)
            throw new Error('aborted');
        const path = (0, node_path_1.join)(opts.exportDir, entry.path);
        const body = await node_fs_1.promises.readFile(path);
        const res = await fetch(entry.uploadUrl, {
            method: 'PUT',
            headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(body.byteLength),
            },
            body: body,
            signal: opts.signal,
        });
        if (!res.ok)
            throw new Error(`upload failed for ${entry.path}: ${res.status} ${await res.text()}`);
        uploaded++;
        onProgress({
            phase: 'upload',
            message: `uploaded ${uploaded}/${startResp.missing.length}`,
            uploadedFiles: uploaded,
            totalFiles: startResp.missing.length,
            vanityUrl: startResp.vanityUrl,
        });
    });
    onProgress({ phase: 'finalize', message: 'finalizing deployment' });
    await postJson(`https://${creds.publishHost}/publish/finalize`, { deploymentId: startResp.deploymentId }, await (0, publish_auth_1.mintJwt)(publishKey, {
        sub: creds.tenantId,
        jti: (0, publish_auth_1.jti)(),
        sha256: sha,
        aud: 'publish',
    }), opts.signal);
    onProgress({ phase: 'poll', message: 'waiting for cloudflare', vanityUrl: startResp.vanityUrl });
    const pollDeadline = Date.now() + (opts.pollTimeoutMs ?? 5 * 60 * 1000);
    let delay = 1000;
    for (;;) {
        if (Date.now() > pollDeadline)
            throw new Error('publish status poll timeout');
        if (opts.signal?.aborted)
            throw new Error('aborted');
        const status = await getJson(`https://${creds.publishHost}/publish/status/${startResp.deploymentId}`, await (0, publish_auth_1.mintJwt)(publishKey, {
            sub: creds.tenantId,
            jti: (0, publish_auth_1.jti)(),
            sha256: sha,
            aud: 'publish',
        }), opts.signal);
        if (status.status === 'live') {
            onProgress({ phase: 'done', message: `live at ${status.vanityUrl}`, vanityUrl: status.vanityUrl });
            return {
                deploymentId: startResp.deploymentId,
                vanityUrl: status.vanityUrl,
                status: 'live',
            };
        }
        if (status.status === 'failed') {
            return {
                deploymentId: startResp.deploymentId,
                vanityUrl: status.vanityUrl,
                status: 'failed',
                failureReason: status.failureReason,
            };
        }
        await sleep(delay);
        delay = delay < 5000 ? Math.min(delay * 2, 5000) : Math.round(5000 * (0.8 + Math.random() * 0.4));
    }
}
async function postJson(url, body, jwt, signal) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        throw new Error(`POST ${url} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json());
}
async function getJson(url, jwt, signal) {
    const res = await fetch(url, {
        headers: { authorization: `Bearer ${jwt}` },
        signal,
    });
    if (!res.ok)
        throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
    return (await res.json());
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function runWithConcurrency(items, limit, fn) {
    const workers = [];
    let i = 0;
    for (let w = 0; w < Math.min(limit, items.length); w++) {
        workers.push((async () => {
            while (i < items.length) {
                const idx = i++;
                await fn(items[idx]);
            }
        })());
    }
    await Promise.all(workers);
}
