/**
 * `papercusp snapshot <subcommand>` — publish frozen harness state to the
 * marketplace so others can browse / fork.
 *
 * Subcommands (current MVP):
 *   publish <harness-slug>            Bundle .harness/ + manifest, POST to
 *                                     marketplace as kind=snapshot.
 *
 * Storage: same flow as `papercusp publish` (plugins/harnesses), only the
 * tarball contents and manifest.kind differ. The marketplace API is
 * kind-agnostic on /publish.
 */
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');
const CREDENTIALS_PATH = join(PAPERCUSP_ROOT, 'credentials.json');
const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'https://api.papercuspai.com';

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function die(msg: string): never {
  console.error(red(msg));
  process.exit(1);
}

interface Registry {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function readRegistry(): Promise<Registry> {
  return (await readJson<Registry>(REGISTRY_PATH))
    ?? (await readJson<Registry>(LEGACY_REGISTRY_PATH))
    ?? { projects: [] };
}

function isValidSlug(s: string): boolean {
  return /^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/i.test(s)
    || /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
}

/** Best-effort: read iteration count and feature counts from .harness/. */
async function inspectHarnessState(harnessDir: string): Promise<{
  iteration: number;
  featureCounts: Record<string, number>;
  takenAt: string;
}> {
  let iteration = 0;
  const featureCounts: Record<string, number> = {};

  // Iteration: scan run.log tail for last `── iteration N ──`.
  const runLog = join(harnessDir, 'logs', 'run.log');
  if (existsSync(runLog)) {
    try {
      const stat = await fs.stat(runLog);
      const start = Math.max(0, stat.size - 16 * 1024);
      const fh = await fs.open(runLog, 'r');
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      await fh.close();
      const tail = buf.toString('utf8');
      const matches = [...tail.matchAll(/── iteration (\d+) ──/g)];
      if (matches.length) iteration = Number(matches[matches.length - 1][1]);
    } catch { /* best-effort */ }
  }

  // Feature counts: read features.json (legacy) or fall back to empty.
  const featuresJson = await readJson<{ features?: Array<{ status: string }> }>(
    join(harnessDir, 'features.json'),
  );
  if (featuresJson?.features) {
    for (const f of featuresJson.features) {
      featureCounts[f.status] = (featureCounts[f.status] ?? 0) + 1;
    }
  }

  return { iteration, featureCounts, takenAt: new Date().toISOString() };
}

function defaultSnapshotName(harnessSlug: string, iteration: number): string {
  // Bare default. User can override with --name @owner/<custom>.
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${harnessSlug}-snapshot-${date}-iter${iteration || 0}`;
}

function snapshotVersion(iteration: number): string {
  // Marketplace version validator accepts only [a-z0-9._-] — no '+'.
  // Use "<iter>.0.0-ts<unix>" so each publish is monotonic.
  return `${iteration || 0}.0.0-ts${Math.floor(Date.now() / 1000)}`;
}

export async function cmdSnapshot(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'publish': return cmdSnapshotPublish(rest);
    case 'fork':    return cmdSnapshotFork(rest);
    case 'help':
    case '--help':
    case undefined:
      return cmdSnapshotHelp();
    default:
      console.error(red(`unknown snapshot subcommand: ${sub}`));
      console.error('run `papercusp snapshot help` for usage');
      process.exit(2);
  }
}

function cmdSnapshotHelp(): void {
  console.log(`${cyan('papercusp snapshot')} — publish + fork frozen harness state from the marketplace

${cyan('publish <harness-slug>')} ${dim('[--name <slug>] [--note "<text>"] [--include-project]')}
                                 ${dim('Bundle the harness\'s .harness/ directory (features, decisions, audit history)')}
                                 ${dim('and push to the marketplace as kind=snapshot.')}

${cyan('fork <snapshot-slug>')} ${dim('[<new-harness-slug>] [--path <dir>]')}
                                 ${dim('Download a published snapshot and scaffold a new harness from it.')}
                                 ${dim('Registers the new harness in ~/.papercusp/registry.json.')}

${cyan('Options')}
  ${cyan('publish:')}
  --name <slug>      Override the published name (default: <harness>-snapshot-<date>-iter<N>).
                     Use @<owner>/<name> for scoped names (requires \`papercusp login\`).
  --note "<text>"    Description shown on the marketplace listing (default: auto from state).
  --include-project  Also include the project source tree (off by default — snapshots are
                     state-only by default; the source code lives in the parent harness or
                     git remote).

  ${cyan('fork:')}
  <new-harness-slug> Project slug to register. Default: <sourceHarness>-fork-<n> (auto-incremented).
  --path <dir>       Where to extract. Default: $HOME/<new-harness-slug>.

${cyan('Examples')}
  ${dim('# Publish current state of "sheets" harness')}
  papercusp snapshot publish sheets

  ${dim('# Fork an existing snapshot into ~/sheets-fork')}
  papercusp snapshot fork sheets-snapshot-20260429-iter1
`);
}

async function cmdSnapshotFork(args: string[]): Promise<void> {
  const positional: string[] = [];
  let path: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--path' && args[i + 1]) { path = args[i + 1]; i++; continue; }
    if (a.startsWith('--')) die(`snapshot fork: unknown flag "${a}"`);
    positional.push(a);
  }
  const snapshotSlug = positional[0];
  if (!snapshotSlug) die('snapshot fork: usage: papercusp snapshot fork <snapshot-slug> [<new-harness-slug>] [--path <dir>]');
  if (!isValidSlug(snapshotSlug)) die(`snapshot fork: invalid snapshot slug "${snapshotSlug}"`);
  const requestedHarnessSlug = positional[1] ?? null;

