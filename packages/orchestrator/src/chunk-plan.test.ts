import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  formatChunkCommitMessage,
  parseChunkPlanBlock,
  planChunksUpfrontPrompt,
  replanChunkPrompt,
} from './chunk-plan.js';

test('parseChunkPlanBlock parses a valid plan', () => {
  const out = `Here's my plan:

\`\`\`chunk-plan
{
  "chunks": [
    { "id": "F-X-1", "files": ["src/a.ts"],            "description": "add foo()" },
    { "id": "F-X-2", "files": ["src/a.ts","src/b.ts"], "description": "wire foo through bar" }
  ]
}
\`\`\`
`;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.featureId, 'F-X');
    assert.equal(r.value.chunks.length, 2);
    assert.equal(r.value.chunks[0].id, 'F-X-1');
    assert.deepEqual([...r.value.chunks[0].files], ['src/a.ts']);
    assert.equal(r.value.chunks[1].description, 'wire foo through bar');
  }
});

test('parseChunkPlanBlock tolerates trailing commas', () => {
  const out = `\`\`\`chunk-plan
{
  "chunks": [
    { "id": "F-X-1", "files": ["src/a.ts",], "description": "add foo()", },
  ],
}
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, true);
});

test('parseChunkPlanBlock rejects missing fenced block', () => {
  const r = parseChunkPlanBlock('I have no plan to give you.', 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /no ```chunk-plan fenced block/);
});

test('parseChunkPlanBlock rejects malformed JSON', () => {
  const r = parseChunkPlanBlock('```chunk-plan\nnot json at all\n```', 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /JSON parse error/);
});

test('parseChunkPlanBlock rejects chunks not an array', () => {
  const r = parseChunkPlanBlock('```chunk-plan\n{"chunks":"oops"}\n```', 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /chunks is not an array/);
});

test('parseChunkPlanBlock rejects chunk with mismatched feature ID', () => {
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-Y-1", "files": ["a.ts"], "description": "add foo" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /does not start with expected feature id/);
});

test('parseChunkPlanBlock rejects non-numeric chunk id suffix', () => {
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-X-foo", "files": ["a.ts"], "description": "add foo" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /suffix is not a positive integer/);
});

test('parseChunkPlanBlock rejects too-long description', () => {
  const desc = 'add ' + 'x'.repeat(80);
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-X-1", "files": ["a.ts"], "description": "${desc}" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /max 72/);
});

test('parseChunkPlanBlock rejects empty description', () => {
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-X-1", "files": ["a.ts"], "description": "" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /empty/);
});

test('parseChunkPlanBlock rejects disallowed verb', () => {
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-X-1", "files": ["a.ts"], "description": "implement foo()" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /must start with one of/);
});

test('parseChunkPlanBlock rejects non-string file entries', () => {
  const out = `\`\`\`chunk-plan
{ "chunks": [{ "id": "F-X-1", "files": [123], "description": "add foo" }] }
\`\`\``;
  const r = parseChunkPlanBlock(out, 'F-X');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /not string\[\]/);
});

test('parseChunkPlanBlock allows empty chunks array (the trivial plan)', () => {
  const r = parseChunkPlanBlock('```chunk-plan\n{"chunks":[]}\n```', 'F-X');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.chunks.length, 0);
});

test('formatChunkCommitMessage produces the agreed format', () => {
  const msg = formatChunkCommitMessage({
    id: 'F-AUTH-001-3',
    files: ['src/auth.ts'],
    description: 'add jwt verify middleware',
  });
  assert.equal(msg, 'chunk[F-AUTH-001-3]: add jwt verify middleware');
});

test('planChunksUpfrontPrompt mentions the feature id', () => {
  const p = planChunksUpfrontPrompt({
    featureId: 'F-PAY-007',
    featureTitle: 'Stripe webhook handler',
    featureDescription: 'Receive Stripe events and update orders.',
  });
  assert.match(p, /F-PAY-007/);
  assert.match(p, /Stripe webhook handler/);
  assert.match(p, /F-PAY-007-1/);
});

test('planChunksUpfrontPrompt embeds optional context', () => {
  const p = planChunksUpfrontPrompt({
    featureId: 'F-X',
    featureTitle: 'X',
    featureDescription: 'Y',
    context: 'CRITICAL: must not break webhook signing',
  });
  assert.match(p, /must not break webhook signing/);
});

test('replanChunkPrompt embeds the original chunk + error', () => {
  const p = replanChunkPrompt({
    featureId: 'F-X',
    failedChunk: { id: 'F-X-3', files: ['src/a.ts'], description: 'remove foo' },
    typecheckError: "src/c.ts:42:3 - error TS2304: Cannot find name 'foo'.",
    attemptedChange: 'Deleted foo() from src/a.ts',
  });
  assert.match(p, /F-X-3/);
  assert.match(p, /Cannot find name 'foo'/);
  assert.match(p, /Deleted foo\(\) from src\/a\.ts/);
});

test('planChunksUpfrontPrompt omits retry section when priorValidatorLog is unset', () => {
  const p = planChunksUpfrontPrompt({
    featureId: 'F-001',
    featureTitle: 't',
    featureDescription: 'd',
  });
  assert.ok(!p.includes('Prior validator rejection'), 'no retry section without prior log');
  assert.ok(!p.includes('RETRY'), 'no RETRY marker without prior log');
});

test('planChunksUpfrontPrompt includes retry section + prior files + validator body when prior log set', () => {
  const p = planChunksUpfrontPrompt({
    featureId: 'F-001',
    featureTitle: 't',
    featureDescription: 'd',
    priorValidatorLog: 'VAL-FAIL: assertion VAL-007 — login endpoint returned 500 not 200',
    priorFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
  });
  assert.match(p, /Prior validator rejection — this is a RETRY/);
  assert.match(p, /Files already touched on this feature/);
  assert.match(p, /src\/auth\/login\.ts/);
  assert.match(p, /src\/auth\/session\.ts/);
  assert.match(p, /VAL-FAIL: assertion VAL-007/);
});

test('planChunksUpfrontPrompt truncates long validator output to 8KB', () => {
  const big = 'X'.repeat(20000);
  const p = planChunksUpfrontPrompt({
    featureId: 'F-001',
    featureTitle: 't',
    featureDescription: 'd',
    priorValidatorLog: big,
  });
  assert.match(p, /truncated; first 8KB/);
  // The truncated body itself shouldn't exceed 8192 X's.
  const xRun = p.match(/X+/);
  assert.ok(xRun);
  assert.ok(xRun![0].length <= 8192, `X run too long: ${xRun![0].length}`);
});
