import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitsForWorkItems,
  githubWebUrl,
  loadProjectHistoryPlansFromExport,
  parseGitLog,
  parseProjectHistoryGenerateArgs,
  projectHistoryOutputIsCurrent,
  projectHistoryWorkItemBatches,
  renderProjectHistory,
  repositoryFromRemote,
} from './project-history-cli.ts';
import type { ProjectHistoryDocument } from '@papercusp/plan-parser/project-history';

test('project-history args derive portable defaults and accept equals syntax', () => {
  const options = parseProjectHistoryGenerateArgs([
    '--harness=sidestage',
    '--project-name', 'SideStage',
    '--output', 'apps/api/src/history.snapshot.ts',
    '--generated-at', '2026-08-15T00:00:00.000Z',
  ], '/repo', { PAPERCUSP_WORKSPACE: 'workspace' }, new Date(0));

  assert.deepEqual(options, {
    workspace: 'workspace',
    harness: 'sidestage',
    planPrefix: 'sidestage-',
    projectId: 'sidestage',
    projectName: 'SideStage',
    repoRoot: '/repo',
    output: '/repo/apps/api/src/history.snapshot.ts',
    format: 'typescript',
    exportName: 'PROJECT_HISTORY',
    generatedAt: '2026-08-15T00:00:00.000Z',
    check: false,
    repositoryUrl: null,
    repositoryWebUrl: null,
    defaultBranch: null,
  });
});

test('project-history accepts an empty prefix to include every harness plan', () => {
  const options = parseProjectHistoryGenerateArgs([
    '--harness', 'sidestage',
    '--prefix=',
  ], '/repo', {}, new Date(0));

  assert.equal(options.planPrefix, null);
});

test('exported Markdown remains the complete plan enumeration when plans:list is truncated', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'project-history-cli-test-'));
  try {
    await Promise.all([
      fs.writeFile(join(directory, 'demo-a.md'), '# A\n', 'utf8'),
      fs.writeFile(join(directory, 'demo-b.md'), '# B\n', 'utf8'),
      fs.writeFile(join(directory, 'other.md'), '# Other\n', 'utf8'),
    ]);

    const plans = await loadProjectHistoryPlansFromExport(directory, [{
      slug: 'demo-a',
      updated: '2026-08-15T00:00:00.000Z',
    }], 'demo-');

    assert.deepEqual(plans.map((plan) => plan.filePath), ['demo-a.md', 'demo-b.md']);
    assert.equal(plans[0]?.updatedAt, '2026-08-15T00:00:00.000Z');
    assert.equal(plans[1]?.updatedAt, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('work-item ledger reads stay in timeout-resistant batches', () => {
  const batches = projectHistoryWorkItemBatches(Array.from({ length: 61 }, (_, index) => index));
  assert.deepEqual(batches.map((batch) => batch.length), [25, 25, 11]);
});

test('repository metadata converts common GitHub remotes without guessing other hosts', () => {
  assert.equal(githubWebUrl('git@github.com:Papercusp/sidestage.git'), 'https://github.com/Papercusp/sidestage');
  assert.equal(githubWebUrl('ssh://git@github.com/Papercusp/sidestage.git'), 'https://github.com/Papercusp/sidestage');
  assert.equal(githubWebUrl('ssh://git@example.test/Papercusp/sidestage.git'), null);
  assert.deepEqual(repositoryFromRemote('git@example.test:repo.git', null, 'main'), {
    provider: 'git',
    url: 'git@example.test:repo.git',
    webUrl: null,
    defaultBranch: 'main',
  });
});

test('git records preserve files and distinguish trailers from body references', () => {
  const raw = [
    ['abc1234', 'feat: one', '2026-08-15T00:00:00Z', 'Build WI-2\n\nPapercusp-Work-Item: WI-1\n', '\nsrc/z.ts\nsrc/a.ts\nsrc/z.ts\n'],
    ['def5678', 'chore: unrelated', '2026-08-14T00:00:00Z', 'No work item here', '\nREADME.md\n'],
  ].map((fields) => `\u001e${fields.join('\0')}`).join('');
  const commits = parseGitLog(raw);
  assert.deepEqual(commits[0]?.files, ['src/a.ts', 'src/z.ts']);

  const linked = commitsForWorkItems(commits, ['WI-1', 'WI-2'], new Set(['abc1234']));
  assert.equal(linked.length, 1);
  assert.equal(linked[0]?.remoteStatus, 'confirmed');
  assert.deepEqual(linked[0]?.links, [
    { workItemId: 'WI-1', attribution: 'authoritative' },
    { workItemId: 'WI-2', attribution: 'body-reference' },
  ]);
});

test('TypeScript rendering is a stable generated module', () => {
  const document = {
    schemaVersion: 1,
    project: { id: 'demo', name: 'Demo', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: 'workspace',
      harness: 'demo',
      planPrefix: 'demo-',
      generatedAt: '2026-08-15T00:00:00.000Z',
      planCount: 0,
      generator: 'test',
    },
    plans: [],
  } satisfies ProjectHistoryDocument;

  const rendered = renderProjectHistory(document, 'typescript', 'DEMO_HISTORY');
  assert.match(rendered, /export const DEMO_HISTORY = \{/);
  assert.match(rendered, /"schemaVersion": 1/);
  assert.ok(rendered.endsWith('as const;\n'));
});

test('check freshness ignores generatedAt drift but detects content drift', () => {
  const document = {
    schemaVersion: 1,
    project: { id: 'demo', name: 'Demo', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: 'workspace',
      harness: 'demo',
      planPrefix: 'demo-',
      generatedAt: '2026-08-15T00:00:00.000Z',
      planCount: 0,
      generator: 'papercusp project-history generate',
    },
    plans: [],
  } satisfies ProjectHistoryDocument;
  const current = renderProjectHistory(document, 'typescript', 'DEMO_HISTORY');
  const later = renderProjectHistory({
    ...document,
    source: { ...document.source, generatedAt: '2026-08-15T01:00:00.000Z' },
  }, 'typescript', 'DEMO_HISTORY');
  const changed = renderProjectHistory({
    ...document,
    project: { ...document.project, name: 'Changed' },
  }, 'typescript', 'DEMO_HISTORY');

  assert.equal(projectHistoryOutputIsCurrent(current, later, 'typescript'), true);
  assert.equal(projectHistoryOutputIsCurrent(current, changed, 'typescript'), false);
});
