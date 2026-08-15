/**
 * `papercusp project-history generate` — build a portable Project History v1
 * artifact from Papercusp plan/work-item ledgers plus the project's Git repo.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  generateProjectHistory,
  type ProjectHistoryCommitInput,
  type ProjectHistoryDocument,
  type ProjectHistoryPlanInput,
  type ProjectHistoryProject,
  type ProjectHistoryProvider,
  type ProjectHistoryRepository,
  type ProjectHistoryWorkItemInput,
} from '@papercusp/plan-parser/project-history';

type OutputFormat = 'json' | 'typescript';

export interface ProjectHistoryGenerateOptions {
  workspace: string;
  harness: string;
  planPrefix: string | null;
  projectId: string;
  projectName: string;
  repoRoot: string;
  output: string;
  format: OutputFormat;
  exportName: string;
  generatedAt: string;
  check: boolean;
  repositoryUrl: string | null;
  repositoryWebUrl: string | null;
  defaultBranch: string | null;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CommandRunner {
  run(command: string, args: readonly string[], options: { cwd: string; input?: string }): CommandResult;
}

const defaultRunner: CommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      input: options.input,
      maxBuffer: 128 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  },
};

function takeOption(args: string[], index: number, name: string): { value: string; consumed: number } | null {
  const argument = args[index];
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return { value, consumed: 2 };
  }
  if (argument?.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseProjectHistoryGenerateArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ProjectHistoryGenerateOptions {
  const args = [...argv];
  const values = new Map<string, string>();
  let check = false;
  for (let index = 0; index < args.length;) {
    if (args[index] === '--check') {
      check = true;
      index += 1;
      continue;
    }
    const names = [
      '--workspace', '--harness', '--prefix', '--project-id', '--project-name',
      '--repo', '--output', '--format', '--export-name', '--generated-at',
      '--repository-url', '--repository-web-url', '--default-branch',
    ];
    const name = names.find((candidate) => args[index] === candidate || args[index]?.startsWith(`${candidate}=`));
    if (!name) throw new Error(`project-history generate: unknown argument ${args[index]}`);
    const parsed = takeOption(args, index, name);
    if (!parsed) throw new Error(`project-history generate: invalid argument ${args[index]}`);
    values.set(name, parsed.value);
    index += parsed.consumed;
  }

  const harness = values.get('--harness');
  if (!harness) throw new Error('project-history generate requires --harness <slug>');
  const repoRoot = resolve(cwd, values.get('--repo') ?? '.');
  const output = resolve(cwd, values.get('--output') ?? '.papercusp/project-history.v1.json');
  const rawFormat = values.get('--format') ?? (output.endsWith('.ts') ? 'typescript' : 'json');
  if (rawFormat !== 'json' && rawFormat !== 'typescript' && rawFormat !== 'ts') {
    throw new Error('--format must be json or typescript');
  }
  const exportName = values.get('--export-name') ?? 'PROJECT_HISTORY';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new Error('--export-name must be a valid JavaScript identifier');
  }
  const generatedAt = values.get('--generated-at') ?? now.toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('--generated-at must be an ISO-compatible timestamp');

  return {
    workspace: values.get('--workspace') ?? env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace',
    harness,
    planPrefix: values.has('--prefix') ? values.get('--prefix') || null : `${harness}-`,
    projectId: values.get('--project-id') ?? harness,
    projectName: values.get('--project-name') ?? harness,
    repoRoot,
    output,
    format: rawFormat === 'ts' ? 'typescript' : rawFormat,
    exportName,
    generatedAt,
    check,
    repositoryUrl: values.get('--repository-url') ?? null,
    repositoryWebUrl: values.get('--repository-web-url') ?? null,
    defaultBranch: values.get('--default-branch') ?? null,
  };
}

function checked(result: CommandResult, description: string): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || 'unknown failure';
    throw new Error(`${description} failed (${result.status ?? 'signal'}): ${detail}`);
  }
  return result.stdout;
}

function ptool(
  runner: CommandRunner,
  options: ProjectHistoryGenerateOptions,
  tool: string,
  args: Record<string, unknown>,
): unknown {
  const stdout = checked(runner.run('ptool', [
    tool,
    '--json',
    '-',
    `--workspace=${options.workspace}`,
    `--harness=${options.harness}`,
  ], {
    cwd: options.repoRoot,
    input: `${JSON.stringify(args)}\n`,
  }), tool);
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`${tool} returned invalid JSON`, { cause });
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function planRows(payload: unknown): Record<string, unknown>[] {
  const root = object(payload);
  if (Array.isArray(root?.plans)) return records(root.plans);
  const first = records(root?.results)[0];
  return records(first?.plans);
}

function workItemRows(payload: unknown): Record<string, unknown>[] {
  return records(object(payload)?.results)
    .map((row) => object(row.workItem))
    .filter((row): row is Record<string, unknown> => row !== null);
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function git(runner: CommandRunner, repoRoot: string, args: readonly string[], allowFailure = false): string {
  const result = runner.run('git', args, { cwd: repoRoot });
  if (allowFailure && result.status !== 0) return '';
  return checked(result, `git ${args.join(' ')}`);
}

export function githubWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const scp = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = /^ssh:\/\/(?:git@)?github\.com\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://github.com/${ssh[1]}`;
  const http = /^https?:\/\/github\.com\/(.+)$/i.exec(trimmed);
  if (http) return `https://github.com/${http[1]}`;
  return null;
}

export function repositoryFromRemote(
  remoteUrl: string | null,
  webUrl: string | null,
  defaultBranch: string | null,
): ProjectHistoryRepository | null {
  const url = remoteUrl ?? webUrl;
  if (!url) return null;
  const normalizedWebUrl = webUrl ?? githubWebUrl(url);
  return {
    provider: normalizedWebUrl?.startsWith('https://github.com/') ? 'github' : 'git',
    url,
    webUrl: normalizedWebUrl,
    defaultBranch,
  };
}

interface ParsedGitCommit {
  sha: string;
  subject: string | null;
  committedAt: string | null;
  body: string;
  files: string[];
}

export function parseGitLog(raw: string): ParsedGitCommit[] {
  const commits: ParsedGitCommit[] = [];
  for (const record of raw.split('\u001e')) {
    const fields = record.split('\0');
    const sha = fields[0]?.trim();
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || fields.length < 5) continue;
    commits.push({
      sha,
      subject: fields[1] || null,
      committedAt: fields[2] || null,
      body: fields[3] ?? '',
      files: [...new Set(fields.slice(4).join('\0').split(/\r?\n/).map((file) => file.trim()).filter(Boolean))].sort(),
    });
  }
  return commits;
}

export function commitsForWorkItems(
  commits: readonly ParsedGitCommit[],
  ids: readonly string[],
  remotelyKnownShas: ReadonlySet<string> | null,
): ProjectHistoryCommitInput[] {
  const requested = new Set(ids);
  const output: ProjectHistoryCommitInput[] = [];
  for (const commit of commits) {
    const authoritative = new Set(
      [...commit.body.matchAll(/^Papercusp-Work-Item:\s*((?:WI|EI|F)-\d+)\s*$/gim)]
        .map((match) => match[1])
        .filter((id): id is string => Boolean(id && requested.has(id))),
    );
    const referenced = new Set(
      [...commit.body.matchAll(/\b(?:WI|EI|F)-\d+\b/g)]
        .map((match) => match[0])
        .filter((id) => requested.has(id)),
    );
    const links: ProjectHistoryCommitInput['links'] = [
      ...[...authoritative].map((workItemId) => ({ workItemId, attribution: 'authoritative' as const })),
      ...[...referenced]
        .filter((workItemId) => !authoritative.has(workItemId))
        .map((workItemId) => ({ workItemId, attribution: 'body-reference' as const })),
    ];
    if (links.length === 0) continue;
    output.push({
      sha: commit.sha,
      subject: commit.subject,
      committedAt: commit.committedAt,
      files: commit.files,
      remoteStatus: remotelyKnownShas === null
        ? 'unknown'
        : remotelyKnownShas.has(commit.sha) ? 'confirmed' : 'local-only',
      links,
    });
  }
  return output;
}

export function renderProjectHistory(
  document: ProjectHistoryDocument,
  format: OutputFormat,
  exportName: string,
): string {
  const json = JSON.stringify(document, null, 2);
  if (format === 'json') return `${json}\n`;
  return [
    '/* Generated by `papercusp project-history generate`. Do not edit by hand. */',
    `export const ${exportName} = ${json} as const;`,
    '',
  ].join('\n');
}

