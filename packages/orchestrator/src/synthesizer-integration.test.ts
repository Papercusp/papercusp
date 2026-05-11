/**
 * Synthesizer integration test.
 *
 * Exercises the runSynthesizer full path with a mocked `invoke` that
 * simulates a synthesizer LLM writing files in the synthesis worktree.
 * Verifies:
 *   - synthesis worktree gets created from base
 *   - lane diffs are computed correctly
 *   - the agent's edits get committed on the synthesis branch
 *   - runSynthesizer returns { synthesized: true, branch, worktree }
 *   - the "no changes" path returns synthesized: false
 *
 * This stands in for the real-LLM verification before steps 3 + 5 of
 * the synthesizer plan ship.
 */
import { test, vi, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Mock invoke before any synthesizer import ────────────────────
// vi.mock is hoisted; use vi.hoisted to declare the spy alongside it
// so the factory closure captures a real fn instead of TDZ-undefined.
const { inv } = vi.hoisted(() => ({ inv: vi.fn() as ReturnType<typeof vi.fn> }));
vi.mock('./invoke', () => ({ invoke: inv }));

import { runSynthesizer, singleLaneManifest } from './synthesizer';
import { buildCompetitionManifest } from './lanes';

beforeEach(() => {
  inv.mockReset();
});

interface Project {
  root: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  cleanup: () => void;
}

function setupProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'synth-int-'));
  const projectDir = root;
  const stateDir = join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: projectDir });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: projectDir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: projectDir });
  writeFileSync(join(projectDir, 'README.md'), 'base\n');
  spawnSync('git', ['add', '-A'], { cwd: projectDir });
  spawnSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: projectDir });
  return {
    root,
    projectDir,
    stateDir,
    logDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Add a lane worktree with its own commit containing `files`. */
function addLane(
  projectDir: string,
  stateDir: string,
  fid: string,
  laneNum: number,
  files: Record<string, string>,
): { worktree: string; branch: string } {
  const worktree = join(stateDir, 'worktrees', `${fid}-lane-${laneNum}`);
  const branch = `harness/${fid}-lane-${laneNum}`;
  mkdirSync(join(stateDir, 'worktrees'), { recursive: true });
  spawnSync('git', ['worktree', 'add', '-B', branch, worktree, 'main'], {
    cwd: projectDir,
  });
  for (const [path, content] of Object.entries(files)) {
    const full = join(worktree, path);
    mkdirSync(join(worktree, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'), {
      recursive: true,
    });
    writeFileSync(full, content);
  }
  spawnSync('git', ['add', '-A'], { cwd: worktree });
  spawnSync('git', ['commit', '--quiet', '-m', `lane-${laneNum}`], {
    cwd: worktree,
  });
  return { worktree, branch };
}

function makeCtx(p: Project) {
  return {
    harnessDir: '/unused/harnessDir',
    projectDir: p.projectDir,
    stateDir: p.stateDir,
    logDir: p.logDir,
    phase: 'staging',
    claudeCmd: '/bin/true',
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────

test('runSynthesizer N=2 happy path — writes marker, commits, returns synthesized:true', async () => {
  const p = setupProject();
  try {
    addLane(p.projectDir, p.stateDir, 'F-A', 1, { 'a.txt': 'lane1 take\n' });
    addLane(p.projectDir, p.stateDir, 'F-A', 2, { 'a.txt': 'lane2 take\n' });

    // Mock invoke: simulate the synthesizer picking lane1's version
    // and writing a synthesis-notes file.
    inv.mockImplementation(async (ctx: any, _role: string, extras: string[]) => {
      const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
      const wt = wtExtra.split('=', 2)[1];
      writeFileSync(join(wt, 'a.txt'), 'lane1 take\n');
      mkdirSync(join(p.stateDir, 'synthesis-notes'), { recursive: true });
      writeFileSync(
        join(p.stateDir, 'synthesis-notes', 'F-A.md'),
        '# F-A synthesis\nTook a.txt from lane 1; lane 2 was identical.\n',
      );
      return { exitCode: 0, output: '', stderr: '', runId: 'fake' };
    });

    const manifest = buildCompetitionManifest(p.stateDir, 'F-A', 2);
    const result = await runSynthesizer({
      fid: 'F-A',
      manifest,
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });

    assert.equal(result.synthesized, true, 'happy path returns synthesized:true');
    assert.equal(result.branch, 'harness/F-A-synthesis');
    assert.ok(result.worktree?.endsWith('/F-A-synthesis'));

    // Verify the file landed on the synthesis branch.
    const show = spawnSync('git', ['show', 'harness/F-A-synthesis:a.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'lane1 take\n');

    // Verify a commit exists on the synthesis branch.
    const log = spawnSync('git', ['log', '--oneline', 'harness/F-A-synthesis'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.ok(log.stdout.includes('synthesizer: F-A'));

    // Mock was called exactly once with the expected role.
    assert.equal(inv.mock.calls.length, 1);
    assert.equal(inv.mock.calls[0][1], 'synthesizer');
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer N=1 (single lane) happy path — synthesizer polishes worker output', async () => {
  const p = setupProject();
  try {
    // For N=1, we simulate the worker having committed to harness/F-B
    // in a feature worktree at .harness/worktrees/F-B.
    const wt = join(p.stateDir, 'worktrees', 'F-B');
    const br = 'harness/F-B';
    mkdirSync(join(p.stateDir, 'worktrees'), { recursive: true });
    spawnSync('git', ['worktree', 'add', '-B', br, wt, 'main'], {
      cwd: p.projectDir,
    });
    writeFileSync(join(wt, 'feature.txt'), 'rough draft\n');
    spawnSync('git', ['add', '-A'], { cwd: wt });
    spawnSync('git', ['commit', '--quiet', '-m', 'worker draft'], { cwd: wt });

    // Synthesizer polishes: takes the worker's file but rewrites the content.
    inv.mockImplementation(async (_ctx: any, _role: string, extras: string[]) => {
      const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
      const synthWt = wtExtra.split('=', 2)[1];
      writeFileSync(join(synthWt, 'feature.txt'), 'polished version\n');
      return { exitCode: 0, output: '', stderr: '', runId: 'fake' };
    });

    const result = await runSynthesizer({
      fid: 'F-B',
      manifest: singleLaneManifest(p.stateDir, 'F-B'),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });

    assert.equal(result.synthesized, true);
    const show = spawnSync('git', ['show', 'harness/F-B-synthesis:feature.txt'], {
      cwd: p.projectDir,
      encoding: 'utf8',
    });
    assert.equal(show.stdout, 'polished version\n');
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer no-edits → synthesized:false with reason', async () => {
  const p = setupProject();
  try {
    addLane(p.projectDir, p.stateDir, 'F-C', 1, { 'a.txt': 'x\n' });
    // Mock invoke returns 0 but writes nothing.
    inv.mockResolvedValue({ exitCode: 0, output: '', stderr: '', runId: 'fake' });

    const result = await runSynthesizer({
      fid: 'F-C',
      manifest: buildCompetitionManifest(p.stateDir, 'F-C', 1),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });
    assert.equal(result.synthesized, false);
    assert.match(result.reason ?? '', /produced no changes/);
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer nonzero exit → synthesized:false', async () => {
  const p = setupProject();
  try {
    addLane(p.projectDir, p.stateDir, 'F-D', 1, { 'a.txt': 'x\n' });
    inv.mockResolvedValue({ exitCode: 7, output: '', stderr: 'boom', runId: 'fake' });

    const result = await runSynthesizer({
      fid: 'F-D',
      manifest: buildCompetitionManifest(p.stateDir, 'F-D', 1),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });
    assert.equal(result.synthesized, false);
    assert.match(result.reason ?? '', /nonzero exit/);
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer invoke throws → synthesized:false with caught reason', async () => {
  const p = setupProject();
  try {
    addLane(p.projectDir, p.stateDir, 'F-E', 1, { 'a.txt': 'x\n' });
    inv.mockRejectedValue(new Error('agent backend unreachable'));

    const result = await runSynthesizer({
      fid: 'F-E',
      manifest: buildCompetitionManifest(p.stateDir, 'F-E', 1),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });
    assert.equal(result.synthesized, false);
    assert.match(result.reason ?? '', /agent backend unreachable/);
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer N=3 — extras include all lanes in SYNTHESIS_LANES', async () => {
  const p = setupProject();
  try {
    addLane(p.projectDir, p.stateDir, 'F-F', 1, { 'a.txt': 'one\n' });
    addLane(p.projectDir, p.stateDir, 'F-F', 2, { 'a.txt': 'two\n' });
    addLane(p.projectDir, p.stateDir, 'F-F', 3, { 'a.txt': 'three\n' });

    let lanesPayload = '';
    inv.mockImplementation(async (_ctx: any, _role: string, extras: string[]) => {
      const lanesExtra = extras.find((e) => e.startsWith('SYNTHESIS_LANES='))!;
      lanesPayload = lanesExtra.split('=', 2)[1];
      const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
      const synthWt = wtExtra.split('=', 2)[1];
      writeFileSync(join(synthWt, 'a.txt'), 'merged\n');
      return { exitCode: 0, output: '', stderr: '', runId: 'fake' };
    });

    const result = await runSynthesizer({
      fid: 'F-F',
      manifest: buildCompetitionManifest(p.stateDir, 'F-F', 3),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });
    assert.equal(result.synthesized, true);
    const parsed = JSON.parse(lanesPayload);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].lane, 1);
    assert.equal(parsed[2].lane, 3);
    assert.ok(parsed[0].branch === 'harness/F-F-lane-1');
  } finally {
    p.cleanup();
  }
});

test('runSynthesizer — competition manifest is persisted to disk for the synthesizer role to read', async () => {
  const p = setupProject();
  try {
    // No pre-existing manifest. runSynthesizer should write one.
    addLane(p.projectDir, p.stateDir, 'F-G', 1, { 'a.txt': 'x\n' });
    addLane(p.projectDir, p.stateDir, 'F-G', 2, { 'a.txt': 'y\n' });

    inv.mockImplementation(async (_ctx: any, _role: string, extras: string[]) => {
      const wtExtra = extras.find((e) => e.startsWith('SYNTHESIS_WORKTREE='))!;
      const synthWt = wtExtra.split('=', 2)[1];
      writeFileSync(join(synthWt, 'a.txt'), 'merged\n');
      return { exitCode: 0, output: '', stderr: '', runId: 'fake' };
    });

    await runSynthesizer({
      fid: 'F-G',
      manifest: buildCompetitionManifest(p.stateDir, 'F-G', 2),
      ctx: makeCtx(p),
      cfg: {} as any,
      log: () => {},
    });

    const manifestPath = join(p.stateDir, 'competition-F-G.json');
    const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifestJson.parentFeatureId, 'F-G');
    assert.equal(manifestJson.n, 2);
    assert.equal(manifestJson.lanes.length, 2);
  } finally {
    p.cleanup();
  }
});
