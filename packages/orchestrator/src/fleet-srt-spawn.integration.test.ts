import { it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScopedNativeSandboxSpawn } from './fleet-srt-spawn.mjs';

// Linux SRT mounts a private /dev/shm. The test runner may use it as TMPDIR,
// but positive-control fixtures must survive into the real child namespace.
const physicalTmp = process.platform === 'linux' ? '/tmp' : tmpdir();

const listen = (s: Server) => new Promise<number>((resolve, reject) => {
  s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
});
const stop = (s: Server) => new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()));
function run(command: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Native boundary fixture exceeded 15 seconds')); }, 15_000);
    p.stdout.on('data', x => { stdout += x; }); p.stderr.on('data', x => { stderr += x; });
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

it('keeps frozen verifier inputs read-only without materializing sandbox mount points', async () => {
  const cwd = mkdtempSync(join(physicalTmp, 'native-frozen-source-'));
  const nativeHome = mkdtempSync(join(physicalTmp, 'native-frozen-home-'));
  writeFileSync(join(cwd, '.verifier-source.json'), '{}');
  writeFileSync(join(cwd, 'input.txt'), 'FROZEN_INPUT');
  mkdirSync(join(cwd, '.claude'));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(),
    PAPERCUSP_AGENT: 'codex', CODEX_HOME: nativeHome, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
    PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }) };
  try {
    const boundary = createScopedNativeSandboxSpawn({ cwd, env })!;
    const result = await boundary('/bin/sh', ['-c',
      'cat input.txt && ! (printf changed > input.txt) && printf state > "$CODEX_HOME/state"'],
    { cwd, env }, run);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: 'FROZEN_INPUT' });
    expect(readFileSync(join(cwd, 'input.txt'), 'utf8')).toBe('FROZEN_INPUT');
    expect(readFileSync(join(nativeHome, 'state'), 'utf8')).toBe('state');
    for (const path of ['.mcp.json', '.claude/commands', '.claude/agents'])
      expect(existsSync(join(cwd, path)), path).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(nativeHome, { recursive: true, force: true });
  }
}, 30_000);

it('isolates assigned corpus from sibling-arm solutions and hidden grader files', async () => {
  const cwd = mkdtempSync(join(physicalTmp, 'native-context-assigned-'));
  const sibling = mkdtempSync(join(physicalTmp, 'native-context-other-arm-'));
  const homeCorpus = mkdtempSync(join(homedir(), '.native-context-other-arm-'));
  mkdirSync(join(physicalTmp, 'claude'), { recursive: true });
  const sharedTmp = mkdtempSync(join(physicalTmp, 'claude', 'native-context-other-arm-'));
  const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
  const own = join(cwd, 'permitted-corpus.txt'); writeFileSync(own, 'PERMITTED_INITIAL_CORPUS');
  const secrets = [join(sibling, 'other-arm-solution.txt'), join(sibling, 'hidden-grader-answer.txt'),
    join(homeCorpus, 'prior-memory.txt'), join(sharedTmp, 'prior-output.txt')];
  for (const path of secrets) writeFileSync(path, 'FORBIDDEN_CONTEXT_SENTINEL');
  const alias = join(cwd, 'sibling-link'); symlinkSync(secrets[0], alias);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(),
    PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
    PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }) };
  let policyDir: string | undefined;
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    const boundary = createScopedNativeSandboxSpawn({ cwd, env })!;
    const sandbox = (script: string) => boundary('/bin/sh', ['-c', script], { cwd, env },
      (command, args, options) => { policyDir = dirname(args[args.indexOf('-s') + 1]); return run(command, args, options); });
    const allowed = await sandbox(`/bin/cat ${quote(own)} && printf native > ${quote(join(codexHome, 'state'))}`);
    expect(allowed, allowed.stderr).toMatchObject({ code: 0, stdout: 'PERMITTED_INITIAL_CORPUS' });
    for (const path of [...secrets, alias]) {
      // Positive control distinguishes confinement from a missing fixture.
      expect(await run('/bin/cat', [path], { cwd, env })).toMatchObject({ code: 0, stdout: 'FORBIDDEN_CONTEXT_SENTINEL' });
      const denied = await sandbox(`/bin/cat ${quote(path)}`);
      expect(denied, path).toMatchObject({ stdout: '' });
      expect(denied.code, path).not.toBe(0);
    }
  } finally {
    for (const path of [cwd, sibling, homeCorpus, sharedTmp, policyDir]) if (path) rmSync(path, { recursive: true, force: true });
  }
}, 45_000);

