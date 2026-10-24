import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildProcessSrtSettings, createScopedNativeSandboxSpawn, NATIVE_CONTAINER_EXEC_ENV, rootReadDenyPaths, wrapProcessWithSrt } from './fleet-srt-spawn.mjs';

const route = { baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) };
const fixture = () => {
  const cwd = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'native-boundary-unit-'));
  return { cwd, env: { PATH: process.env.PATH, PAPERCUSP_AGENT: 'codex', CODEX_HOME: join(cwd, 'codex'),
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071', PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify(route) } };
};

describe('required scoped native process boundary', () => {
  it('confines Claude to its clean home and rejects native route/env changes on reuse', () => {
    const f = fixture(), home = join(f.cwd, 'claude');
    const env = { ...f.env, PAPERCUSP_AGENT: 'claude', CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: home,
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ANTHROPIC_BASE_URL: route.baseURL, ANTHROPIC_AUTH_TOKEN: route.token };
    let privateTmp: string | undefined;
    try {
      const boundary = createScopedNativeSandboxSpawn({ cwd: f.cwd, env, srtBin: '/usr/bin/srt' })!;
      const result = boundary('/bin/sh', ['-c', 'true'], { cwd: f.cwd, env }, (command, args, options) => ({ command, args, options }));
      privateTmp = result.options.env.TMPDIR;
      const policy = JSON.parse(readFileSync(result.args[result.args.indexOf('-s') + 1], 'utf8'));
      expect(policy.filesystem.allowWrite).toEqual([f.cwd, home, privateTmp]);
      expect(policy.filesystem.allowRead).toContain(home); expect(result.options.env.HOME).toBe(home);
      expect(policy.network.allowedDomains).toEqual(['127.0.0.1:32001', '127.0.0.1:9071']);
      for (const patch of [{ CLAUDE_CONFIG_DIR: '/other' }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' },
        { ANTHROPIC_AUTH_TOKEN: 'other' }, { ANTHROPIC_API_KEY: 'host-key' }, { CODEX_HOME: '/other' }, { HOME: '/host' }]) {
        expect(() => boundary('/bin/sh', [], { cwd: f.cwd, env: { ...env, ...patch } }, () => { throw new Error('must not spawn'); }))
          .toThrow(/binding changed/);
      }
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });

  it('leaves ordinary native launches unchanged', () => {
    expect(createScopedNativeSandboxSpawn({ cwd: '/checkout', env: {} })).toBeNull();
  });
  it('admits only the frozen server-owned Docker wrapper and never leaks its authority into the child', () => {
    const f = fixture();
    const command = join(f.cwd, 'codex');
    const source = '#!/bin/sh\nexit 0\n';
    writeFileSync(command, source, { mode: 0o700 });
    const binding = { kind: 'docker-exec', command, sha256: createHash('sha256').update(source).digest('hex') };
    const env = { ...f.env, PAPERCUSP_BACKEND_BIN_CODEX: command, [NATIVE_CONTAINER_EXEC_ENV]: JSON.stringify(binding) };
    let calls = 0;
    const realSpawn = (bin: string, args: string[], options: any) => { calls++; return { bin, args, options }; };
    try {
      const boundary = createScopedNativeSandboxSpawn({ cwd: f.cwd, env, srtBin: null })!;
      for (const args of [['first'], ['resume', 'native-2']]) {
        const result = boundary(command, args, { cwd: f.cwd, env }, realSpawn);
        expect(result.bin).toBe(command);
        expect(result.args).toEqual(args);
        expect(result.options.env[NATIVE_CONTAINER_EXEC_ENV]).toBeUndefined();
        expect(env[NATIVE_CONTAINER_EXEC_ENV]).toBe(JSON.stringify(binding));
      }
      expect(() => boundary('/bin/sh', [], { cwd: f.cwd, env }, realSpawn)).toThrow(/executable binding changed/);
      for (const patch of [
        { CODEX_HOME: '/other' }, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9072' },
        { PAPERCUSP_BACKEND_BIN_CODEX: '/bin/sh' }, { [NATIVE_CONTAINER_EXEC_ENV]: undefined },
        { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ ...route, token: 'b'.repeat(64) }) },
      ]) expect(() => boundary(command, [], { cwd: f.cwd, env: { ...env, ...patch } }, realSpawn)).toThrow(/binding changed/);
      writeFileSync(command, source + '# changed\n');
      expect(() => boundary(command, [], { cwd: f.cwd, env }, realSpawn)).toThrow(/executable binding changed/);
      expect(calls).toBe(2);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it('refuses malformed or unmetered container authority and leaves an unbound override inside SRT', () => {
    const f = fixture();
    try {
      for (const value of ['{', '{}', JSON.stringify({ kind: 'docker-exec', command: '/bin/sh', sha256: 'a'.repeat(64) })])
        expect(() => createScopedNativeSandboxSpawn({ ...f, env: { ...f.env, [NATIVE_CONTAINER_EXEC_ENV]: value } })).toThrow(/container binding/);
      expect(() => createScopedNativeSandboxSpawn({ ...f, env: { [NATIVE_CONTAINER_EXEC_ENV]: '{}' } })).toThrow(/metered route/);
      // An arbitrary executable override carries no permission to replace SRT.
      expect(() => createScopedNativeSandboxSpawn({ ...f,
        env: { ...f.env, PAPERCUSP_BACKEND_BIN_CODEX: '/bin/sh' }, srtBin: null })).toThrow(/refusing unconfined/);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it('omits root symlink aliases while retaining the real target entry in read denies', () => {
    const entry = (name: string, symlink = false) => ({ name, isSymbolicLink: () => symlink });
    expect(rootReadDenyPaths([
      entry('home'), entry('sessions', true), entry('proc'), entry('dev'), entry('sys'), entry('etc'),
    ])).toEqual(['/home', '/etc']);
  });
  it('pins only the exact gateway and MCP ports on every native generation', () => {
    const f = fixture(); let policyDir: string | undefined; let privateTmp: string | undefined;
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      for (const argv of [['first'], ['resume', 'native-2'], ['resume', 'native-3']]) {
        const result = spawn('/bin/sh', argv, f, (command, args, options) => ({ command, args, options }));
        expect(result.command).toMatch(/\/bwrap$/);
        const settingsIndex = result.args.indexOf('-s');
        expect(result.args.slice(settingsIndex, settingsIndex + 3)).toEqual(['-s', result.args[settingsIndex + 1], '-c']);
        const path = result.args[settingsIndex + 1]; policyDir = dirname(path);
        expect(result.args).toContain('/tmp/claude');
        expect(result.options.env.HOME).toBe(f.env.CODEX_HOME);
        privateTmp = result.options.env.CLAUDE_CODE_TMPDIR;
        expect(privateTmp).toMatch(/^\/tmp\/pc-native-/);
        expect(result.options.env.TMPDIR).toBe(privateTmp);
        const policy = JSON.parse(readFileSync(path, 'utf8'));
        expect(policy.network).toEqual({ allowedDomains: ['127.0.0.1:32001', '127.0.0.1:9071'], deniedDomains: [] });
        expect(policy.filesystem.denyWrite).toContain(policyDir);
        expect(policy.filesystem.denyRead).toContain('/home');
        expect(policy.filesystem.denyRead).toContain('/tmp');
        expect(policy.filesystem.allowWrite).toEqual([f.cwd, f.env.CODEX_HOME, privateTmp]);
        expect(policy.filesystem.allowRead).toContain(f.cwd);
        expect(policy.filesystem.allowRead).toContain(f.env.CODEX_HOME);
        expect(policy.filesystem.allowRead).not.toContain(homedir());
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(policy)).not.toContain(route.token);
        expect(result.args[settingsIndex + 3]).toContain("no_proxy='' NO_PROXY=''");
        expect(result.args[settingsIndex + 3]).toContain(`exec '${realpathSync('/bin/sh')}' ${argv.map(a => `'${a}'`).join(' ')}`);
      }
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (policyDir) rmSync(policyDir, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it.each([
    { PAPERCUSP_AGENT: 'claude' }, { CODEX_HOME: 'relative' },
    { CODEX_HOME: '/' }, { CODEX_HOME: '/dev/shm/native-home' },
    { PAPERCUSP_OPERATOR_URL: 'https://api.openai.com' },
    { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071/path' },
    { PAPERCUSP_OPERATOR_URL: 'http://user:secret@127.0.0.1:9071' },
    { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: '{"token":"DO-NOT-PRINT' },
  ])('refuses unsupported or invalid bindings before spawning: %j', patch => {
    const f = fixture();
    try {
      expect(() => createScopedNativeSandboxSpawn({ ...f, env: { ...f.env, ...patch }, srtBin: '/usr/bin/srt' })).toThrow(/Scoped|scoped|Invalid/);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it('refuses absent SRT instead of executing raw', () => {
    const f = fixture();
    try { expect(() => createScopedNativeSandboxSpawn({ ...f, srtBin: null })).toThrow(/refusing unconfined/); }
    finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it('rejects changed carry route without invoking the spawn', () => {
    const f = fixture(); let path: string | undefined; let privateTmp: string | undefined; let calls = 0;
    const call = (command: string, argv: string[], options: any) => { calls++; path = argv[argv.indexOf('-s') + 1]; privateTmp = options.env.TMPDIR; return command; };
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      spawn('/bin/sh', ['first'], f, call);
      for (const patch of [
        { PATH: '/other' },
        { CODEX_HOME: '/other' }, { PAPERCUSP_AGENT: 'claude' },
        { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9072' },
        { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ ...route, token: 'b'.repeat(64) }) },
        { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: undefined },
      ]) expect(() => spawn('/bin/sh', ['resume'], { ...f, env: { ...f.env, ...patch } }, call)).toThrow(/binding|lost/);
      expect(calls).toBe(1);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (path) rmSync(dirname(path), { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it('shares shell quoting and required-wrapper refusal with fleet execution', () => {
    expect(wrapProcessWithSrt("/bin/a'b", ['$()', 'a b'], { srtBin: '/srt', settingsPath: '/p' }).argv[3])
      .toBe("export no_proxy='' NO_PROXY=''; exec '/bin/a'\\''b' '$()' 'a b'");
    expect(() => wrapProcessWithSrt('/cmd', [], { srtBin: null, settingsPath: '/p' })).toThrow(/unavailable/);
  });
  it.each(['promise', 'pty', 'child', 'throw'])('cleans private native temp after %s completion and recreates it on resume', async kind => {
    const f = fixture(); let privateTmp: string | undefined; let exit: (() => void) | undefined;
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      const realSpawn = (_command: string, _args: string[], options: any) => {
        privateTmp = options.env.TMPDIR;
        expect(existsSync(privateTmp!)).toBe(true);
        if (kind === 'throw') throw new Error('spawn failed');
        if (kind === 'promise') return Promise.resolve('done');
        if (kind === 'pty') return { onExit: (callback: () => void) => { exit = callback; } };
        return { once: (event: string, callback: () => void) => { expect(event).toBe('close'); exit = callback; } };
      };
      if (kind === 'throw') expect(() => spawn('/bin/sh', ['first'], f, realSpawn)).toThrow('spawn failed');
      else { await spawn('/bin/sh', ['first'], f, realSpawn); exit?.(); }
      const priorTmp = privateTmp!;
      expect(existsSync(priorTmp)).toBe(false);
      await spawn('/bin/sh', ['resume'], f, (_command, _args, options) => {
        privateTmp = options.env.TMPDIR;
        expect(privateTmp).not.toBe(priorTmp);
        expect(existsSync(privateTmp!)).toBe(true);
        return Promise.resolve('done');
      });
      expect(existsSync(privateTmp!)).toBe(false);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it('refuses an executable replaced at the same path before a managed resume', async () => {
    const f = fixture(); const executable = join(f.cwd, 'native-fixture'); let calls = 0;
    try {
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      const realSpawn = () => { calls++; return Promise.resolve('done'); };
      await spawn(executable, ['first'], f, realSpawn);
      writeFileSync(executable, '#!/bin/sh\nexit 1\n');
      expect(() => spawn(executable, ['resume'], f, realSpawn)).toThrow(/executable contents changed/);
      expect(calls).toBe(1);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it.each(['managed', 'pty'])('keeps native mounts until the asynchronously registered %s process ends', async kind => {
    const f = fixture(); let privateTmp: string | undefined;
    const child = new EventEmitter(); let exit: (() => void) | undefined;
    const result = kind === 'managed' ? { taskId: 'native-task', child }
      : { onExit: (callback: () => void) => { exit = callback; } };
    try {
      const boundary = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      const registered = await boundary('/bin/sh', ['first'], f, async (_command, _args, options) => {
        privateTmp = options.env.TMPDIR;
        return result;
      });
      expect(registered).toBe(result);
      expect(existsSync(privateTmp!)).toBe(true);
      if (kind === 'managed') child.emit('close', 0); else exit!();
      expect(existsSync(privateTmp!)).toBe(false);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it('cleans private mounts when asynchronous registration rejects', async () => {
    const f = fixture(); let privateTmp: string | undefined;
    try {
      const boundary = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      await expect(boundary('/bin/sh', [], f, async (_command, _args, options) => {
        privateTmp = options.env.TMPDIR; throw new Error('registration failed');
      })).rejects.toThrow('registration failed');
      expect(existsSync(privateTmp!)).toBe(false);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it('cleans mounts when a child already exited before async registration returned', async () => {
    const f = fixture(); let privateTmp: string | undefined;
    const child = Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null });
    try {
      const boundary = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      await boundary('/bin/sh', [], f, async (_command, _args, options) => {
        privateTmp = options.env.TMPDIR; return { child, taskId: 'fast-native-task' };
      });
      expect(existsSync(privateTmp!)).toBe(false);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (privateTmp) rmSync(privateTmp, { recursive: true, force: true }); }
  });
  it('preserves the installed package location when PATH names a symlink', async () => {
    const f = fixture(); const bin = join(f.cwd, 'installed', 'bin'); mkdirSync(bin, { recursive: true });
    const real = join(bin, 'codex.js'); const alias = join(f.cwd, 'native-codex');
    writeFileSync(real, '#!/usr/bin/env node\n', { mode: 0o700 }); symlinkSync(real, alias);
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      await spawn(alias, ['--version'], f, (_command, args) => {
        expect(args[args.indexOf('-c') + 1]).toContain(`exec '${real}' '--version'`);
        return Promise.resolve('done');
      });
    } finally { rmSync(f.cwd, { recursive: true, force: true }); }
  });
  it('does not reallow a sibling directory that merely shares a denied prefix', () => {
    const own = join(homedir(), '.papercusp', 'own'), sibling = join(homedir(), '.papercusp-sibling');
    const settings = buildProcessSrtSettings({ cwd: '/checkout', agentHomes: [own, sibling], allowedDomains: [] }) as any;
    expect(settings.filesystem.allowRead).toEqual([own]);
  });
});
