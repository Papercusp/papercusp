/**
 * High-level role-prompt assembly given a registered harness slug.
 *
 * This is the single source of truth that both autonomous dispatches and
 * chat sessions should use to assemble a role's prompt. It wraps
 * `resolvePromptFile` + `buildPrompt` with the slug → projectDir → config
 * lookup steps, so callers don't repeat that wiring.
 *
 * Today only the chat endpoint calls this directly — the autonomous loop
 * still goes through `run.sh` (which assembles inline). When the bash
 * `invoke()` is replaced by the TS orchestrator's `invoke.ts`, that path
 * should call `assembleRolePrompt` too, eliminating drift between the
 * autonomous and chat prompts.
 *
 * "Mode" is a small flag the prompt assembler can use to add chat-specific
 * runtime context (e.g., "you are responding to a user message; do not
 * commit; write to .harness/notes/<feature> if you want the autonomous
 * worker to act on something"). It does NOT swap out the role file —
 * chat-worker is the same agent as autonomous-worker, just talking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import { readConfig, resolvePhase, configGet } from './config';
import { buildPrompt } from './prompt-build';
import { resolvePromptFile } from './prompt-resolve';

export type RolePromptMode = 'autonomous' | 'chat';

export interface AssembleRolePromptOptions {
  /** Registered harness slug (must exist in ~/.restart-harness-projects.json). */
  slug: string;
  /** Role name — must have a corresponding prompts/<role>.md (or a phase/dept variant). */
  role: string;
  /** Optional feature scope. Becomes a runtime-context bullet and a worktree cwd hint. */
  featureId?: string;
  /** 'autonomous' (default — the orchestrator dispatched it) or 'chat' (a user is talking). */
  mode?: RolePromptMode;
  /** Run id for traceability. Auto-generated if absent. */
  runId?: string;
  /** Extra runtime-context bullets the caller wants in the prompt (e.g. "MODE=replan"). */
  extras?: readonly string[];
  /**
   * Project context to inject. Provided by the caller (which has DB access).
   * If non-empty, gets appended as a `## Project context (curated by Project
   * Manager)` section after `buildPrompt`'s output. Caller decides whether
   * the role should see it; this function just renders.
   */
  projectSpec?: {
    /** PROJ-XXX id; rendered in the section header. */
    projectId: string;
    /** The spec body; markdown. Empty string is treated as no-spec. */
    content: string;
    /** ISO timestamp of last update; rendered in the section header for staleness signaling. */
    updatedAt?: string;
  };
}

export interface AssembledPrompt {
  /** The full prompt text — feed this to claude as stdin or via --append-system-prompt. */
  text: string;
  /** Resolved metadata, useful for diagnostics and the chat transcript. */
  meta: {
    role: string;
    promptFile: string;
    projectDir: string;
    stateDir: string;
    harnessDir: string;
    runId: string;
  };
}

interface RegistryFile { projects?: Array<{ slug?: string; path?: string }> }

function homeDirPath(): string {
  return process.env.HOME ?? homedir();
}

