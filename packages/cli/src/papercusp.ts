#!/usr/bin/env node
/**
 * `papercusp` CLI — single-binary entrypoint.
 *
 * Subcommands:
 *   init <slug> [--from <harness>]   Scaffold a new project directory.
 *   install <slug>[@version]          Fetch a published harness from the marketplace.
 *   list                              Show installed harnesses.
 *   publish                           Pack current dir + upload to the marketplace.
 *   run [project-slug]                Delegate to the harness substrate's run.sh.
 *   scaffold-schema <slug>            Provision the per-harness Postgres schema.
 *   doctor                            Check prerequisites (Postgres, claude, env).
 *   help                              Show this help.
 *
 * Storage layout:
 *   ~/.papercusp/
 *     credentials.json                 API keys (Anthropic, OpenAI, GitHub PAT)
 *     profile.json                     Display name, default project dir, model prefs
 *     registry.json                    Installed harnesses (also used by the legacy
 *                                      ~/.restart-harness-projects.json — kept in sync)
 *     harnesses/<slug>/                Templates downloaded from the marketplace
 *     projects/<slug>/                 Active project state (.harness/* lives here)
 *     marketplace-storage/             Local marketplace tarball storage (dev)
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const PROJECTS_DIR = join(PAPERCUSP_ROOT, 'projects');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');
const CREDENTIALS_PATH = join(PAPERCUSP_ROOT, 'credentials.json');

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

function colorize(s: string, code: string): string {
  if (process.stdout.isTTY === false) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => colorize(s, '2');
const red = (s: string) => colorize(s, '31');
const green = (s: string) => colorize(s, '32');
const cyan = (s: string) => colorize(s, '36');
const bold = (s: string) => colorize(s, '1');

function die(msg: string, exit = 1): never {
  console.error(red(`error: ${msg}`));
  process.exit(exit);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(PAPERCUSP_ROOT, { recursive: true, mode: 0o700 });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
}

interface Registry {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

async function readRegistry(): Promise<Registry> {
  const r = await readJson<Registry>(REGISTRY_PATH);
  if (r) return r;
  // Legacy fallback.
  const legacy = await readJson<Registry>(LEGACY_REGISTRY_PATH);
  return legacy ?? { projects: [] };
}

async function writeRegistry(reg: Registry): Promise<void> {
  await writeJson(REGISTRY_PATH, reg);
  // Mirror to legacy path so older code that reads ~/.restart-harness-projects.json
  // keeps working during the transition.
  await writeJson(LEGACY_REGISTRY_PATH, reg);
}

async function readCredentials(): Promise<Record<string, string | undefined>> {
  return (await readJson<Record<string, string | undefined>>(CREDENTIALS_PATH)) ?? {};
}

function isValidSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);
}

// ─── Subcommands ──────────────────────────────────────────────────────────

async function cmdHelp(): Promise<void> {
  console.log(`${bold('papercusp')} — autonomous-harness framework CLI

${bold('Usage:')}
  papercusp <command> [args]

${bold('Commands:')}
  ${cyan('init <slug>')} [--from <harness>]    Scaffold a new project directory at ~/.papercusp/projects/<slug>/.
                                       --from defaults to a blank template; use a marketplace slug to
                                       seed from a published harness.

  ${cyan('install <slug>[@version]')}          Fetch a published harness from the marketplace into
                                       ~/.papercusp/harnesses/<slug>/. Latest version if not specified.

  ${cyan('uninstall <slug>')}                  Remove an installed harness template (does not affect projects
                                       you initialised from it).

  ${cyan('list')}                              Show registered projects + installed harness templates.

  ${cyan('publish')}                           Pack the current directory's harness template + manifest and
                                       upload to the marketplace. Requires a papercusp.json in cwd.

  ${cyan('run')} [project-slug]                Run the harness loop. If no slug, uses cwd's harness state.

  ${cyan('scaffold-schema <slug>')}            Provision the per-harness Postgres schema for an existing project.

  ${cyan('doctor')}                            Check prerequisites (Postgres, claude CLI, marketplace reachable).

  ${cyan('help')}                              Show this help.

${bold('Environment:')}
  PAPERCUSP_MARKETPLACE_URL    Catalog server (default: http://localhost:3057)
  PAPERCUSP_HARNESS_DIR        Substrate dir (default: ~/autonomous-harness, symlinked to packages/papercusp-harness)
  PAPERCUSP_PROJECTS_ROOT      Where 'init' creates new projects (default: ~/.papercusp/projects)

${dim('See also: ' + REGISTRY_PATH)}`);
}

async function cmdDoctor(): Promise<void> {
  console.log(bold('papercusp doctor\n'));
  let ok = true;

  // Node version
  const node = process.versions.node;
  console.log(`  ${green('✓')} node ${node}`);

  // Postgres reachability via psql -c 'SELECT 1'
  const pgUser = process.env.PGUSER ?? 'harness_app';
  const pgHost = process.env.PGHOST ?? 'localhost';
  const pgDb = process.env.HARNESS_PG_DB ?? 'restart_harness';
  const pgPwd = process.env.PGPASSWORD ?? 'harness_app_pwd';
  const psql = spawnSync('psql', ['-U', pgUser, '-h', pgHost, '-d', pgDb, '-tAc', 'SELECT 1'], {
    env: { ...process.env, PGPASSWORD: pgPwd },
    encoding: 'utf8',
    timeout: 3000,
  });
  if (psql.status === 0 && psql.stdout.trim() === '1') {
    console.log(`  ${green('✓')} postgres @ ${pgUser}@${pgHost}/${pgDb}`);
  } else {
    console.log(`  ${red('✗')} postgres unreachable @ ${pgUser}@${pgHost}/${pgDb}`);
    console.log(`    ${dim('try: bin/papercusp-init-db.sh')}`);
    ok = false;
  }

  // claude CLI
  const claudePath = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (claudePath.status === 0 && claudePath.stdout.trim()) {
    console.log(`  ${green('✓')} claude CLI @ ${claudePath.stdout.trim()}`);
  } else {
    console.log(`  ${red('✗')} claude CLI not on PATH`);
    console.log(`    ${dim('install from https://docs.claude.com/en/docs/claude-code/setup')}`);
    ok = false;
  }

  // Credentials
  const creds = await readCredentials();
  if (creds.anthropic_api_key) {
    console.log(`  ${green('✓')} Anthropic API key set`);
  } else {
    console.log(`  ${red('✗')} Anthropic API key missing in ${CREDENTIALS_PATH}`);
    console.log(`    ${dim('open http://localhost:3055/settings/api-keys')}`);
    ok = false;
  }

  // Marketplace reachability
  try {
    const r = await fetch(`${MARKETPLACE_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      console.log(`  ${green('✓')} marketplace @ ${MARKETPLACE_URL}`);
    } else {
      console.log(`  ${red('✗')} marketplace returned HTTP ${r.status}`);
      ok = false;
    }
  } catch {
    console.log(`  ${dim('—')} marketplace @ ${MARKETPLACE_URL} unreachable (optional in offline mode)`);
  }

  // Substrate
  const substrate = process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness');
  if (existsSync(join(substrate, 'run.sh'))) {
    console.log(`  ${green('✓')} substrate @ ${substrate}`);
  } else {
    console.log(`  ${red('✗')} substrate missing run.sh @ ${substrate}`);
    ok = false;
  }

  console.log('');
  console.log(ok ? green('all good — ready to run a harness') : red('fix the above before continuing'));
  process.exit(ok ? 0 : 1);
}

async function cmdList(): Promise<void> {
  await ensureRoot();
  const reg = await readRegistry();
  const harnesses: string[] = [];
  try {
    const entries = await fs.readdir(HARNESSES_DIR, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) harnesses.push(e.name);
  } catch {}

  console.log(bold('Registered projects:'));
  if (reg.projects.length === 0) {
    console.log(`  ${dim('(none — use `papercusp init <slug>`)')}`);
  } else {
    for (const p of reg.projects) {
      console.log(`  ${cyan(p.slug.padEnd(24))} ${dim(p.path)}`);
    }
  }
  console.log('');
  console.log(bold('Installed harnesses:'));
  if (harnesses.length === 0) {
    console.log(`  ${dim('(none — use `papercusp install <slug>`)')}`);
  } else {
    for (const h of harnesses) {
      console.log(`  ${cyan(h)}`);
    }
  }
}

async function fetchToFile(url: string, destPath: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  if (!r.body) throw new Error(`empty response body: ${url}`);
  await fs.mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destPath));
}

async function cmdInstall(arg: string | undefined): Promise<void> {
  if (!arg) die('install: usage: papercusp install <slug>[@version]');
  const [slug, version] = arg.split('@');
  if (!isValidSlug(slug)) die(`install: invalid slug "${slug}"`);

  await ensureRoot();
  console.log(`fetching ${cyan(slug + (version ? `@${version}` : ' (latest)'))} from ${MARKETPLACE_URL}`);

  // Resolve version if not specified.
  let resolvedVersion = version;
  if (!resolvedVersion) {
    const r = await fetch(`${MARKETPLACE_URL}/catalog/${slug}`);
    if (!r.ok) die(`install: ${slug} not found in marketplace (HTTP ${r.status})`);
    const d = await r.json() as { versions: string[] };
    if (!d.versions?.length) die(`install: ${slug} has no published versions`);
    resolvedVersion = d.versions[0];
    console.log(`  resolved latest = ${resolvedVersion}`);
  }

  const installDir = join(HARNESSES_DIR, slug);
  if (existsSync(installDir)) {
    console.log(`  ${dim('cleaning previous install at')} ${installDir}`);
    await fs.rm(installDir, { recursive: true, force: true });
  }
  await fs.mkdir(installDir, { recursive: true });

  // Download tarball.
  const tarballPath = join(installDir, `${slug}-${resolvedVersion}.tar.gz`);
  console.log(`  downloading tarball...`);
  await fetchToFile(`${MARKETPLACE_URL}/download/${slug}/${resolvedVersion}`, tarballPath);
  console.log(`  ${green('✓')} ${dim(tarballPath)}`);

  // Extract.
  console.log(`  extracting...`);
  const extract = spawnSync('tar', ['xzf', tarballPath, '-C', installDir], { encoding: 'utf8' });
  if (extract.status !== 0) die(`install: tar failed: ${extract.stderr}`);
  console.log(`  ${green('✓')} extracted to ${dim(installDir)}`);

  // Validate manifest.
  const manifestPath = join(installDir, 'papercusp.json');
  const manifest = await readJson<any>(manifestPath);
  if (!manifest) die(`install: tarball missing papercusp.json`);
  if (manifest.name !== slug) die(`install: manifest name "${manifest.name}" doesn't match install slug "${slug}"`);

  // If the manifest declared a `schema` array, run those DDL files against
  // Postgres so the per-plugin tables are ready before the user runs init.
  if (Array.isArray(manifest.schema) && manifest.schema.length > 0) {
    console.log(`  applying ${manifest.schema.length} schema DDL file(s)...`);
    const pgUser = process.env.PGUSER ?? 'postgres_app';
    const pgPwd = process.env.PGPASSWORD ?? 'postgres';
    const pgDb = process.env.HARNESS_PG_DB ?? 'restart_harness';
    const pgHost = process.env.PGHOST ?? 'localhost';
    let applied = 0;
    for (const rel of manifest.schema as string[]) {
      const ddlPath = join(installDir, rel);
      if (!existsSync(ddlPath)) {
        console.log(`  ${dim(`skip (missing): ${rel}`)}`);
        continue;
      }
      const psql = spawnSync('psql', [
        '-v', 'ON_ERROR_STOP=1', '-q',
        '-U', pgUser, '-h', pgHost, '-d', pgDb, '-f', ddlPath,
      ], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pgPwd }, timeout: 30_000 });
      if (psql.status === 0) {
        console.log(`  ${green('✓')} applied ${dim(rel)}`);
        applied++;
      } else {
        console.log(`  ${red('✗')} ${rel}: ${psql.stderr.trim().slice(0, 200)}`);
      }
    }
    if (applied === 0) {
      console.log(`  ${dim('(no schemas applied — Postgres unreachable or DDLs missing)')}`);
    }
  }

  console.log('');
  console.log(green(`installed ${slug}@${resolvedVersion}`));
  console.log(`next: ${cyan(`papercusp init my-project --from ${slug}`)}`);
}

async function copyDir(src: string, dst: string): Promise<void> {
  // node 22 has fs.cp; use it.
  await fs.cp(src, dst, { recursive: true });
}

async function cmdUninstall(slug: string | undefined): Promise<void> {
  if (!slug) die('uninstall: usage: papercusp uninstall <slug>');
  if (!isValidSlug(slug)) die(`uninstall: invalid slug "${slug}"`);
  const dir = join(HARNESSES_DIR, slug);
  if (!existsSync(dir)) {
    console.log(`${dim(`${slug} is not installed (${dir} does not exist)`)}`);
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
  console.log(green(`✓ removed ${dir}`));
  console.log(`${dim('(projects you initialised from this template are untouched)')}`);
}

async function cmdInit(args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) die('init: usage: papercusp init <slug> [--from <harness>]');
  if (!isValidSlug(slug)) die(`init: invalid slug "${slug}"`);
  const fromIdx = args.indexOf('--from');
  const fromHarness = fromIdx >= 0 ? args[fromIdx + 1] : null;

  await ensureRoot();
  const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? PROJECTS_DIR;
  const projectPath = join(projectsRoot, slug);
  if (existsSync(projectPath)) die(`init: ${projectPath} already exists`);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(join(projectPath, '.harness'), { recursive: true });

  if (fromHarness) {
    const templateDir = join(HARNESSES_DIR, fromHarness);
    if (!existsSync(templateDir)) {
      die(`init: harness "${fromHarness}" not installed (try \`papercusp install ${fromHarness}\` first)`);
    }
    console.log(`seeding from ${cyan(fromHarness)} → ${dim(projectPath)}`);
    // Copy everything except the tarball + manifest itself.
    const entries = await fs.readdir(templateDir);
    for (const e of entries) {
      if (e.endsWith('.tar.gz')) continue;
      if (e === 'papercusp.json') continue; // manifest stays in harnesses/, not the project
      await copyDir(join(templateDir, e), join(projectPath, e));
    }
  } else {
    // Blank template.
    console.log(`creating blank project at ${dim(projectPath)}`);
    await fs.writeFile(join(projectPath, 'SPEC.md'), `# ${slug}\n\n## Goals\n\n(write what this project should accomplish)\n`, 'utf8');
    await fs.writeFile(
      join(projectPath, 'AGENTS.md'),
      `# Conventions for ${slug}\n\n(write coding conventions, libraries to prefer, etc.)\n`,
      'utf8',
    );
    await fs.writeFile(
      join(projectPath, '.harness', 'config.json'),
      JSON.stringify(
        {
          phase: 'staging',
          models: { scoper: 'claude-opus-4-7', worker: 'claude-sonnet-4-6', validator: 'claude-opus-4-7', orchestrator: 'claude-haiku-4-5', reviewer: 'claude-opus-4-7' },
          timeouts: { worker: 900, validator: 600, scoper: 300, reviewer: 300, orchestrator: 120 },
          maxCostUsd: 10,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  // Register.
  const reg = await readRegistry();
  if (!reg.projects.find((p) => p.slug === slug)) {
    reg.projects.push({ slug, path: projectPath, addedAt: new Date().toISOString() });
    await writeRegistry(reg);
  }

  console.log('');
  console.log(green(`✓ ${slug} initialized`));
  console.log(`next steps:`);
  console.log(`  edit ${cyan(projectPath + '/SPEC.md')}`);
  console.log(`  ${cyan(`papercusp scaffold-schema ${slug}`)}    (provision Postgres schema)`);
  console.log(`  ${cyan(`papercusp run ${slug}`)}                (start the harness)`);
}

async function cmdPublish(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const manifestPath = join(cwd, 'papercusp.json');
  if (!existsSync(manifestPath)) die(`publish: no papercusp.json in ${cwd}`);
  const manifest = await readJson<any>(manifestPath);
  if (!manifest?.name || !manifest?.version) die('publish: manifest must have name + version');
  if (!isValidSlug(manifest.name)) die(`publish: invalid manifest.name "${manifest.name}"`);

  const acknowledgeSecrets = args.includes('--acknowledge-secrets');

  console.log(`publishing ${cyan(`${manifest.name}@${manifest.version}`)} to ${MARKETPLACE_URL}`);

  // ── Secret scrub ────────────────────────────────────────────────────
  // Scan the source tree BEFORE packing. Hard-reject paths fail
  // unconditionally; soft findings fail unless --acknowledge-secrets,
  // in which case they're replaced with ${PLACEHOLDER} substitutions
  // (only in the packed tarball — your working tree is untouched).
  console.log(`  scanning for secrets...`);
  const { scanFilesForSecrets, replaceSecretsWithPlaceholders, formatFindings } =
    await import('./secret-scrubber.ts');

  // Walk the tree (mirror the tar exclusions).
  async function walk(dir: string, base = ''): Promise<{ path: string; abs: string }[]> {
    const out: { path: string; abs: string }[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? join(base, e.name) : e.name;
      if (
        e.name === 'node_modules' ||
        e.name === '.git' ||
        e.name === '.next' ||
        e.name === '.papercusp' ||
        rel.endsWith('.tar.gz')
      ) continue;
      if (e.isDirectory()) {
        out.push(...(await walk(join(dir, e.name), rel)));
      } else if (e.isFile()) {
        out.push({ path: rel, abs: join(dir, e.name) });
      }
    }
    return out;
  }

  const allFiles = await walk(cwd);
  const filesForScan = await Promise.all(
    allFiles.map(async (f) => {
      // Skip files >1MB to keep scanning fast (mostly catches binary/embedded data).
      const st = await fs.stat(f.abs);
      if (st.size > 1_048_576) return { path: f.path, contents: null };
      try {
        const content = await fs.readFile(f.abs, 'utf8');
        return { path: f.path, contents: content };
      } catch {
        return { path: f.path, contents: null };  // binary
      }
    })
  );

  const scanResult = scanFilesForSecrets(filesForScan);
  if (scanResult.hardReject.length > 0) {
    console.error(red(formatFindings(scanResult)));
    die(`publish: ${scanResult.hardReject.length} hard-reject path(s) detected. Fix the source tree and retry.`);
  }
  if (scanResult.findings.length > 0) {
    if (!acknowledgeSecrets) {
      console.error(red(formatFindings(scanResult)));
      die(`publish: ${scanResult.findings.length} secret(s) detected. Either remove them or pass --acknowledge-secrets to substitute placeholders.`);
    }
    console.log(`  ${dim(`${scanResult.findings.length} secret(s) detected; replacing with placeholders…`)}`);
  } else {
    console.log(`  ${green('✓')} no secrets found`);
  }

  // Pack a tarball of cwd (excluding bloat). Write the tarball to /tmp so
  // it doesn't end up self-including, which tar would race on.
  const tarballPath = join('/tmp', `papercusp-publish-${manifest.name}-${manifest.version}-${Date.now()}.tar.gz`);

  // If we have findings to scrub, stage the cwd into a temp dir with
  // placeholder substitutions, then tar that. Otherwise tar the cwd directly.
  let stagingDir: string | null = null;
  if (scanResult.findings.length > 0 && acknowledgeSecrets) {
    stagingDir = await fs.mkdtemp(join('/tmp', `papercusp-stage-${manifest.name}-`));
    const replaced = replaceSecretsWithPlaceholders(filesForScan, scanResult.findings);
    for (const f of allFiles) {
      const dest = join(stagingDir, f.path);
      await fs.mkdir(dirname(dest), { recursive: true });
      const newContent = replaced.get(f.path);
      if (newContent !== undefined) {
        await fs.writeFile(dest, newContent, 'utf8');
      } else {
        // Copy file as-is
        await fs.copyFile(f.abs, dest);
      }
    }
  }

  const tarSourceDir = stagingDir ?? cwd;
  const tarArgs = [
    'czf',
    tarballPath,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.next',
    '--exclude=.papercusp',
    '--exclude=*.tar.gz',
    '-C',
    tarSourceDir,
    '.',
  ];
  console.log(`  packing tarball...`);
  const tar = spawnSync('tar', tarArgs, { encoding: 'utf8' });
  if (tar.status !== 0) die(`publish: tar failed: ${tar.stderr}`);

  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} packed (${stat.size} bytes)`);

  // Cleanup staging dir if we used one (on success path; failure path falls through to die() which exits process)
  const cleanupStaging = async () => {
    if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  };

  // Build multipart form.
  const tarballBuf = await fs.readFile(tarballPath);
  const tarballBlob = new Blob([new Uint8Array(tarballBuf)], { type: 'application/gzip' });
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('tarball', tarballBlob, `${manifest.name}-${manifest.version}.tar.gz`);
  // Optional README.md
  if (existsSync(join(cwd, 'README.md'))) {
    form.append('readme', await fs.readFile(join(cwd, 'README.md'), 'utf8'));
  }

  // Auth header (if configured).
  const creds = await readCredentials();
  const headers: Record<string, string> = {};
  if (creds.github_pat) {
    headers['authorization'] = `Bearer ${creds.github_pat}`;
  }

  console.log(`  uploading...`);
  const r = await fetch(`${MARKETPLACE_URL}/publish/${manifest.name}/${manifest.version}`, {
    method: 'POST',
    body: form,
    headers,
  });

  // Cleanup tarball + staging dir regardless.
  await fs.unlink(tarballPath).catch(() => {});
  await cleanupStaging();

  if (!r.ok) {
    const text = await r.text();
    die(`publish: HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const result = await r.json();
  console.log('');
  console.log(green(`✓ published ${manifest.name}@${manifest.version}`));
  console.log(`  ${dim(JSON.stringify(result))}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const slug = args[0];
  let projectPath = process.cwd();

  if (slug) {
    const reg = await readRegistry();
    const found = reg.projects.find((p) => p.slug === slug);
    if (!found) die(`run: project "${slug}" not registered (try \`papercusp list\`)`);
    projectPath = found.path;
  }

  if (!existsSync(join(projectPath, '.harness'))) {
    die(`run: ${projectPath} is not a harness project (no .harness/ dir)`);
  }

  const substrate = process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness');
  const runScript = join(substrate, 'run.sh');
  if (!existsSync(runScript)) die(`run: substrate run.sh missing at ${runScript}`);

  // Inject API key from credentials.json into the env.
  const creds = await readCredentials();
  const env = { ...process.env };
  if (creds.anthropic_api_key && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = creds.anthropic_api_key;
  }
  if (creds.openai_api_key && !env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = creds.openai_api_key;
  }

  console.log(green(`running harness in ${projectPath}`));
  const child = spawn('bash', [runScript], {
    cwd: projectPath,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdScaffoldSchema(slug: string | undefined): Promise<void> {
  if (!slug) die('scaffold-schema: usage: papercusp scaffold-schema <slug>');
  if (!isValidSlug(slug)) die(`scaffold-schema: invalid slug "${slug}"`);

  // Locate the framework's scaffold script.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Walk up to find Restart/bin/scaffold-harness-schema.sh
  let candidate = __dirname;
  let scaffoldScript: string | null = null;
  for (let i = 0; i < 6; i++) {
    const probe = join(candidate, 'bin', 'scaffold-harness-schema.sh');
    if (existsSync(probe)) {
      scaffoldScript = probe;
      break;
    }
    candidate = dirname(candidate);
  }
  if (!scaffoldScript) die('scaffold-schema: could not locate bin/scaffold-harness-schema.sh');

  console.log(`scaffolding Postgres schema for ${cyan(slug)}`);
  const child = spawn('bash', [scaffoldScript, slug], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const args = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    case 'init':
      return cmdInit(args);
    case 'install':
      return cmdInstall(args[0]);
    case 'uninstall':
      return cmdUninstall(args[0]);
    case 'list':
      return cmdList();
    case 'publish':
      return cmdPublish(args);
    case 'run':
      return cmdRun(args);
    case 'scaffold-schema':
      return cmdScaffoldSchema(args[0]);
    case 'doctor':
      return cmdDoctor();
    default:
      console.error(red(`unknown command: ${cmd}`));
      console.error(`run \`papercusp help\` for usage`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(red(`fatal: ${e?.message ?? e}`));
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