  // 1. Fetch the snapshot manifest from the marketplace.
  console.log(`fetching ${cyan(snapshotSlug)} from ${MARKETPLACE_URL}...`);
  const detailUrl = `${MARKETPLACE_URL}/catalog/${encodeURIComponent(snapshotSlug)}`;
  const r = await fetch(detailUrl);
  if (!r.ok) die(`snapshot fork: ${detailUrl} → HTTP ${r.status}`);
  const detail = await r.json() as {
    versions?: string[];
    latest?: { version: string; kind?: string; snapshot?: { sourceHarness?: string } };
  };
  if (!detail.latest) die(`snapshot fork: ${snapshotSlug} has no published versions`);
  const latest = detail.latest;
  if (latest.kind !== 'snapshot') {
    die(`snapshot fork: "${snapshotSlug}" is kind="${latest.kind ?? 'unknown'}", not "snapshot". Use \`papercusp install\` for plugins/harnesses.`);
  }
  const sourceHarness = latest.snapshot?.sourceHarness ?? snapshotSlug;
  const version = latest.version;

  // 2. Resolve target slug + path. Auto-increment if collision.
  const reg = await readRegistry();
  let newSlug = requestedHarnessSlug ?? `${sourceHarness}-fork`;
  if (!isValidSlug(newSlug)) die(`snapshot fork: derived/given new-harness-slug "${newSlug}" is not a valid slug`);
  if (!requestedHarnessSlug) {
    let n = 1;
    while (reg.projects.some((p) => p.slug === newSlug)) {
      n += 1;
      newSlug = `${sourceHarness}-fork-${n}`;
    }
  } else if (reg.projects.some((p) => p.slug === newSlug)) {
    die(`snapshot fork: harness "${newSlug}" already registered. Pick a different slug or remove the existing one with \`papercusp uninstall ${newSlug}\`.`);
  }

  const targetPath = path ?? join(homedir(), newSlug);
  if (existsSync(targetPath)) {
    die(`snapshot fork: target path ${targetPath} already exists. Pick a fresh dir with --path or remove the existing one.`);
  }

  console.log(`  source:  ${dim(sourceHarness)}`);
  console.log(`  new:     ${cyan(newSlug)}`);
  console.log(`  path:    ${dim(targetPath)}`);

