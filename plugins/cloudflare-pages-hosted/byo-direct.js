"use strict";
/**
 * BYO Cloudflare path (§15.7 — the eject route).
 *
 * Implements the modern Cloudflare Pages Direct Upload protocol:
 *
 *   1. POST /accounts/<acc>/pages/projects                 — ensureProject
 *   2. GET  /accounts/<acc>/pages/projects/<n>/upload-token — get JWT
 *   3. POST /pages/assets/check-missing                    — JWT auth, list of sha256s; returns subset to upload
 *   4. POST /pages/assets/upload                           — JWT auth, base64'd payload
 *   5. POST /pages/assets/upsert-hashes                    — JWT auth, finalize uploaded hashes
 *   6. POST /accounts/<acc>/pages/projects/<n>/deployments — master-token auth, multipart manifest
 *
 * Reverse-engineered from `wrangler pages deploy` (verified against
 * wrangler v4.86.0 in the local CF account 2026-04-29).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishToBYO = publishToBYO;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const walk_ts_1 = require("./walk.ts");
const CF_API = 'https://api.cloudflare.com/client/v4';
async function publishToBYO(opts) {
    const onProgress = opts.onProgress ?? (() => { });
    const project = sanitize(opts.deploymentSlug);
    const accountUrl = `${CF_API}/accounts/${opts.cloudflareAccountId}/pages/projects/${encodeURIComponent(project)}`;
    onProgress({ phase: 'start', message: `ensuring CF project ${project}` });
    await ensureProject(opts, project);
    const files = await (0, walk_ts_1.walkExportDir)(opts.exportDir);
    if (files.length === 0)
        throw new Error('exportDir is empty');
    onProgress({ phase: 'upload', message: `walked ${files.length} files`, totalFiles: files.length });
    // Step 2 — fetch upload-token (JWT scoped to file uploads).
    const jwt = await fetchUploadToken(opts, project);
    // Step 3 — ask CF which hashes it doesn't yet have.
    const allShas = files.map((f) => f.sha256);
    const missing = await checkMissing(jwt, allShas, opts.signal);
    onProgress({
        phase: 'upload',
        message: `${missing.length}/${files.length} files need upload`,
        totalFiles: files.length,
        uploadedFiles: files.length - missing.length,
    });
    // Step 4 — upload missing files in batches of 5 (CF's recommendation).
    const missingSet = new Set(missing);
    const toUpload = files.filter((f) => missingSet.has(f.sha256));
    let uploaded = files.length - toUpload.length;
    const batchSize = 5;
    for (let i = 0; i < toUpload.length; i += batchSize) {
        if (opts.signal?.aborted)
            throw new Error('aborted');
        const batch = toUpload.slice(i, i + batchSize);
        const payload = await Promise.all(batch.map(async (f) => ({
            key: f.sha256,
            value: await readBase64((0, node_path_1.join)(opts.exportDir, f.path)),
            base64: true,
            metadata: { contentType: contentType(f.path) },
        })));
        const res = await fetch(`${CF_API}/pages/assets/upload`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: opts.signal,
        });
        if (!res.ok) {
            throw new Error(`BYO upload batch failed: ${res.status} ${await res.text()}`);
        }
        uploaded += batch.length;
        onProgress({
            phase: 'upload',
            message: `uploaded ${uploaded}/${files.length}`,
            uploadedFiles: uploaded,
            totalFiles: files.length,
        });
    }
    // Step 5 — finalize. Per wrangler this is called with ALL file hashes
    // for the upcoming deployment, not just newly-uploaded ones — it tells
    // CF "these are the assets I'm about to reference; refresh their TTL."
    // Without this CF won't actually serve the files.
    {
        const res = await fetch(`${CF_API}/pages/assets/upsert-hashes`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            body: JSON.stringify({ hashes: allShas }),
            signal: opts.signal,
        });
        if (!res.ok) {
            throw new Error(`BYO upsert-hashes failed: ${res.status} ${await res.text()}`);
        }
    }
    // Step 6 — create deployment with manifest. Manifest format:
    //   { "<absolute path>": "<sha256>" }   ← path leads with "/"
    onProgress({ phase: 'finalize', message: 'creating deployment' });
    const manifest = {};
    for (const f of files)
        manifest['/' + f.path] = f.sha256;
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    const depRes = await fetch(`${accountUrl}/deployments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.cloudflareToken}` },
        body: form,
        signal: opts.signal,
    });
    if (!depRes.ok) {
        throw new Error(`BYO deployment create failed: ${depRes.status} ${await depRes.text()}`);
    }
    const dep = (await depRes.json());
    onProgress({
        phase: 'done',
        message: `deployment created: ${dep.result.url}`,
        vanityUrl: dep.result.url,
    });
    return {
        deploymentId: dep.result.id,
        vanityUrl: dep.result.url,
        status: 'live',
    };
}
async function ensureProject(opts, name) {
    const get = await fetch(`${CF_API}/accounts/${opts.cloudflareAccountId}/pages/projects/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${opts.cloudflareToken}` }, signal: opts.signal });
    if (get.ok)
        return;
    if (get.status !== 404) {
        throw new Error(`CF project lookup failed: ${get.status} ${await get.text()}`);
    }
    const create = await fetch(`${CF_API}/accounts/${opts.cloudflareAccountId}/pages/projects`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${opts.cloudflareToken}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ name, production_branch: 'main' }),
        signal: opts.signal,
    });
    if (!create.ok) {
        throw new Error(`CF project create failed: ${create.status} ${await create.text()}`);
    }
}
async function fetchUploadToken(opts, project) {
    // GET (NOT POST) per CF Pages.
    const res = await fetch(`${CF_API}/accounts/${opts.cloudflareAccountId}/pages/projects/${encodeURIComponent(project)}/upload-token`, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.cloudflareToken}` },
        signal: opts.signal,
    });
    if (!res.ok) {
        throw new Error(`upload-token failed: ${res.status} ${await res.text()}`);
    }
    const j = (await res.json());
    return j.result.jwt;
}
async function checkMissing(jwt, hashes, signal) {
    const res = await fetch(`${CF_API}/pages/assets/check-missing`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hashes }),
        signal,
    });
    if (!res.ok) {
        throw new Error(`check-missing failed: ${res.status} ${await res.text()}`);
    }
    const j = (await res.json());
    return j.result;
}
async function readBase64(path) {
    const buf = await node_fs_1.promises.readFile(path);
    return buf.toString('base64');
}
function contentType(path) {
    const ext = path.toLowerCase().split('.').pop() ?? '';
    const map = {
        html: 'text/html; charset=utf-8',
        htm: 'text/html; charset=utf-8',
        js: 'application/javascript; charset=utf-8',
        mjs: 'application/javascript; charset=utf-8',
        css: 'text/css; charset=utf-8',
        json: 'application/json; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        txt: 'text/plain; charset=utf-8',
        md: 'text/markdown; charset=utf-8',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        map: 'application/json; charset=utf-8',
        xml: 'application/xml; charset=utf-8',
        pdf: 'application/pdf',
    };
    return map[ext] ?? 'application/octet-stream';
}
function sanitize(s) {
    return (s
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-') || 'untitled');
}
