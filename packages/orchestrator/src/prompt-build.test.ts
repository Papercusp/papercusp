import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt } from './prompt-build.js';

interface Fixture {
  harnessDir: string;
  stateDir: string;
  projectDir: string;
  cleanup: () => void;
}

function makeFixture(setup: (paths: Omit<Fixture, 'cleanup'>) => void): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-orch-build-'));
  const harnessDir = join(root, 'harness');
  const stateDir = join(root, 'state');
  const projectDir = join(root, 'project');
  mkdirSync(join(harnessDir, 'identity'), { recursive: true });
  mkdirSync(join(stateDir, 'memory'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const paths = { harnessDir, stateDir, projectDir };
  setup(paths);
  return { ...paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('buildPrompt — minimal: just the role prompt + runtime context', () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER\nDo the thing.');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: '1700000000-worker',
      extras: ['MODE=fresh'],
    });
    assert.match(out, /# WORKER/);
    assert.match(out, /Do the thing\./);
    assert.match(out, /## Runtime context/);
    assert.match(out, /- MODE=fresh/);
    assert.match(out, /Working directory: .+\/project/);
    assert.match(out, /Run ID: 1700000000-worker/);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — promptOverride section appears with role name in heading', () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: 'Be especially terse.',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r1',
      extras: [],
    });
    assert.match(
      out,
      /## Droid specialization \(from \.harness\/config\.json → promptOverrides\.worker\)/,
    );
    assert.match(out, /Be especially terse\./);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — curator does NOT get memory injection', () => {
  const fx = makeFixture(({ harnessDir, stateDir }) => {
    writeFileSync(join(harnessDir, 'curator.md'), '# CURATOR');
    writeFileSync(join(stateDir, 'memory', 'summary.md'), 'Important memory line');
  });
  try {
    const out = buildPrompt({
      role: 'curator',
      promptFile: join(fx.harnessDir, 'curator.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r1',
      extras: [],
    });
    assert.doesNotMatch(out, /Memory \(curated from prior iterations/);
    assert.doesNotMatch(out, /Important memory line/);
    // And no memory-discipline footer for curator
    assert.doesNotMatch(out, /Memory discipline/);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — non-curator gets memory + memory-discipline footer', () => {
  const fx = makeFixture(({ harnessDir, stateDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER');
    writeFileSync(join(stateDir, 'memory', 'summary.md'), 'A learned thing.');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r1',
      extras: [],
    });
    assert.match(out, /## Memory \(curated from prior iterations/);
    assert.match(out, /A learned thing\./);
    assert.match(out, /Memory discipline:/);
    assert.match(out, /append ONE line to/);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — identity file injected when present and non-empty', () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER');
    writeFileSync(join(harnessDir, 'identity', 'worker.md'), 'I have learned X across missions.');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r1',
      extras: [],
    });
    assert.match(out, /## Your identity \(cross-mission memory for the worker role\)/);
    assert.match(out, /I have learned X across missions\./);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — empty identity file is skipped (no header)', () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER');
    writeFileSync(join(harnessDir, 'identity', 'worker.md'), '');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '',
      featureId: null,
      runId: 'r1',
      extras: [],
    });
    assert.doesNotMatch(out, /Your identity/);
  } finally {
    fx.cleanup();
  }
});

test('buildPrompt — cwdOverride mentions worktree + project root', () => {
  const fx = makeFixture(({ harnessDir }) => {
    writeFileSync(join(harnessDir, 'worker.md'), '# WORKER');
  });
  try {
    const out = buildPrompt({
      role: 'worker',
      promptFile: join(fx.harnessDir, 'worker.md'),
      promptOverride: '',
      stateDir: fx.stateDir,
      harnessDir: fx.harnessDir,
      projectDir: fx.projectDir,
      cwdOverride: '/tmp/wt/F-001',
      featureId: 'F-001',
      runId: 'r1',
      extras: ['FEATURE_ID=F-001'],
    });
    assert.match(out, /Working directory: \/tmp\/wt\/F-001 \(worktree for F-001\)/);
    assert.match(out, /Project root: .+\/project \(reference only/);
  } finally {
    fx.cleanup();
  }
});
