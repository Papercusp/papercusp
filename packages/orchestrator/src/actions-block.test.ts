import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractActionsBlock,
  parseActionsJson,
  processActionsBlock,
} from './actions-block.js';

test('extractActionsBlock — returns null when no fenced block', () => {
  assert.equal(extractActionsBlock(''), null);
  assert.equal(extractActionsBlock('plain text\n```python\nprint(1)\n```\n'), null);
});

test('extractActionsBlock — pulls content between ```actions and ```', () => {
  const stdout = `Some thinking…
\`\`\`actions
[{"kind":"send_message","to":"sales"}]
\`\`\`
trailing notes`;
  const out = extractActionsBlock(stdout);
  assert.equal(out, '[{"kind":"send_message","to":"sales"}]');
});

test('extractActionsBlock — handles multi-line JSON', () => {
  const stdout = `\`\`\`actions
[
  {"kind":"a"},
  {"kind":"b"}
]
\`\`\``;
  const out = extractActionsBlock(stdout);
  assert.match(out ?? '', /"kind":"a"/);
  assert.match(out ?? '', /"kind":"b"/);
});

test('extractActionsBlock — only first block when multiple', () => {
  const stdout = `\`\`\`actions
[1]
\`\`\`
some other text
\`\`\`actions
[2]
\`\`\``;
  assert.equal(extractActionsBlock(stdout), '[1]');
});

test('parseActionsJson — null on non-JSON', () => {
  assert.equal(parseActionsJson('not json'), null);
});

test('parseActionsJson — null on non-array (object only)', () => {
  assert.equal(parseActionsJson('{"kind":"a"}'), null);
});

test('parseActionsJson — returns array on valid JSON', () => {
  const out = parseActionsJson('[{"a":1},{"b":2}]');
  assert.ok(Array.isArray(out));
  assert.equal(out?.length, 2);
});

test('processActionsBlock — no block → count 0, no errors, no log', async () => {
  const log: string[] = [];
  const r = await processActionsBlock({
    stdout: 'plain output, no fence',
    log: (m) => log.push(m),
  });
  assert.deepEqual(r, { count: 0, errors: 0 });
  assert.equal(log.length, 0);
});

test('processActionsBlock — malformed JSON logs and skips', async () => {
  const log: string[] = [];
  const r = await processActionsBlock({
    stdout: '```actions\n{not array, not even valid json}\n```\n',
    log: (m) => log.push(m),
  });
  assert.deepEqual(r, { count: 0, errors: 0 });
  assert.ok(log.some((l) => l.includes('malformed JSON block')));
});

test('processActionsBlock — POSTs each action to apiUrl override', async () => {
  // Spin up a tiny in-process server to mock the action endpoint.
  const http = await import('node:http');
  const requests: { body: string; ok: boolean }[] = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      requests.push({ body: buf, ok: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"id":"abc"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}/exec`;

  const log: string[] = [];
  try {
    const r = await processActionsBlock({
      stdout: '```actions\n[{"kind":"a"},{"kind":"b"}]\n```\n',
      callingDept: 'business',
      log: (m) => log.push(m),
      apiUrl,
      timeoutMs: 5000,
    });
    assert.equal(r.count, 2);
    assert.equal(r.errors, 0);
    assert.equal(requests.length, 2);
    // Both bodies include callingDept.
    assert.match(requests[0].body, /"callingDept":"business"/);
    assert.match(requests[1].body, /"callingDept":"business"/);
    assert.ok(log.some((l) => l === 'ACTIONS: 2 op(s) detected'));
    assert.ok(log.some((l) => l.startsWith('  action 1/2')));
    assert.ok(log.some((l) => l.startsWith('  action 2/2')));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('processActionsBlock — non-2xx counted as error', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('{"ok":false}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    const r = await processActionsBlock({
      stdout: '```actions\n[{"kind":"a"}]\n```\n',
      log: () => {},
      apiUrl: `http://127.0.0.1:${port}/exec`,
      timeoutMs: 5000,
    });
    assert.equal(r.count, 1);
    assert.equal(r.errors, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
