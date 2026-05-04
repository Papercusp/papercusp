"use strict";
/**
 * Walks <exportDir>/, computes BLAKE3-of-(base64+extension) for every file
 * (the format Cloudflare Pages uses to identify deployment assets), and
 * returns a ManifestFile-shaped list with that 32-char hex hash stored in
 * the `sha256` field for compatibility with the rest of the pipeline.
 *
 * Note: the field is named `sha256` for legacy reasons (the hosted Worker
 * path uses sha256). For the BYO direct path we substitute BLAKE3 so the
 * hashes match what `wrangler pages deploy` produces — CF Pages's asset
 * store rejects deployments whose manifest references unknown hashes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.walkExportDir = walkExportDir;
exports.cfPagesAssetHash = cfPagesAssetHash;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const blake3_js_1 = require("@noble/hashes/blake3.js");
const utils_js_1 = require("@noble/hashes/utils.js");
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);
async function walkExportDir(root) {
    const out = [];
    await walk(root, root, out);
    return out;
}
async function walk(root, dir, out) {
    const entries = await node_fs_1.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP.has(entry.name))
            continue;
        const full = (0, node_path_1.join)(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(root, full, out);
        }
        else if (entry.isFile()) {
            const stat = await node_fs_1.promises.stat(full);
            const path = (0, node_path_1.relative)(root, full).split(node_path_1.sep).join('/');
            const buf = await node_fs_1.promises.readFile(full);
            out.push({
                path,
                sha256: cfPagesAssetHash(buf, path),
                bytes: stat.size,
            });
        }
    }
}
/**
 * Cloudflare Pages computes asset identity as
 *
 *   blake3(base64(file_bytes) + extension_without_dot).hex.slice(0, 32)
 *
 * It must match exactly what `wrangler pages deploy` does or CF rejects
 * deployments referencing the file. Reverse-engineered from
 * wrangler/wrangler-dist/cli.js `hashFile`.
 */
function cfPagesAssetHash(content, filename) {
    const ext = (0, node_path_1.extname)(filename).slice(1); // strip leading dot
    const base64 = typeof Buffer !== 'undefined'
        ? Buffer.from(content).toString('base64')
        : btoa(String.fromCharCode(...content));
    return (0, utils_js_1.bytesToHex)((0, blake3_js_1.blake3)(new TextEncoder().encode(base64 + ext))).slice(0, 32);
}
