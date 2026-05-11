/**
 * Synthesizer step.
 *
 * Sits between workers and the validator in the multi-agent pipeline.
 * The synthesizer LLM receives N candidate implementations (lane diffs)
 * for a feature, plus the feature spec and project conventions, and
 * produces the final shipped tree inside a dedicated `<fid>-synthesis`
 * worktree. The validator then runs against that worktree as if it were
 * a normal single-branch feature — no special protocol on its side.
 *
 * N may be 1: in that case the synthesizer's job is to take a single
 * worker's draft across the finish line (polish, fix obvious bugs,
 * ship). Gated by `parallelWorkers.synthesizeSingle` (default true).
 *
 * The synthesis step is gated by `parallelWorkers.useSynthesizer` for
 * one verification cycle; once flipped on permanently the flag goes
 * away (step 3 of the plan) and the legacy COMPETITION_WINNER path is
 * deleted.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configGet } from './config';
import { git } from './git';
import { invoke, type InvokeContext } from './invoke';
import { branchIsoBase } from './branch-iso';
import { competitionManifestPath, type CompetitionManifest } from './lanes';
import type { HarnessConfig } from './types';

export interface SynthesisResult {
  synthesized: boolean;
  branch?: string;
  worktree?: string;
  reason?: string;
}

/** Whether the synthesizer step is active for this harness. */
export function useSynthesizer(cfg: HarnessConfig): boolean {
  const v = configGet<unknown>(cfg, 'parallelWorkers.useSynthesizer', false);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return false;
}

/**
 * Whether single-worker dispatches go through synthesis. Default true —
 * synthesis-as-code-review even when only one candidate exists. Users
 * can flip to false to skip the extra LLM call on N=1.
 */
export function synthesizeSingle(cfg: HarnessConfig): boolean {
  const v = configGet<unknown>(cfg, 'parallelWorkers.synthesizeSingle', true);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return true;
}

/** Path to a feature's synthesis worktree. */
export function synthesisWorktreePath(stateDir: string, featureId: string): string {
  return join(stateDir, 'worktrees', `${featureId}-synthesis`);
}

/** Branch name for a feature's synthesis worktree. */
export function synthesisBranch(featureId: string): string {
  return `harness/${featureId}-synthesis`;
}

/** Path the synthesizer can write a per-feature explanatory note to. */
export function synthesisNotePath(stateDir: string, featureId: string): string {
  return join(stateDir, 'synthesis-notes', `${featureId}.md`);
}

/**
 * Build a synthetic 1-lane manifest from the worker's feature branch.
 * Used when synthesis runs on N=1 dispatches that didn't write a real
 * manifest. The lane branch is the standard `harness/<fid>` produced by
 * handleParallelLaneWorker / single-worker path.
 */
export function singleLaneManifest(
  stateDir: string,
  featureId: string,
): CompetitionManifest {
  return {
    parentFeatureId: featureId,
    n: 1,
    lanes: [
      {
        lane: 1,
        worktree: join(stateDir, 'worktrees', featureId),
        branch: `harness/${featureId}`,
      },
    ],
  };
}

interface SynthesisInputs {
  fid: string;
  manifest: CompetitionManifest;
  ctx: InvokeContext;
  cfg: HarnessConfig;
  log: (msg: string) => void;
}

/**
 * Create (or reuse) the synthesis worktree branched from base.
 * Idempotent — safe to call across retries.
 */
function ensureSynthesisWorktree(inputs: SynthesisInputs): { worktree: string; branch: string } {
  const { fid, ctx, cfg, log } = inputs;
  const base = branchIsoBase({
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log,
  });
  const worktree = synthesisWorktreePath(ctx.stateDir, fid);
  const branch = synthesisBranch(fid);
  mkdirSync(join(ctx.stateDir, 'worktrees'), { recursive: true });
  if (!existsSync(worktree)) {
    const r = git(['worktree', 'add', '-B', branch, worktree, base], {
      cwd: ctx.projectDir,
    });
    if (r.outputHead(3)) log(`  ${r.outputHead(3)}`);
  }
  return { worktree, branch };
}

/**
 * Compute the diff between base and each candidate lane's branch.
 * Returned as a list of `{lane, branch, worktree, diff}` records the
 * synthesizer prompt enumerates.
 */