class PtoolGitProjectHistoryProvider implements ProjectHistoryProvider {
  constructor(
    private readonly options: ProjectHistoryGenerateOptions,
    private readonly runner: CommandRunner,
  ) {}

  async loadPlans(): Promise<readonly ProjectHistoryPlanInput[]> {
    const listed = planRows(ptool(this.runner, this.options, 'plans:list', {
      harness: this.options.harness,
      compact: true,
      limit: 500,
      order: 'updated',
    })).filter((plan) => {
      const slug = string(plan.slug);
      return slug && (!this.options.planPrefix || slug.startsWith(this.options.planPrefix));
    }).sort((left, right) => {
      const byUpdated = (string(right.updated) ?? '').localeCompare(string(left.updated) ?? '');
      return byUpdated || (string(left.slug) ?? '').localeCompare(string(right.slug) ?? '');
    });

    const exportDirectory = await fs.mkdtemp(join(tmpdir(), 'papercusp-project-history-'));
    try {
      ptool(this.runner, this.options, 'plans:export', {
        harness: this.options.harness,
        toDir: exportDirectory,
      });
      return await Promise.all(listed.map(async (plan) => {
        const slug = string(plan.slug)!;
        return {
          markdown: await fs.readFile(join(exportDirectory, `${slug}.md`), 'utf8'),
          filePath: `${slug}.md`,
          updatedAt: string(plan.updated),
        } satisfies ProjectHistoryPlanInput;
      }));
    } finally {
      await fs.rm(exportDirectory, { recursive: true, force: true });
    }
  }

