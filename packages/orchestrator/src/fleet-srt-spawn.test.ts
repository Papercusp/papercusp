import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildProcessSrtSettings, createScopedNativeSandboxSpawn, wrapProcessWithSrt } from './fleet-srt-spawn.mjs';

const route = { baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) };
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-boundary-unit-'));
  return { cwd, env: { PAPERCUSP_AGENT: 'codex', CODEX_HOME: join(cwd, 'codex'),
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071', PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify(route) } };
};

describe('required scoped native process boundary', () => {
  it('leaves ordinary native launches unchanged', () => {
    expect(createScopedNativeSandboxSpawn({ cwd: '/checkout', env: {} })).toBeNull();
  });
  it('pins only the exact gateway and MCP ports on every native generation', () => {
    const f = fixture(); let policyDir: string | undefined;
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      for (const argv of [['first'], ['resume', 'native-2'], ['resume', 'native-3']]) {
        const result = spawn('/bin/sh', argv, f, (command, args, options) => ({ command, args, options }));
        expect(result.command).toBe('/usr/bin/srt');
        expect(result.args.slice(0, 3)).toEqual(['-s', result.args[1], '-c']);
        const path = result.args[1]; policyDir = dirname(path);
        const policy = JSON.parse(readFileSync(path, 'utf8'));
        expect(policy.network).toEqual({ allowedDomains: ['127.0.0.1:32001', '127.0.0.1:9071'], deniedDomains: [] });
        expect(policy.filesystem.denyWrite).toContain(policyDir);
        expect(policy.filesystem.denyRead).toContain('/home');
        expect(policy.filesystem.denyRead).toContain('/tmp');
        expect(policy.filesystem.allowWrite).toEqual([f.cwd, f.env.CODEX_HOME]);
        expect(policy.filesystem.allowRead).toContain(f.cwd);
        expect(policy.filesystem.allowRead).toContain(f.env.CODEX_HOME);
        expect(policy.filesystem.allowRead).not.toContain(homedir());
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(policy)).not.toContain(route.token);
        expect(result.args[3]).toContain("no_proxy='' NO_PROXY=''");
        expect(result.args[3]).toContain(`exec '/bin/sh' ${argv.map(a => `'${a}'`).join(' ')}`);
      }
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (policyDir) rmSync(policyDir, { recursive: true, force: true }); }
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
    const f = fixture(); let path: string | undefined; let calls = 0;
    const call = (command: string, argv: string[]) => { calls++; path = argv[1]; return command; };
    try {
      const spawn = createScopedNativeSandboxSpawn({ ...f, srtBin: '/usr/bin/srt' })!;
      spawn('/bin/sh', ['first'], f, call);
      for (const patch of [
        { CODEX_HOME: '/other' }, { PAPERCUSP_AGENT: 'claude' },
        { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9072' },
        { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ ...route, token: 'b'.repeat(64) }) },
        { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: undefined },
      ]) expect(() => spawn('/bin/sh', ['resume'], { ...f, env: { ...f.env, ...patch } }, call)).toThrow(/binding|lost/);
      expect(calls).toBe(1);
    } finally { rmSync(f.cwd, { recursive: true, force: true }); if (path) rmSync(dirname(path), { recursive: true, force: true }); }
  });
  it('shares shell quoting and required-wrapper refusal with fleet execution', () => {
    expect(wrapProcessWithSrt("/bin/a'b", ['$()', 'a b'], { srtBin: '/srt', settingsPath: '/p' }).argv[3])
      .toBe("export no_proxy='' NO_PROXY=''; exec '/bin/a'\\''b' '$()' 'a b'");
    expect(() => wrapProcessWithSrt('/cmd', [], { srtBin: null, settingsPath: '/p' })).toThrow(/unavailable/);
  });
  it('does not reallow a sibling directory that merely shares a denied prefix', () => {
    const own = join(homedir(), '.papercusp', 'own'), sibling = join(homedir(), '.papercusp-sibling');
    const settings = buildProcessSrtSettings({ cwd: '/checkout', agentHomes: [own, sibling], allowedDomains: [] }) as any;
    expect(settings.filesystem.allowRead).toEqual([own]);
  });
});
