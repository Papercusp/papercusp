/** Shared process settings and SRT argv for orchestrated and native PTY spawns.
 * Plain ESM keeps the native launcher independent of the orchestrator's TS loader.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotScopedInferenceGateway, SCOPED_INFERENCE_GATEWAY_ENV } from './codex-gateway-config.ts';

export const FLEET_SANDBOX_DENY_READ = Object.freeze([
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud', '~/.papercusp', '~/.npmrc',
]);
export const FLEET_SANDBOX_CACHE_ROOT = join(homedir(), '.cache', 'papercusp-fleet-sandbox');
// Written only by capability:launch-agent's private backend-override context.
export const NATIVE_CONTAINER_EXEC_ENV = 'PAPERCUSP_NATIVE_CONTAINER_EXEC';

/** Expand real root entries only; root symlink aliases are covered at their target. */
export function rootReadDenyPaths(entries) {
  return entries.filter(entry => !entry.isSymbolicLink() && !['proc', 'dev', 'sys'].includes(entry.name))
    .map(entry => join('/', entry.name));
}

/** Network entries are resolved by the caller, never from ambient defaults here. */
export function buildProcessSrtSettings({ cwd, agentHomes = [], allowedDomains, denyWrite = [] }) {
  const home = homedir();
  const abs = p => p.startsWith('~/') ? join(home, p.slice(2)) : p;
  const denyRead = FLEET_SANDBOX_DENY_READ.map(abs);
  const homes = agentHomes.filter(Boolean).map(abs);
  const allowRead = homes.filter(h => denyRead.some(d => h === d || h.startsWith(d + sep)));
  return {
    network: { allowedDomains: [...allowedDomains], deniedDomains: [] },
    filesystem: { allowWrite: [cwd, FLEET_SANDBOX_CACHE_ROOT, ...homes],
      denyWrite: [...denyWrite], denyRead, ...(allowRead.length ? { allowRead } : {}) },
  };
}

