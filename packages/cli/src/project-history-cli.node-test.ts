import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitsForWorkItems,
  githubWebUrl,
  parseGitLog,
  parseProjectHistoryGenerateArgs,
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
