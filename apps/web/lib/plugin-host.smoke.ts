/**
 * Smoke test for buildPluginRuntime — verifies:
 *   1. Construction succeeds against a real Postgres connection.
 *   2. Capability gating fires on missing caps.
 *   3. Storage works against a real fs path.
 *   4. fetch proxy gates undeclared hosts.
 *   5. secrets fallback to env works.
 *
 * Run with:
 *   cd libs/papercusp/apps/web && npx tsx lib/plugin-host.smoke.ts
 *
 * Requires HARNESS_DATABASE_URL pointing at a reachable papercusp DB.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { buildPluginRuntime } from './plugin-host';
import type { Plugin } from '@papercusp/plugin-sdk';

async function main() {
  let pass = 0;
  let fail = 0;
  const log = (label: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  const dataDir = join(tmpdir(), `papercusp-host-smoke-${process.pid}`);
  await fs.mkdir(dataDir, { recursive: true });

  const plugin: Plugin = {
    kind: 'plugin',
    name: 'smoke-plugin',
    version: '0.0.1',
    description: 'host runtime smoke test',
    capabilities: [
      'tasks:read',
      'goals:read',
      'storage:plugin-private',
      'http:fetch:weather.gov',
      'secrets:read:SMOKE_KEY',
    ] as any,
  };

  const runtime = buildPluginRuntime({
    slug: 'org-smoke-test',
    plugin,
    pluginDataDir: dataDir,
    log: () => {},
  });

  log('runtime constructed', !!runtime.ctx && !!runtime.api);
  log('ctx has installSlug', runtime.ctx.installSlug === 'org-smoke-test');
  log('ctx exposes pluginDataDir', runtime.ctx.pluginDataDir === dataDir);

  // 1. Capability gating: tasks.lineage requires tasks:read (which we have)
  //    Even though the slug doesn't exist, the cap check passes; the
  //    DB call may fail with a different error.
  try {
    await runtime.api.tasks.lineage('F-NOPE');
    log('tasks.lineage cap-allowed call ran', true);
  } catch (e: any) {
    // Either a DB error (slug doesn't exist) or NotYetWiredError — both fine.
    const okError = e?.message?.includes('schema') || e?.message?.includes('not yet wired') || e?.code === '3F000' || e?.code === '42P01';
    log('tasks.lineage cap-allowed call ran', okError, e?.message?.slice(0, 80));
  }

  // 2. Capability gating: tasks.create needs tasks:write — we don't have it.
  let createBlocked = false;
  try {
    await runtime.api.tasks.create({ title: 'should not work' });
  } catch (e: any) {
    if (e?.name === 'MissingCapabilityError') createBlocked = true;
  }
  log('tasks.create blocked without tasks:write', createBlocked);

  // 3. Storage works
  await runtime.api.storage.write('a/b/test.txt', 'hello world');
  const buf = await runtime.api.storage.read('a/b/test.txt');
  log('storage round-trip', buf?.toString() === 'hello world');
  const list = await runtime.api.storage.list();
  log('storage list returned files', list.includes('a/b/test.txt'), JSON.stringify(list));

  // 4. Storage path-escape
  let escapeBlocked = false;
  try { await runtime.api.storage.read('../../../etc/passwd'); }
  catch { escapeBlocked = true; }
  log('storage rejects path escape', escapeBlocked);

  // 5. fetch proxy gates undeclared hosts
  let fetchBlocked = false;
  try { await runtime.api.fetch('https://attacker.example/'); }
  catch (e: any) {
    if (e?.name === 'MissingCapabilityError') fetchBlocked = true;
  }
  log('fetch blocks undeclared host', fetchBlocked);

  // 6. secrets fallback to env
  process.env.SMOKE_KEY = 'env-value';
  const v = await runtime.api.secrets.read('SMOKE_KEY');
  log('secrets reads env fallback', v === 'env-value', v);

  // 7. capabilities() introspection
  const caps = runtime.api.capabilities();
  log('capabilities() returns 5 declared caps', caps.length === 5, JSON.stringify(caps));

  // Cleanup
  await fs.rm(dataDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
