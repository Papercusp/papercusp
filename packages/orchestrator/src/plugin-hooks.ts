/**
 * Plugin lifecycle hook firing. Mirrors bash's fire_plugin_hook —
 * discovers Papercusp plugins reachable for the current project and
 * invokes the named hook on each via the `papercusp-fire-hook` CLI.
 *
 * Each plugin runs in its own child process — a misbehaving plugin can't
 * crash the orchestrator loop. Failures are logged + ignored.
 *
 * Search paths (priority — first hit wins per plugin name):
 *   1. <projectDir>/plugins/<name>/
 *   2. ~/.papercusp/harnesses/<*>/plugins/<name>/
 *   3. ~/.papercusp/global-plugins/<name>/
 *
 * Hook names: afterDone, beforeMissionStart, onProposalAccepted,
 * onFeaturePassed (and any others a plugin opts into).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { harnessSlug } from './state';

export interface FirePluginHookOptions {
  hookName: string;
  /** Extra flags passed verbatim to the fire-hook CLI after the standard ones. */
  extraFlags?: readonly string[];
  /** Project + state dirs (passed as --project-dir / --state-dir). */
  projectDir: string;
  stateDir: string;
  /** Where the plugin process's stdout/stderr is redirected to. */
  pluginsLogPath: string;
  /** Override the CLI binary. By default we look up papercusp-fire-hook on PATH. */
  fireHookCli?: string;
  /** Logger for orchestrator-level messages (one per plugin fire + summary). */
  log: (message: string) => void;
}

export interface FirePluginHookResult {
  fired: number;
  errored: number;
  skipped: number;
}

/** Find the fire-hook CLI. Returns null when not on PATH and not in workspace. */
export function findFireHookCli(harnessDir?: string): string | null {
  // 1. Try PATH lookup via `which` on POSIX or `where` on Windows.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const which = spawnSync(cmd, ['papercusp-fire-hook'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (which.status === 0) {
    const path = which.stdout?.toString().trim().split(/\r?\n/)[0];
    if (path) return path;
  }
  // 2. Workspace fallback (sibling to @papercusp/harness).
  if (harnessDir) {
    const fallback = join(harnessDir, '..', 'papercusp-plugin-loader', 'bin', 'fire-hook');
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

/** Read a plugin's name from papercusp.json. Returns null on missing/invalid. */
function readPluginName(pluginDir: string): string | null {
  const manifest = join(pluginDir, 'papercusp.json');
  if (!existsSync(manifest)) return null;
  try {
    const obj = JSON.parse(readFileSync(manifest, 'utf8'));
    if (obj && typeof obj === 'object' && typeof obj.name === 'string') {
      return obj.name;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Walk a directory, returning each immediate child dir's full path. */
function listDirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Build the search-path candidate list (most-specific first). */
export function pluginSearchPaths(projectDir: string, home?: string): string[][] {
  const homeDir = home ?? process.env.HOME ?? '';
  const layers: string[][] = [
    listDirs(join(projectDir, 'plugins')),
  ];
  // Layer 2: across all installed harnesses.
  const harnessesDir = join(homeDir, '.papercusp', 'harnesses');
  for (const h of listDirs(harnessesDir)) {
    layers.push(listDirs(join(h, 'plugins')));
  }
  // Layer 3: global plugins.
  layers.push(listDirs(join(homeDir, '.papercusp', 'global-plugins')));
  return layers;
}

/**
 * Fire the named hook on every reachable plugin. Returns counts; never
 * throws. A missing CLI logs a warning and returns zeros.
 */
export function firePluginHook(opts: FirePluginHookOptions): FirePluginHookResult {
  const cli = opts.fireHookCli ?? findFireHookCli();
  if (cli === null) {
    opts.log(`  plugins: papercusp-fire-hook CLI not found — skipping hook=${opts.hookName}`);
    return { fired: 0, errored: 0, skipped: 0 };
  }

  const projectSlug = harnessSlug(opts.projectDir) || 'unknown';
  const seen = new Set<string>();
  let fired = 0;
  let errored = 0;
  let skipped = 0;

  const fireOne = (pluginDir: string): void => {
    const name = readPluginName(pluginDir);
    if (!name) return;
    if (seen.has(name)) {
      skipped++;
      return;
    }
    seen.add(name);
    opts.log(`  plugin ${name}@${opts.hookName} from ${pluginDir}`);

    const args: string[] = [
      opts.hookName,
      pluginDir,
      `--project-slug=${projectSlug}`,
      `--project-dir=${opts.projectDir}`,
      `--state-dir=${opts.stateDir}`,
      ...(opts.extraFlags ?? []),
    ];
    // Append child output to plugins.log (matches bash's `>> plugins.log`).
    const result = spawnSync(cli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    // Append stdout + stderr.
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      if (result.stdout) fs.appendFileSync(opts.pluginsLogPath, result.stdout);
      if (result.stderr) fs.appendFileSync(opts.pluginsLogPath, result.stderr);
    } catch {
      // ignore — log was best-effort
    }
    if ((result.status ?? 1) === 0) {
      fired++;
    } else {
      opts.log(
        `  plugin ${name} ${opts.hookName} → rc=${result.status ?? 1} (see ${opts.pluginsLogPath})`,
      );
      errored++;
    }
  };

  for (const layer of pluginSearchPaths(opts.projectDir)) {
    for (const pluginDir of layer) {
      fireOne(pluginDir);
    }
  }

  if (fired > 0 || errored > 0) {
    opts.log(`  plugins: ${opts.hookName} → fired=${fired} errored=${errored}`);
  }
  return { fired, errored, skipped };
}