/** The same shell quoting and loopback proxy handling for every SRT spawn. */
export function wrapProcessWithSrt(command, argv, { srtBin, settingsPath }) {
  if (!srtBin || !settingsPath) throw new Error('Required process sandbox is unavailable');
  const quote = p => `'${p.replace(/'/g, `'\\''`)}'`;
  const inner = `export no_proxy='' NO_PROXY=''; exec ${[command, ...argv].map(quote).join(' ')}`;
  return { command: srtBin, argv: ['-s', settingsPath, '-c', inner] };
}

function loopbackEndpoint(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Scoped native sandbox requires an exact loopback operator endpoint'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('Scoped native sandbox requires an exact loopback operator endpoint');
  return `${u.hostname}:${u.port || '80'}`;
}

function scopedRuntimeBinding(command, env) {
  const resolveExecutable = name => {
    const path = isAbsolute(name) ? name : (env.PATH ?? '').split(sep === '/' ? ':' : ';')
      .filter(Boolean).map(p => join(p, name)).find(existsSync);
    if (!path) throw new Error('Scoped native executable is unavailable');
    return { path, real: realpathSync(path) };
  };
  const executable = resolveExecutable(command);
  // Codex's native distribution keeps ripgrep and sandbox resources alongside
  // bin/, and its npm entry point keeps the platform package below its root.
  // Grant that installed runtime, never the surrounding user/home directory.
  const runtime = ['codex', 'codex.js'].includes(basename(executable.real)) &&
    basename(dirname(executable.real)) === 'bin' ? dirname(dirname(executable.real)) : executable.real;
  const node = resolveExecutable('node');
  return { command: executable.real,
    readPaths: [...new Set([executable.path, executable.real, runtime, node.path, node.real])] };
}

export function scopedSandboxReadPaths(bin) {
  if (!existsSync(bin)) return [bin]; // pure spawn composition may use an injected executable
  const real = realpathSync(bin);
  const marker = '/@anthropic-ai/sandbox-runtime/';
  if (real.includes(marker)) return [bin, real.slice(0, real.indexOf(marker) + marker.length - 1)];
  // The maintained launcher also supports the small POSIX shim for a globally
  // installed SRT. Its explicit package path is the authority for seccomp
  // resources; do not open the surrounding home or global node_modules pool.
  const source = statSync(real).size < 32768 ? readFileSync(real, 'utf8') : '';
  const entry = source.match(/\/[^\s"']+\/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js/);
  return entry ? [bin, real, dirname(dirname(entry[0]))] : [bin, real];
}

function scopedExecutableFingerprint(paths) {
  return JSON.stringify([...new Set(paths.filter(existsSync).map(p => realpathSync(p)))]
    .filter(p => statSync(p).isFile())
    .map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
}

/** Required final-PTY wrapper. The route and policy are captured before the
 * first native spawn, and checked again on every recycle/carry/park resume.
 * Other loopback ports, providers and registries never enter this allowlist.
 * This confines native descendants; server-side MCP operations have their own
 * boundary and are not attested by this wrapper.
 */
export function createScopedNativeSandboxSpawn({ env, cwd, srtBin }) {
  const encoded = env[SCOPED_INFERENCE_GATEWAY_ENV];
  const containerEncoded = env[NATIVE_CONTAINER_EXEC_ENV];
  if (encoded === undefined) {
    if (containerEncoded !== undefined) throw new Error('Scoped native container boundary requires its metered route');
    return null;
  }
  let route;
  try { route = snapshotScopedInferenceGateway(JSON.parse(encoded)); }
  catch { throw new Error('Invalid scoped native sandbox route'); }
  const codexHome = env.CODEX_HOME;
  if (env.PAPERCUSP_AGENT !== 'codex' || !isAbsolute(cwd) || !codexHome || !isAbsolute(codexHome))
    throw new Error('Scoped native sandbox requires an isolated Codex home and absolute checkout');
  if (process.platform !== 'linux') throw new Error('Scoped native read isolation requires the verified Linux mount boundary');
  if (cwd === '/' || codexHome === '/' || [cwd, codexHome].some(p => p === '/dev/shm' || p.startsWith('/dev/shm/')))
    throw new Error('Scoped native checkout/home must survive the private device namespace and cannot grant the filesystem root');
  const operatorEndpoint = loopbackEndpoint(env.PAPERCUSP_OPERATOR_URL);
  const gatewayEndpoint = loopbackEndpoint(route.baseURL);
  const verifyBinding = options => {
    let current;
    try { current = snapshotScopedInferenceGateway(JSON.parse(options.env[SCOPED_INFERENCE_GATEWAY_ENV])); }
    catch { throw new Error('Scoped native sandbox lost its route before spawn'); }
    if (options.cwd !== cwd || options.env.PATH !== env.PATH || options.env.CODEX_HOME !== codexHome || options.env.PAPERCUSP_AGENT !== 'codex' ||
        current.baseURL !== route.baseURL || current.token !== route.token ||
        options.env[NATIVE_CONTAINER_EXEC_ENV] !== containerEncoded ||
        loopbackEndpoint(options.env.PAPERCUSP_OPERATOR_URL) !== operatorEndpoint)
      throw new Error('Scoped native sandbox binding changed before spawn');
  };
  if (containerEncoded !== undefined) {
    let binding;
    try { binding = JSON.parse(containerEncoded); } catch { throw new Error('Invalid scoped native container binding'); }
    if (!binding || binding.kind !== 'docker-exec' || typeof binding.command !== 'string' || !isAbsolute(binding.command) ||
        !/^[a-f0-9]{64}$/.test(binding.sha256) || Object.keys(binding).sort().join(',') !== 'command,kind,sha256' ||
        env.PAPERCUSP_BACKEND_BIN_CODEX !== binding.command)
      throw new Error('Invalid scoped native container binding');
    const verifyExecutable = command => {
      if (command !== binding.command || realpathSync(command) !== binding.command || !statSync(command).isFile() ||
          (statSync(command).mode & 0o022) !== 0 ||
          createHash('sha256').update(readFileSync(command)).digest('hex') !== binding.sha256)
        throw new Error('Scoped native container executable binding changed before spawn');
    };
    verifyExecutable(binding.command);
    // The operator-generated wrapper runs host preparation, then docker execs
    // the agent in the task namespace. SRT would mount the source home before
    // rename (EBUSY) and hide the Docker socket and trusted records. Admit only
    // this exact wrapper, on every managed generation.
    return (command, argv, options, realSpawn) => {
      verifyBinding(options);
      if (options.env.PAPERCUSP_BACKEND_BIN_CODEX !== binding.command)
        throw new Error('Scoped native container override binding changed before spawn');
      verifyExecutable(command);
      const childEnv = { ...options.env };
      delete childEnv[NATIVE_CONTAINER_EXEC_ENV];
      return realSpawn(command, argv, { ...options, env: childEnv });
    };
  }
  const bin = srtBin === undefined
    ? (env.PATH ?? '').split(sep === '/' ? ':' : ';').filter(Boolean).map(p => join(p, 'srt')).find(existsSync)
    : srtBin;
  if (!bin) throw new Error('Scoped native launch requires SRT; refusing unconfined execution');
  const bwrap = (env.PATH ?? process.env.PATH ?? '').split(':').filter(Boolean).map(p => join(p, 'bwrap')).find(existsSync);
  if (!bwrap) throw new Error('Scoped native launch requires bubblewrap for private default temporary paths');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let nativeTmp;
  const dir = mkdtempSync(join(codexHome, 'papercusp-native-srt-'));
  const settingsPath = join(dir, 'settings.json');
  let runtimePaths;
  let executableFingerprint;
  return (command, argv, options, realSpawn) => {
    verifyBinding(options);
    const runtime = scopedRuntimeBinding(command, env);
    const observedRuntimePaths = runtime.readPaths;
    if (runtimePaths && JSON.stringify(runtimePaths) !== JSON.stringify(observedRuntimePaths))
      throw new Error('Scoped native executable binding changed before spawn');
    const observedFingerprint = scopedExecutableFingerprint([...observedRuntimePaths, bin, bwrap]);
    if (executableFingerprint && executableFingerprint !== observedFingerprint)
      throw new Error('Scoped native executable contents changed before spawn');
    executableFingerprint = observedFingerprint;
    // Unix-domain socket addresses are bounded. A deep per-session native home
    // cannot hold SRT's bridge names, so use a short private root and grant only
    // that root. Re-create it after a managed generation's exit cleanup.
    if (!nativeTmp || !existsSync(nativeTmp)) nativeTmp = mkdtempSync('/tmp/pc-native-');
    {
      runtimePaths = observedRuntimePaths;
      const policy = buildProcessSrtSettings({ cwd, agentHomes: [codexHome],
        allowedDomains: [...new Set([gatewayEndpoint, operatorEndpoint])], denyWrite: [dir] });
      // Generic fleet credential denies leave ordinary host data readable.
      // Each metered assignment instead gets only its checkout, native state
      // and installed runtime. The fleet cache is shared context, so exclude it.
      policy.filesystem.allowWrite = [cwd, codexHome, nativeTmp];
      // Expand real root entries ourselves. SRT's '/' preset also tmpfs-mounts
      // root symlink aliases after their targets have been hidden and can fail
      // before execution. Alias targets remain subject to the same real mounts.
      const rootDenies = rootReadDenyPaths(readdirSync('/', { withFileTypes: true }));
      policy.filesystem.denyRead = [...rootDenies, ...policy.filesystem.denyRead];
      policy.filesystem.allowRead = [cwd, codexHome, nativeTmp, '/usr', '/bin', '/sbin', '/lib', '/lib64',
        '/etc/ssl', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/nsswitch.conf',
        '/etc/hosts', '/etc/resolv.conf', '/etc/passwd', '/etc/group', '/etc/localtime',
        ...runtimePaths, ...scopedSandboxReadPaths(bin)];
      writeFileSync(settingsPath, JSON.stringify(policy), { mode: 0o600 });
    }
    // A file bind can dereference an executable symlink. Launch its real path
    // so Node's import.meta.url/createRequire keep the installed package root.
    const wrapped = wrapProcessWithSrt(runtime.command, argv, { srtBin: bin, settingsPath });
    // SRT always adds /tmp/claude and HOME debug directories to write grants.
    // Give its host-side launcher a private view of those defaults too, before
    // its existing network/PID/seccomp boundary runs. Otherwise a write grant
    // re-binds shared host context through an otherwise complete read deny.
    const mountArgs = ['--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--bind', nativeTmp, '/tmp/claude'];
    if (existsSync('/private/tmp/claude')) mountArgs.push('--bind', nativeTmp, '/private/tmp/claude');
    const tempForSpawn = nativeTmp;
    const cleanup = () => rmSync(tempForSpawn, { recursive: true, force: true });
    let child;
    try {
      child = realSpawn(bwrap, [...mountArgs, '--', wrapped.command, ...wrapped.argv],
        { ...options, env: { ...options.env, HOME: codexHome, TMPDIR: nativeTmp, CLAUDE_CODE_TMPDIR: nativeTmp } });
    } catch (error) { cleanup(); throw error; }
    const attachCleanup = (result, completedPromise = false) => {
      // Async spawners can resolve at registration with a live process handle
      // (managedSpawn returns { child, taskId }). Promise settlement is then
      // the start of the mount lifetime, rather than its end.
      const processHandle = result?.child ?? result;
      if (typeof processHandle?.onExit === 'function') processHandle.onExit(cleanup);
      else if (typeof processHandle?.once === 'function') {
        processHandle.once('close', cleanup);
        // A fast child may finish before async registration returns its handle.
        if (processHandle.exitCode != null || processHandle.signalCode != null) cleanup();
      } else if (completedPromise) cleanup(); // Promise represents the entire run.
      return result;
    };
    if (typeof child?.then === 'function') return child.then(
      result => attachCleanup(result, true), error => { cleanup(); throw error; });
    attachCleanup(child);
    return child;
  };
}