  // 3. Download tarball.
  const safeName = snapshotSlug.replace(/[/@]/g, '_');
  const tarballUrl = `${MARKETPLACE_URL}/download/${encodeURIComponent(snapshotSlug)}/${encodeURIComponent(version)}`;
  const tarballPath = join('/tmp', `papercusp-fork-${safeName}-${Date.now()}.tar.gz`);
  console.log(`  downloading...`);
  const tarRes = await fetch(tarballUrl);
  if (!tarRes.ok) die(`snapshot fork: tarball ${tarballUrl} → HTTP ${tarRes.status}`);
  const arrayBuf = await tarRes.arrayBuffer();
  await fs.writeFile(tarballPath, Buffer.from(arrayBuf));
  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} ${stat.size} bytes`);

  // 4. Extract.
  await fs.mkdir(targetPath, { recursive: true });
  const tarExtract = spawnSync('tar', ['xzf', tarballPath, '-C', targetPath], { encoding: 'utf8' });
  await fs.unlink(tarballPath).catch(() => {});
  if (tarExtract.status !== 0) {
    // Cleanup the half-extracted dir to keep state consistent.
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    die(`snapshot fork: tar extract failed: ${tarExtract.stderr}`);
  }

  // 5. Register in ~/.papercusp/registry.json. Re-use sourceHarness's harness_kind
  //    if known; otherwise default to 'coding' (most common).
  const sourceProject = reg.projects.find((p) => p.slug === sourceHarness);
  const harnessKind = sourceProject?.harnessKind ?? 'coding';
  reg.projects.push({
    slug: newSlug,
    path: targetPath,
    harnessKind,
    addedAt: new Date().toISOString(),
  });
  await writeJson(REGISTRY_PATH, reg);
  await writeJson(LEGACY_REGISTRY_PATH, reg);

  console.log('');
  console.log(green(`✓ forked ${snapshotSlug}@${version} as ${newSlug}`));
  console.log(`  ${dim('open in operator: http://localhost:3055/harness (pick "' + newSlug + '")')}`);
  console.log(`  ${dim('run from cli:    papercusp run ' + newSlug)}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function readCredentials() {
  return (await readJson<Record<string, string | undefined>>(CREDENTIALS_PATH)) ?? {};
}