  async loadWorkItems(ids: readonly string[]): Promise<readonly ProjectHistoryWorkItemInput[]> {
    const items: ProjectHistoryWorkItemInput[] = [];
    for (const batch of chunks(ids, 100)) {
      const payload = ptool(this.runner, this.options, 'tools:invoke', {
        name: 'work_items:get',
        args: {
          ids: batch,
          harness: this.options.harness,
          detail: false,
          threadLimit: 1,
          payloadTier: 'full',
        },
      });
      for (const row of workItemRows(payload)) {
        const id = string(row.id);
        const title = string(row.title);
        if (!id || !title) continue;
        const evidence = object(row.terminalCompletionEvidence)
          ?? object(object(row.payload)?._completionEvidence);
        const planItem = object(object(row.payload)?.plan_item);
        const planSlug = string(planItem?.plan_slug);
        items.push({
          id,
          kind: string(row.kind) ?? 'work-item',
          title,
          state: string(row.state) ?? 'unknown',
          completedAt: string(row.closedAt),
          completionAuthority: string(row.completionAuthority) ?? 'work-item-ledger',
          completionSummary: string(evidence?.summary),
          completionEvidence: evidence,
          planSlugs: planSlug ? [planSlug] : undefined,
        });
      }
    }
    return items;
  }

  async loadCommits(ids: readonly string[]): Promise<readonly ProjectHistoryCommitInput[]> {
    const log = git(this.runner, this.options.repoRoot, [
      'log', '--all', '--no-renames',
      '--format=%x1e%H%x00%s%x00%cI%x00%B%x00',
      '--name-only',
    ]);
    const remoteOutput = git(this.runner, this.options.repoRoot, ['rev-list', '--remotes'], true).trim();
    const remoteShas = remoteOutput.length > 0 ? new Set(remoteOutput.split(/\r?\n/).filter(Boolean)) : null;
    return commitsForWorkItems(parseGitLog(log), ids, remoteShas);
  }
}

function detectProject(
  options: ProjectHistoryGenerateOptions,
  runner: CommandRunner,
): ProjectHistoryProject {
  git(runner, options.repoRoot, ['rev-parse', '--is-inside-work-tree']);
  const remoteUrl = options.repositoryUrl
    ?? git(runner, options.repoRoot, ['remote', 'get-url', 'origin'], true).trim()
    || null;
  const branchRef = git(runner, options.repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true).trim();
  const defaultBranch = options.defaultBranch ?? (branchRef ? branchRef.replace(/^origin\//, '') : null);
  return {
    id: options.projectId,
    name: options.projectName,
    repository: repositoryFromRemote(remoteUrl, options.repositoryWebUrl, defaultBranch),
  };
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, body, 'utf8');
  await fs.rename(temporary, path);
}

function help(): string {
  return `papercusp project-history — generate a portable, validated project History artifact

Usage:
  papercusp project-history generate --harness <slug> [options]

Options:
  --workspace <id>          Papercusp workspace (default: PAPERCUSP_WORKSPACE)
  --prefix <value>          Include plan slugs with this prefix (default: <harness>-)
  --project-id <id>         Stable project id (default: harness slug)
  --project-name <name>     Display name (default: harness slug)
  --repo <path>             Git repository root (default: current directory)
  --output <path>           Output artifact (default: .papercusp/project-history.v1.json)
  --format <json|typescript>  Output format (default inferred from .ts extension)
  --export-name <name>      TypeScript export name (default: PROJECT_HISTORY)
  --generated-at <iso>      Fixed generation timestamp for reproducible builds
  --repository-url <url>    Override the Git origin metadata
  --repository-web-url <url> Override the browser-safe repository URL
  --default-branch <name>   Override the detected default branch
  --check                   Fail if the generated artifact differs; do not write
`;
}

export async function cmdProjectHistory(
  argv: string[],
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(help());
    return;
  }
  if (subcommand !== 'generate') throw new Error(`unknown project-history subcommand: ${subcommand}`);

  const options = parseProjectHistoryGenerateArgs(argv.slice(1));
  const project = detectProject(options, runner);
  const document = await generateProjectHistory({
    project,
    source: {
      kind: 'papercusp-plan-export',
      workspace: options.workspace,
      harness: options.harness,
      planPrefix: options.planPrefix,
      generatedAt: options.generatedAt,
      generator: 'papercusp project-history generate',
    },
    provider: new PtoolGitProjectHistoryProvider(options, runner),
  });
  const rendered = renderProjectHistory(document, options.format, options.exportName);

  if (options.check) {
    const current = await fs.readFile(options.output, 'utf8').catch(() => null);
    if (current !== rendered) throw new Error(`Project History artifact is stale: ${options.output}`);
    process.stdout.write(`Project History artifact is current: ${options.output}\n`);
    return;
  }

  await writeAtomic(options.output, rendered);
  process.stdout.write(`Wrote ${document.plans.length} plans to ${options.output}\n`);
}