function buildLaneDiffs(
  inputs: SynthesisInputs,
): { lane: number; branch: string; worktree: string; diff: string }[] {
  const { ctx, cfg, manifest, log } = inputs;
  const base = branchIsoBase({
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log,
  });
  const out: { lane: number; branch: string; worktree: string; diff: string }[] = [];
  for (const lane of manifest.lanes) {
    const r = git(['diff', `${base}...${lane.branch}`], { cwd: ctx.projectDir });
    out.push({
      lane: lane.lane,
      branch: lane.branch,
      worktree: lane.worktree,
      diff: r.output,
    });
  }
  return out;
}

/**
 * Run the synthesizer role on a feature.
 *
 *  1. Create/reuse `<fid>-synthesis` worktree from base.
 *  2. Build lane-diff context (the LLM also has filesystem access to
 *     each lane worktree directly).
 *  3. Persist the manifest to disk so the synthesizer role can read it
 *     with the same shape competition mode used.
 *  4. Invoke the synthesizer role inside the synthesis worktree.
 *  5. Commit whatever the synthesizer left.
 *
 * Returns `{synthesized: true, branch, worktree}` on success. A failure
 * is "no commit was produced" or the LLM exited nonzero — caller is
 * responsible for falling back / marking the feature failing.
 */
export async function runSynthesizer(inputs: SynthesisInputs): Promise<SynthesisResult> {
  const { fid, manifest, ctx, log } = inputs;
  try {
    const { worktree, branch } = ensureSynthesisWorktree(inputs);

    // Persist the manifest so the synthesizer role's shell tools can
    // read it. Skips the write if the file already exists (real
    // competition path already wrote it; the synthetic-1-lane path
    // needs the write).
    const manifestPath = competitionManifestPath(ctx.stateDir, fid);
    if (!existsSync(manifestPath)) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    const laneDiffs = buildLaneDiffs(inputs);
    log(`SYNTHESIZER: ${fid} starting (${manifest.n} candidate${manifest.n === 1 ? '' : 's'})`);

    // Surface lane metadata via env extras. The role prompt instructs the
    // LLM to enumerate $SYNTHESIS_LANES (JSON) and read each worktree.
    // Diffs themselves are not embedded — too long for env; the role
    // reads them from disk via `git diff` or reads the files directly.
    const lanesPayload = JSON.stringify(
      laneDiffs.map(({ lane, worktree: lwt, branch: lbr }) => ({
        lane,
        worktree: lwt,
        branch: lbr,
      })),
    );
    const extras = [
      `FEATURE_ID=${fid}`,
      `SYNTHESIS_LANE_COUNT=${String(manifest.n)}`,
      `SYNTHESIS_LANES=${lanesPayload}`,
      `SYNTHESIS_WORKTREE=${worktree}`,
      `SYNTHESIS_BRANCH=${branch}`,
      `SYNTHESIS_NOTE_PATH=${synthesisNotePath(ctx.stateDir, fid)}`,
    ];

    const synthCtx: InvokeContext = { ...ctx, worktreePathFor: () => worktree };
    let exitCode = 0;
    try {
      const r = await invoke(synthCtx, 'synthesizer', extras);
      exitCode = r.exitCode;
    } catch (err) {
      log(`SYNTHESIZER error: ${(err as Error).message}`);
      return { synthesized: false, reason: `invoke threw: ${(err as Error).message}` };
    }
    if (exitCode !== 0) {
      log(`SYNTHESIZER: ${fid} exited rc=${exitCode}`);
      return { synthesized: false, reason: `nonzero exit (${exitCode})` };
    }

    // Commit whatever the synthesizer left in the worktree. An empty
    // synthesis is a failure — the role's job was to produce a shipping
    // candidate, and "no changes from base" means it didn't.
    git(['add', '-A'], { cwd: worktree });
    const status = git(['diff', '--cached', '--quiet'], { cwd: worktree });
    if (status.exitCode === 0) {
      log(`SYNTHESIZER: ${fid} produced no changes — treating as failure`);
      return { synthesized: false, reason: 'synthesizer produced no changes from base' };
    }
    const commit = git(
      [
        'commit',
        '--quiet',
        '-m',
        `synthesizer: ${fid} (from ${manifest.n} candidate${manifest.n === 1 ? '' : 's'})`,
      ],
      { cwd: worktree },
    );
    if (commit.outputHead(3)) log(`  ${commit.outputHead(3)}`);

    log(`SYNTHESIZER: ${fid} branch ${branch} ready for validation`);
    return { synthesized: true, branch, worktree };
  } catch (err) {
    log(`SYNTHESIZER fatal: ${(err as Error).message}`);
    return { synthesized: false, reason: (err as Error).message };
  }
}