async function cmdSnapshotPublish(args: string[]): Promise<void> {
  const positional: string[] = [];
  let name: string | null = null;
  let note: string | null = null;
  let includeProject = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' && args[i + 1]) { name = args[i + 1]; i++; continue; }
    if (a === '--note' && args[i + 1]) { note = args[i + 1]; i++; continue; }
    if (a === '--include-project') { includeProject = true; continue; }
    if (a.startsWith('--')) {
      die(`snapshot publish: unknown flag "${a}"`);
    }
    positional.push(a);
  }

  const harnessSlug = positional[0];
  if (!harnessSlug) die('snapshot publish: usage: papercusp snapshot publish <harness-slug> [--name <slug>] [--note "..."]');

  const reg = await readRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) die(`snapshot publish: no registered harness "${harnessSlug}". Run \`papercusp list\` to see registered harnesses.`);

  const harnessDir = join(project.path, '.harness');
  if (!existsSync(harnessDir)) die(`snapshot publish: ${harnessDir} does not exist (is the harness initialized?)`);

  console.log(`inspecting ${cyan(harnessSlug)} at ${dim(project.path)}...`);
  const state = await inspectHarnessState(harnessDir);
  const totalFeatures = Object.values(state.featureCounts).reduce((a, b) => a + b, 0);
  console.log(`  iteration ${state.iteration}, ${totalFeatures} features (${Object.entries(state.featureCounts).map(([k, v]) => `${k}=${v}`).join(' ') || 'no features.json'})`);

  const finalName = name ?? defaultSnapshotName(harnessSlug, state.iteration);
  if (!isValidSlug(finalName)) die(`snapshot publish: derived/given name "${finalName}" is not a valid slug`);
  const version = snapshotVersion(state.iteration);

  const passed = state.featureCounts.passed ?? 0;
  const desc = note ?? `Snapshot of "${harnessSlug}" at iteration ${state.iteration}` +
    (totalFeatures > 0 ? ` (${passed}/${totalFeatures} features passed)` : '');

  const manifest = {
    name: finalName,
    version,
    kind: 'snapshot' as const,
    papercusp: '^0.1.0',
    description: desc,
    license: 'MIT',
    snapshot: {
      sourceHarness: harnessSlug,
      sourceProjectPath: project.path,
      iteration: state.iteration,
      takenAt: state.takenAt,
      featureCounts: state.featureCounts,
      includesProject: includeProject,
    },
  };

  console.log(`publishing ${cyan(`${finalName}@${version}`)} to ${MARKETPLACE_URL}`);

  // Pack tarball. Default = .harness/ only. With --include-project, the entire project root.
  const safeName = finalName.replace(/[/@]/g, '_');
  const tarballPath = join('/tmp', `papercusp-snapshot-${safeName}-${Date.now()}.tar.gz`);

  const tarSourceDir = includeProject ? project.path : project.path;
  const includeArgs = includeProject
    ? ['.']
    : ['.harness'];
  const tarArgs = [
    'czf',
    tarballPath,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.next',
    '--exclude=*.tar.gz',
    '-C', tarSourceDir,
    ...includeArgs,
  ];
  console.log(`  packing tarball (${includeProject ? 'project + .harness' : '.harness only'})...`);
  const tar = spawnSync('tar', tarArgs, { encoding: 'utf8' });
  if (tar.status !== 0) die(`snapshot publish: tar failed: ${tar.stderr}`);
  const stat = await fs.stat(tarballPath);
  console.log(`  ${green('✓')} packed (${stat.size} bytes)`);

  // Build a README that describes the snapshot.
  const readme = `# ${finalName}

${desc}

## Snapshot details

- **Source harness:** \`${harnessSlug}\`
- **Iteration:** ${state.iteration}
- **Taken at:** ${state.takenAt}
- **Feature counts:** ${Object.entries(state.featureCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none recorded)'}
- **Includes project source:** ${includeProject ? 'yes' : 'no — \`.harness/\` state only'}

## Forking this snapshot

\`\`\`bash
papercusp install ${finalName}
# Extracts to ~/.papercusp/marketplace-storage/${finalName.replace(/[/@]/g, '_')}/${version}/
# Copy .harness/ into a new project directory to fork the run.
\`\`\`
`;

  // Multipart upload.
  const tarballBuf = await fs.readFile(tarballPath);
  const tarballBlob = new Blob([new Uint8Array(tarballBuf)], { type: 'application/gzip' });
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('tarball', tarballBlob, `${safeName}-${version}.tar.gz`);
  form.append('readme', readme);

  const creds = await readCredentials();
  const headers: Record<string, string> = {};
  if (process.env.PAPERCUSP_SERVICE_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.PAPERCUSP_SERVICE_TOKEN}`;
  } else if (creds.sessionToken) {
    headers['authorization'] = `Bearer ${creds.sessionToken}`;
  } else if (creds.github_pat) {
    headers['authorization'] = `Bearer ${creds.github_pat}`;
  }

  console.log(`  uploading...`);
  const r = await fetch(
    `${MARKETPLACE_URL}/publish/${encodeURIComponent(finalName)}/${encodeURIComponent(version)}`,
    { method: 'POST', body: form, headers },
  );

  await fs.unlink(tarballPath).catch(() => {});

  if (!r.ok) {
    const text = await r.text();
    die(`snapshot publish: HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  const result = await r.json().catch(() => ({}));
  console.log('');
  console.log(green(`✓ snapshot published: ${finalName}@${version}`));
  console.log(`  ${dim('view at: ' + (MARKETPLACE_URL.replace('api.', '') || 'http://localhost:3060') + '/marketplace/' + finalName + '/')}`);
  console.log(`  ${dim('fork:   papercusp install ' + finalName)}`);
  if ((result as any).manifestUrl) {
    console.log(`  ${dim('manifest: ' + (result as any).manifestUrl)}`);
  }
}