it('physically permits only assigned ports and rejects raw sockets, policy writes and credential reads', async () => {
  const cwd = mkdtempSync(join(physicalTmp, 'native-boundary-physical-'));
  const hidden = mkdtempSync(join(homedir(), '.papercusp', 'native-boundary-fixture-'));
  const codexHome = join(hidden, 'codex-home'); mkdirSync(codexHome);
  const secret = join(hidden, 'harmless-credential.txt'); writeFileSync(secret, 'fixture-only');
  const calls = [0, 0, 0];
  const servers = calls.map((_, i) => createServer((_req, res) => { calls[i]++; res.end(`endpoint-${i}`); }));
  let policyDir: string | undefined;
  try {
    const [gateway, operator, forbidden] = await Promise.all(servers.map(listen));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(),
      PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome, PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operator}`,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: `http://127.0.0.1:${gateway}`, token: 'a'.repeat(64) }) };
    // The positive raw control establishes that the forbidden endpoint is live
    // and reachable on this host, rather than testing an absent service.
    const control = await run('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--max-time', '3', `http://127.0.0.1:${forbidden}`], { cwd, env });
    expect(control).toMatchObject({ code: 0, stdout: 'endpoint-2' }); expect(calls[2]).toBe(1);
    const boundary = createScopedNativeSandboxSpawn({ cwd, env })!;
    const spawnThroughBoundary = (script: string) => boundary('/bin/sh', ['-c', script], { cwd, env },
      (command, args, options) => { policyDir = dirname(args[args.indexOf('-s') + 1]); return run(command, args, options); });
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const reach = (port: number, extra = '') => `/usr/bin/curl --silent --show-error --fail --max-time 3 ${extra} http://127.0.0.1:${port}`;
    const allowed = await spawnThroughBoundary(`${reach(gateway)} && printf '\\n' && ${reach(operator)} && printf '\\n' && printf writable > ${quote(join(codexHome, 'native-state'))}`);
    expect(allowed, allowed.stderr).toMatchObject({ code: 0, stdout: 'endpoint-0\nendpoint-1\n' });
    expect(readFileSync(join(codexHome, 'native-state'), 'utf8')).toBe('writable');
    const denied = await spawnThroughBoundary(reach(forbidden));
    expect(denied.code).not.toBe(0); expect(calls[2]).toBe(1);
    const raw = await spawnThroughBoundary(reach(gateway, "--noproxy '*'"));
    expect(raw.code).not.toBe(0); expect(calls[0]).toBe(1);
    const hiddenRead = await spawnThroughBoundary(`/bin/cat ${quote(secret)}`);
    expect(hiddenRead.code).not.toBe(0); expect(hiddenRead.stdout).not.toContain('fixture-only');
    const rewrite = await spawnThroughBoundary(`printf '{}' > ${quote(join(policyDir!, 'settings.json'))}`);
    expect(rewrite.code).not.toBe(0);
    expect(JSON.parse(readFileSync(join(policyDir!, 'settings.json'), 'utf8')).network.allowedDomains)
      .toEqual([`127.0.0.1:${gateway}`, `127.0.0.1:${operator}`]);
  } finally {
    await Promise.all(servers.map(s => s.listening ? stop(s) : Promise.resolve()));
    rmSync(cwd, { recursive: true, force: true }); rmSync(hidden, { recursive: true, force: true });
    if (policyDir) rmSync(policyDir, { recursive: true, force: true });
  }
}, 45_000);
