/**
 * Papercusp Marketplace — minimal tarball catalog server.
 *
 * Stage 6 MVP. Filesystem-backed (no R2 yet). No auth (so don't deploy this
 * to public internet without adding GitHub PAT verification first).
 *
 * Storage layout:
 *   ~/.papercusp/marketplace-storage/
 *     <slug>/
 *       <version>/
 *         papercusp.json     ← manifest
 *         README.md          ← optional (extracted from tarball)
 *         <slug>-<version>.tar.gz  ← published tarball
 *
 * API:
 *   GET  /healthz                          → ok
 *   GET  /catalog                          → list of {slug, name, version, description, ...}
 *   GET  /catalog/:slug                    → all versions of a slug + latest manifest
 *   GET  /catalog/:slug/:version           → manifest + readme for a specific version
 *   GET  /download/:slug/:version          → tarball stream
 *   POST /publish/:slug/:version           → multipart upload (manifest + tarball + readme)
 *   DELETE /catalog/:slug/:version         → unpublish (dev-only; no auth)
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PAPERCUSP_MARKETPLACE_PORT ?? 3057);
const STORAGE_ROOT = process.env.PAPERCUSP_MARKETPLACE_STORAGE
  ?? join(homedir(), '.papercusp', 'marketplace-storage');

interface PapercuspManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  papercusp?: string;
  models?: Record<string, unknown>;
  plugins?: string[];
  schema?: string[];
  screenshots?: string[];
  homepage?: string;
}

async function ensureStorage(): Promise<void> {
  await fs.mkdir(STORAGE_ROOT, { recursive: true, mode: 0o755 });
}

async function readManifest(slug: string, version: string): Promise<PapercuspManifest | null> {
  const path = join(STORAGE_ROOT, slug, version, 'papercusp.json');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as PapercuspManifest;
  } catch {
    return null;
  }
}

async function listSlugs(): Promise<string[]> {
  await ensureStorage();
  try {
    const entries = await fs.readdir(STORAGE_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function listVersions(slug: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(STORAGE_ROOT, slug), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch {
    return [];
  }
}

function isValidSlugOrVersion(s: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
}

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

app.get('/catalog', async (c) => {
  const slugs = await listSlugs();
  const items: Array<PapercuspManifest & { versions: string[] }> = [];
  for (const slug of slugs) {
    const versions = await listVersions(slug);
    if (versions.length === 0) continue;
    const latest = await readManifest(slug, versions[0]);
    if (latest) items.push({ ...latest, versions });
  }
  return c.json({ catalog: items, storageRoot: STORAGE_ROOT });
});

app.get('/catalog/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidSlugOrVersion(slug)) return c.json({ error: 'invalid slug' }, 400);
  const versions = await listVersions(slug);
  if (versions.length === 0) return c.json({ error: 'not found' }, 404);
  const latest = await readManifest(slug, versions[0]);
  return c.json({ slug, versions, latest });
});

app.get('/catalog/:slug/:version', async (c) => {
  const slug = c.req.param('slug');
  const version = c.req.param('version');
  if (!isValidSlugOrVersion(slug) || !isValidSlugOrVersion(version)) {
    return c.json({ error: 'invalid slug/version' }, 400);
  }
  const manifest = await readManifest(slug, version);
  if (!manifest) return c.json({ error: 'not found' }, 404);
  let readme: string | null = null;
  try {
    readme = await fs.readFile(join(STORAGE_ROOT, slug, version, 'README.md'), 'utf8');
  } catch {}
  return c.json({ slug, version, manifest, readme });
});

app.get('/download/:slug/:version', async (c) => {
  const slug = c.req.param('slug');
  const version = c.req.param('version');
  if (!isValidSlugOrVersion(slug) || !isValidSlugOrVersion(version)) {
    return c.json({ error: 'invalid slug/version' }, 400);
  }
  const tarballPath = join(STORAGE_ROOT, slug, version, `${slug}-${version}.tar.gz`);
  if (!existsSync(tarballPath)) return c.json({ error: 'not found' }, 404);

  const stream = Readable.toWeb(createReadStream(tarballPath));
  return new Response(stream as ReadableStream, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${slug}-${version}.tar.gz"`,
    },
  });
});

// Auth modes:
//   "open"    — no auth check (for local-dev convenience).
//   "pat"     — verify Authorization: Bearer <pat> against the GitHub user API
//               (https://api.github.com/user). The verified GitHub login is
//               recorded in the manifest as `publishedBy`.
//
// Switch via PAPERCUSP_MARKETPLACE_AUTH=open|pat (default: open in dev).
const AUTH_MODE = process.env.PAPERCUSP_MARKETPLACE_AUTH ?? 'open';

interface GithubUser { login: string; id: number; name?: string }

async function verifyGithubPat(token: string): Promise<GithubUser | null> {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'papercusp-marketplace' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return (await r.json()) as GithubUser;
  } catch {
    return null;
  }
}

app.post('/publish/:slug/:version', async (c) => {
  const slug = c.req.param('slug');
  const version = c.req.param('version');
  if (!isValidSlugOrVersion(slug) || !isValidSlugOrVersion(version)) {
    return c.json({ error: 'invalid slug/version' }, 400);
  }

  // Auth gate.
  let publishedBy: string | null = null;
  if (AUTH_MODE === 'pat') {
    const auth = c.req.header('authorization');
    const m = auth?.match(/^Bearer\s+(\S+)$/i);
    if (!m) return c.json({ error: 'Authorization: Bearer <github-pat> required (PAPERCUSP_MARKETPLACE_AUTH=pat)' }, 401);
    const user = await verifyGithubPat(m[1]);
    if (!user) return c.json({ error: 'invalid GitHub PAT' }, 401);
    publishedBy = user.login;
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);

  const manifestField = form.get('manifest');
  const tarballField = form.get('tarball');
  const readmeField = form.get('readme');

  if (typeof manifestField !== 'string') return c.json({ error: 'manifest field required (JSON string)' }, 400);
  if (!(tarballField instanceof File)) return c.json({ error: 'tarball field required (File)' }, 400);

  let manifest: PapercuspManifest;
  try {
    manifest = JSON.parse(manifestField);
  } catch {
    return c.json({ error: 'manifest is not valid JSON' }, 400);
  }
  if (!manifest.name || !manifest.version) {
    return c.json({ error: 'manifest must have name + version' }, 400);
  }
  if (manifest.name !== slug) return c.json({ error: 'manifest.name must match URL slug' }, 400);
  if (manifest.version !== version) return c.json({ error: 'manifest.version must match URL version' }, 400);

  const dir = join(STORAGE_ROOT, slug, version);
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });

  // Stamp publisher provenance into the stored manifest if PAT auth was used.
  const stored = publishedBy ? { ...manifest, publishedBy, publishedAt: new Date().toISOString() } : manifest;
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(stored, null, 2), 'utf8');

  if (typeof readmeField === 'string') {
    await fs.writeFile(join(dir, 'README.md'), readmeField, 'utf8');
  } else if (readmeField instanceof File) {
    await fs.writeFile(join(dir, 'README.md'), Buffer.from(await readmeField.arrayBuffer()));
  }

  // Stream the tarball to disk.
  const tarballPath = join(dir, `${slug}-${version}.tar.gz`);
  const buf = Buffer.from(await tarballField.arrayBuffer());
  // Cap at 50MB for now to avoid filling the disk.
  if (buf.length > 50 * 1024 * 1024) {
    return c.json({ error: 'tarball exceeds 50MB limit' }, 413);
  }
  await fs.writeFile(tarballPath, buf);

  return c.json({ ok: true, slug, version, sizeBytes: buf.length });
});

app.delete('/catalog/:slug/:version', async (c) => {
  const slug = c.req.param('slug');
  const version = c.req.param('version');
  if (!isValidSlugOrVersion(slug) || !isValidSlugOrVersion(version)) {
    return c.json({ error: 'invalid slug/version' }, 400);
  }
  const dir = join(STORAGE_ROOT, slug, version);
  if (!existsSync(dir)) return c.json({ error: 'not found' }, 404);
  await fs.rm(dir, { recursive: true, force: true });
  // Best-effort cleanup of empty parent.
  try {
    const remaining = await fs.readdir(join(STORAGE_ROOT, slug));
    if (remaining.length === 0) await fs.rmdir(join(STORAGE_ROOT, slug));
  } catch {}
  return c.json({ ok: true });
});

await ensureStorage();

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`papercusp-marketplace listening on :${info.port}`);
  console.log(`storage: ${STORAGE_ROOT}`);
});
