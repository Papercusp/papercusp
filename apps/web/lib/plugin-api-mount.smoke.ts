/**
 * Smoke test for mountPluginApiRoutes — verifies that plugins exposing
 * a Hono `apiRoutes` get mounted at /api/plugins/<name>.
 *
 * Run with:
 *   cd libs/papercusp/apps/web && npx tsx lib/plugin-api-mount.smoke.ts
 *
 * Uses a tmp directory as the global-plugins dir so the test doesn't
 * collide with the live ~/.papercusp install.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Hono } from 'hono';
import { mountPluginApiRoutes, _resetPluginApiRoutesForTests } from './plugin-api-mount';

async function main() {
  let pass = 0; let fail = 0;
  const log = (label: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  // Set up a fake home with one plugin that exposes a hello route.
  const fakeHome = await fs.mkdtemp(join(tmpdir(), 'papercusp-mount-smoke-'));
  const pluginDir = join(fakeHome, '.papercusp', 'global-plugins', 'echo-test');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(join(pluginDir, 'papercusp.json'), JSON.stringify({
    name: 'echo-test',
    version: '0.0.1',
    capabilities: [],
  }));
  // Fake apiRoutes — Hono-shaped (has .fetch) but doesn't need to import
  // Hono itself, which would fail outside the workspace's node_modules.
  await fs.writeFile(join(pluginDir, 'index.mjs'), `
const apiRoutes = {
  // Hono.mount() strips the mount prefix and passes a relativized request.
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/hello' || url.pathname.endsWith('/hello')) {
      return new Response(JSON.stringify({ ok: true, from: 'echo-test' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
const plugin = {
  kind: 'plugin',
  name: 'echo-test',
  version: '0.0.1',
  capabilities: [],
  apiRoutes,
};
export default plugin;
`);

  _resetPluginApiRoutesForTests();

  const parent = new Hono().basePath('/api');
  const result = await mountPluginApiRoutes(parent, {
    globalPluginsDir: join(fakeHome, '.papercusp', 'global-plugins'),
    harnessSlugs: [],  // skip harness-scoped plugin discovery
  });

  log('mount returned 1 plugin', result.mounted === 1, JSON.stringify(result));
  log('no errors during mount', result.errors.length === 0, JSON.stringify(result.errors));

  // Hit the mounted route.
  const res = await parent.fetch(new Request('http://localhost/api/plugins/echo-test/hello'));
  log('mounted route responds 200', res.status === 200);
  const body = await res.json() as any;
  log('mounted route body matches plugin', body?.ok === true && body?.from === 'echo-test', JSON.stringify(body));

  // Cleanup
  await fs.rm(fakeHome, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });
