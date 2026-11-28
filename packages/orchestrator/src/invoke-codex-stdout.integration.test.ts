import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { invoke } from './invoke';
import * as spawnMcp from './spawn-mcp';

// The producer only writes fixture bytes. It cannot emit the rest or exit normally
// until the live chunk consumer has received and acknowledged its first event.
const producer = `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
const ack = fs.watch('.', () => {
  if (!fs.existsSync('ack')) return;
  ack.close();
  clearTimeout(deadline);
  process.stderr.write('fixture stderr\\n');
  process.stdout.write(fs.readFileSync('events'));
  process.exitCode = Number(fs.readFileSync('exit-code', 'utf8'));
});
const deadline = setTimeout(() => {
  ack.close();
  process.stderr.write('missing live acknowledgement\\n');
  process.exitCode = 90;
}, 15000);
process.stdout.write(JSON.stringify({ type: 'turn.started', regular: fs.fstatSync(1).isFile() }) + '\\n');
`;

function fixtureEvents() {
  const block = 64 * 1024;
  const prefix = '{"type":"fixture","text":"';
  const suffix = '"}\n';
  const lengths = [block - 1, block, block + 1];
  // The first byte of this four-byte character falls at the end of a read.
  const splitCharacter = prefix + 'x'.repeat(block - 1 - prefix.length) + '🌱' + suffix;
  const rows = Array.from({ length: 24 }, (_, i) =>
    prefix + String.fromCharCode(65 + i).repeat(lengths[i % lengths.length]! - prefix.length - suffix.length) + suffix);
  return splitCharacter + rows.join('') +
    '{"type":"item.completed","item":{"type":"agent_message","text":"terminal 🌱"}}\n' +
    '{"type":"turn.completed"}';
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test.each([
  { name: 'plain launcher', workspaceId: undefined, exitCode: 0, explicitJson: false },
  { name: 'fleet sandbox', workspaceId: 'stdout-fixture', exitCode: 7, explicitJson: false },
  { name: 'explicit JSON command', workspaceId: undefined, exitCode: 0, explicitJson: true },
])('invoke delivers ordered live and terminal Codex stdout through the $name', async ({
  workspaceId, exitCode, explicitJson,
}) => {
  // The Linux fleet sandbox mounts a private /dev/shm.
  const root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'orch-stdout-test-'));
  try {
    const stateDir = join(root, '.papercusp');
    const tempDir = join(root, 'tmp');
    mkdirSync(stateDir);
    mkdirSync(tempDir);
    vi.stubEnv('TMPDIR', tempDir);
    for (const key of ['AGENT_CMD', 'AGENT_MODELS', 'HARNESS_CONFIG_JSON',
      'PAPERCUSP_NATIVE_SESSION_ID', 'PAPERCUSP_CODEX_SESSION_KEY', 'PAPERCUSP_INTEGRATION_ROOT',
      'PAPERCUSP_PROMPT_ROOT']) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('PAPERCUSP_SPAWN_MODEL', 'gpt-5.5');
    vi.stubEnv('PAPERCUSP_FLEET_SANDBOX', '1');
    // Exercise the real sandbox and subprocess with an isolated home and a local chunk sink.
    vi.spyOn(spawnMcp, 'writeSignedSpawnCodexHome').mockResolvedValue({
      codexHome: stateDir, mcpUrl: '', cleanup() {},
    });
    const packets: Array<{ seq: number; chunk: string; done?: boolean }> = [];
    let firstEvent = '';
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/internal/run-chunk')) {
        const packet = JSON.parse(String(init?.body));
        packets.push(packet);
        if (!firstEvent.includes('\n')) {
          firstEvent += packet.chunk;
          if (firstEvent.includes('\n')) writeFileSync(join(root, 'ack'), '');
        }
      }
      return new Response('{}');
    });
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ harness_token: 'fixture' }));
    const binary = join(root, 'codex');
    writeFileSync(binary, producer, { mode: 0o700 });
    const events = fixtureEvents();
    writeFileSync(join(root, 'events'), events);
    writeFileSync(join(root, 'exit-code'), String(exitCode));

    const result = await invoke({
      claudeCmd: explicitJson ? `${binary} exec --json` : binary, agentBackend: 'codex',
      harnessDir: root, projectDir: root, stateDir, logDir: join(stateDir, 'logs'),
      phase: 'staging', workspaceId, log() {},
    }, 'stdout-fixture', [], { inlinePrompt: 'Emit the local fixture.' });

    const stderr = readFileSync(result.outPath.replace(/\.out$/, '.err'), 'utf8');
    expect(result.exitCode, stderr).toBe(exitCode);
    expect(stderr).toContain('fixture stderr');
    expect(existsSync(join(root, 'ack'))).toBe(true);
    const live = packets.map(p => p.chunk).join('');
    const headerEnd = live.indexOf('\n');
    expect(JSON.parse(live.slice(0, headerEnd))).toEqual({ type: 'turn.started', regular: true });
    expect(digest(live.slice(headerEnd + 1))).toBe(digest(events));
    expect(packets.map(p => p.seq)).toEqual(packets.map((_, i) => i));
    expect(packets.filter(p => p.done)).toEqual([packets.at(-1)]);
    expect(packets.at(-1)?.chunk).toBe('');
    const archive = readFileSync(result.jsonlPath, 'utf8');
    const raw = explicitJson ? archive : archive.slice(0, archive.lastIndexOf('\n{"type":"papercusp.run_meta"'));
    expect(digest(raw)).toBe(digest(live));
    if (!explicitJson) expect(result.output).toBe('terminal 🌱');
    expect(readdirSync(tempDir).filter(p => p.startsWith('papercusp-codex-stdout-'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