/** Resolve a slug to its registered project dir. Returns null if not found. */
export function lookupProjectDir(slug: string): string | null {
  const registryPath = join(homeDirPath(), '.restart-harness-projects.json');
  if (!existsSync(registryPath)) return null;
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8')) as RegistryFile;
    return data.projects?.find((p) => p.slug === slug)?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Assemble a role's prompt for a given harness install.
 *
 * Throws if the slug isn't registered or the role's prompt file can't be
 * resolved — both are programming errors at the caller, not user errors.
 */
export function assembleRolePrompt(opts: AssembleRolePromptOptions): AssembledPrompt {
  const projectDir = lookupProjectDir(opts.slug);
  if (!projectDir) {
    throw new Error(`assembleRolePrompt: harness "${opts.slug}" not registered in ~/.restart-harness-projects.json`);
  }
  const stateDir = join(projectDir, '.harness');
  const harnessDir = harnessRoot();

  const cfg = readConfig(stateDir);
  const { phase } = resolvePhase(cfg);
  const dept = configGet<string>(cfg, 'dept', '');

  const promptFile = resolvePromptFile({ harnessDir, phase, dept }, opts.role);
  if (!promptFile) {
    throw new Error(`assembleRolePrompt: no prompt file found for role "${opts.role}" (phase=${phase}, dept=${dept || 'none'})`);
  }

  // Per-role specialization (config.json → promptOverrides.<role>) — string OR
  // markdown file path. Mirrors run.sh's logic.
  let promptOverride = '';
  const ovRaw = configGet<string>(cfg, `promptOverrides.${opts.role}`, '');
  if (ovRaw) {
    if (ovRaw.startsWith('/')) {
      if (existsSync(ovRaw)) promptOverride = readFileSync(ovRaw, 'utf8');
    } else if (ovRaw.startsWith('./') || ovRaw.endsWith('.md') || ovRaw.endsWith('.txt')) {
      const p = join(stateDir, ovRaw.replace(/^\.\//, ''));
      if (existsSync(p)) promptOverride = readFileSync(p, 'utf8');
    } else {
      promptOverride = ovRaw;
    }
  }

  const runId = opts.runId ?? `${Math.floor(Date.now() / 1000)}-${opts.role}${opts.featureId ? `-${opts.featureId}` : ''}`;
  const mode = opts.mode ?? 'autonomous';

  // Runtime-context extras. Mode is always present so the role prompt can
  // branch on it ("if MODE=chat, address the user; do not commit").
  const extras: string[] = [`MODE=${mode}`];
  if (opts.featureId) extras.push(`FEATURE_ID=${opts.featureId}`);
  if (mode === 'chat') {
    extras.push('CHAT=true (you are responding to a user message in real time; do not commit code; write supervisor-notes or .harness/notes/<feature>.md if you want the autonomous worker to act on something)');
  }
  for (const e of opts.extras ?? []) extras.push(e);

  // Expert instance context. When the role is `expert` and the featureId
  // looks like an EXP- id, load the instance's identity.json + SPEC.md and
  // expose them as runtime-context bullets. Lets the chat surface address
  // a specific expert without any new plumbing — the chat path passes the
  // EXP-id as featureId, the assembler does the rest.
  if (opts.role === 'expert' && opts.featureId && /^EXP-\d{3,}$/.test(opts.featureId)) {
    const expertDir = join(stateDir, 'experts', opts.featureId);
    if (existsSync(expertDir)) {
      const identityPath = join(expertDir, 'identity.json');
      const specPath = join(expertDir, 'SPEC.md');
      extras.push(`EXPERT_ID=${opts.featureId}`);
      extras.push(`EXPERT_DIR=${expertDir}`);
      if (existsSync(identityPath)) extras.push(`EXPERT_IDENTITY=${identityPath}`);
      if (existsSync(specPath)) extras.push(`EXPERT_SPEC=${specPath}`);
    }
  }

  let text = buildPrompt({
    role: opts.role,
    promptFile,
    promptOverride,
    stateDir,
    harnessDir,
    projectDir,
    cwdOverride: '',         // chat doesn't run inside a worktree; no cwd hint
    featureId: opts.featureId ?? null,
    runId,
    extras,
  });

  // Project-context injection. Curated by the Project Manager role; appended
  // after the buildPrompt output so it sits below memory + identity + runtime
  // context but above any caller-provided suffix (chat history, etc.).
  if (opts.projectSpec?.content && opts.projectSpec.content.trim()) {
    const updatedAtNote = opts.projectSpec.updatedAt
      ? ` · last curated ${opts.projectSpec.updatedAt}`
      : '';
    text += `\n\n---\n## Project context — ${opts.projectSpec.projectId} (curated by Project Manager${updatedAtNote})\n\n`;
    text += opts.projectSpec.content.trim();
    text += '\n';
  }

  return {
    text,
    meta: {
      role: opts.role,
      promptFile,
      projectDir,
      stateDir,
      harnessDir,
      runId,
    },
  };
}
