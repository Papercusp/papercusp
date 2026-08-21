import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness');
const promptPath = join(harnessDir, 'blueprints', 'base', 'prompts', 'content-fixer.md');

test('content-fixer persona treats the dispatch extra as the sole authoritative offender list', () => {
  const prompt = readFileSync(promptPath, 'utf8');

  assert.match(prompt, /`--git-sync-content-error` extra[\s\S]*only authoritative offender list/);
  assert.match(prompt, /open \*\*git-sync-content-error escalation\*\*[\s\S]*human-visible status/);
  assert.match(prompt, /never use it as the offender list/);
  assert.doesNotMatch(
    prompt,
    /open \*\*git-sync-content-error escalation\*\*[\s\S]*authoritative `files\[\]` list/,
  );
});
