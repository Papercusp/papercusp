/**
 * Unit tests for the github-repo plugin's `gitPush` helper.
 *
 * WI-3057-class regression: `gitPush` sets `origin` to a token-embedded URL
 * (step 3) so `git push` never prompts for credentials, then pushes (step 4).
 * The token thereby lands in this harness's own `.git/config` the moment
 * step 3 runs — a hard postcondition to reset `origin` back to the token-free
 * `cloneUrl` afterward (mirroring the fix applied to the shared-harness join
 * clone path in packages/operator-core/lib/harness/join-shared-harness.ts's
 * `ensureDetokenizedOrigin`), regardless of whether the push itself succeeds.
 *
 * `gitPush` spawns no real child process here — a fake `ctx.spawn` models
 * git's actual `origin` remote-url state (updated by `remote set-url` /
 * `remote add`, read back implicitly via the test's own tracking var) rather
 * than a stateless stub, so a bug that skips or mis-sequences the reset is
 * actually caught.
 */
import { describe, it, expect, vi } from 'vitest';
import { gitPush } from './index';
import type { PapercuspContext, PluginSpawn } from '@papercusp/plugin-sdk';

const CLEAN_URL = 'https://github.com/myorg/myrepo.git';
const TOKEN = 'ghs_supersecret';
const AUTHED_URL = `https://x-access-token:${TOKEN}@github.com/myorg/myrepo.git`;

/** A stateful fake `spawn` modeling real git remote-url + push behavior. */
function makeSpawn(opts: { pushFails?: boolean; resetFails?: boolean } = {}) {
  let origin = '';
  const calls: { bin: string; args: string[] }[] = [];
  const spawn: PluginSpawn = vi.fn(async (bin: string, args: readonly string[]) => {
    calls.push({ bin, args: [...args] });
    if (bin !== 'git') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'remote' && args[1] === 'set-url') {
      if (args[2] === 'origin' && args[3] === CLEAN_URL && opts.resetFails) {
        return { stdout: '', stderr: `failed for ${origin}`, code: 1 };
      }
      origin = args[3] as string;
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'remote' && args[1] === 'add') {
      origin = args[3] as string;
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'push') {
      if (opts.pushFails) return { stdout: '', stderr: `push failed for ${origin}`, code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }) as unknown as PluginSpawn;
  return { spawn, calls, getOrigin: () => origin };
}

function makeCtx(spawn: PluginSpawn): PapercuspContext {
  return {
    installSlug: 'test-harness',
    projectDir: '/tmp/does-not-need-to-exist-for-this-test',
    stateDir: '/tmp/state',
    pluginDataDir: '/tmp/state/plugins/github-repo',
    log: () => {},
    spawn,
  };
}

describe('gitPush — de-tokenizes origin after the push attempt (WI-3057-class)', () => {
  it('on a successful push: resets origin back to the token-free URL', async () => {
    const { spawn, calls, getOrigin } = makeSpawn();
    const result = await gitPush(makeCtx(spawn), CLEAN_URL, 'main', TOKEN);

    expect(result.ok).toBe(true);
    // origin was embedded with the token at some point (step 3)...
    expect(calls.some((c) => c.args.includes(AUTHED_URL))).toBe(true);
    // ...but ends up clean afterward (step 5 reset).
    expect(getOrigin()).toBe(CLEAN_URL);
    // The final remote-url call is the clean reset, not the authed URL.
    const setUrlCalls = calls.filter((c) => c.args[0] === 'remote' && c.args[1] === 'set-url');
    expect(setUrlCalls.at(-1)?.args).toContain(CLEAN_URL);
  });

  it('the de-tokenize reset still runs even when the push itself FAILS — token never left behind on a failed push', async () => {
    const { spawn, getOrigin } = makeSpawn({ pushFails: true });
    const result = await gitPush(makeCtx(spawn), CLEAN_URL, 'main', TOKEN);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('git push failed');
    expect(result.error).not.toContain(TOKEN); // redacted
    // Origin was still cleaned up despite the push failure.
    expect(getOrigin()).toBe(CLEAN_URL);
  });

  it('reports a failure (not a silent success) when the push succeeds but the token-free reset fails, and redacts the token', async () => {
    const { spawn } = makeSpawn({ resetFails: true });
    const result = await gitPush(makeCtx(spawn), CLEAN_URL, 'main', TOKEN);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token/i);
    expect(result.error).not.toContain(TOKEN);
  });

  it('never lets the raw token reach any returned error message', async () => {
    const { spawn } = makeSpawn({ pushFails: true, resetFails: true });
    const result = await gitPush(makeCtx(spawn), CLEAN_URL, 'main', TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
