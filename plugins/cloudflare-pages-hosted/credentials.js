"use strict";
/**
 * `~/.papercusp/publish-credentials.json` — the substrate's per-machine
 * tenantId + tenantSecret, stored chmod 600.
 *
 * Created on first publish: the plugin POSTs /register-tenant, captures
 * the response, writes this file, then proceeds with the publish flow.
 * Subsequent publishes from the same machine reuse the file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readCredentials = readCredentials;
exports.writeCredentials = writeCredentials;
exports.ensureRegistered = ensureRegistered;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
// Resolve workspace-aware Papercusp root with fallback to legacy ~/.papercusp/.
function papercuspRoot() {
    if (process.env.PAPERCUSP_HOME)
        return process.env.PAPERCUSP_HOME;
    const wsIndex = (0, node_path_1.join)((0, node_os_1.homedir)(), '.papercusp-workspaces', 'registry.json');
    if ((0, node_fs_1.existsSync)(wsIndex)) {
        try {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(wsIndex, 'utf8'));
            if (parsed.current) {
                const cand = (0, node_path_1.join)((0, node_os_1.homedir)(), '.papercusp-workspaces', parsed.current, '.papercusp');
                if ((0, node_fs_1.existsSync)(cand))
                    return cand;
            }
        }
        catch { /* fall through */ }
    }
    const def = (0, node_path_1.join)((0, node_os_1.homedir)(), '.papercusp-workspaces', 'default', '.papercusp');
    if ((0, node_fs_1.existsSync)(def))
        return def;
    return (0, node_path_1.join)((0, node_os_1.homedir)(), '.papercusp');
}
const PATH = () => (0, node_path_1.join)(papercuspRoot(), 'publish-credentials.json');
async function readCredentials() {
    try {
        const raw = await node_fs_1.promises.readFile(PATH(), 'utf8');
        return JSON.parse(raw);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
}
async function writeCredentials(c) {
    const path = PATH();
    await node_fs_1.promises.mkdir(papercuspRoot(), { recursive: true });
    await node_fs_1.promises.writeFile(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}
async function ensureRegistered(publishHost) {
    const existing = await readCredentials();
    if (existing && existing.publishHost === publishHost)
        return existing;
    const res = await fetch(`https://${publishHost}/register-tenant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    if (!res.ok) {
        throw new Error(`register-tenant failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json());
    const fresh = {
        tenantId: body.tenantId,
        tenantSecret: body.tenantSecret,
        registeredAt: Date.now(),
        publishHost,
    };
    await writeCredentials(fresh);
    return fresh;
}
