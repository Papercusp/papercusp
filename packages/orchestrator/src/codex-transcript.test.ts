/** Codex transcript tee (2026-07-01) — the synthesized claude-shaped wake
 *  transcript the hive-tabs mirror panes tail. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTranscriptLines, writeCodexTranscript, codexTranscriptsDir } from './codex-transcript';

const STREAM = [
  '{"type":"thread.started","thread_id":"019f-abc"}',
  '{"type":"turn.started"}',
  'non-json banner noise',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Placed WI-9 on a bee; next wake in 10m."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
].join('\n');

describe('codexTranscriptLines', () => {
  it('emits a user line (the kickoff) + one assistant line per agent_message, in the TUI parser shape', () => {
    const lines = codexTranscriptLines('Queen wake: survey and place.', STREAM);
    expect(lines).toHaveLength(2);
    const user = JSON.parse(lines[0]);
    expect(user).toEqual({ type: 'user', message: { role: 'user', content: 'Queen wake: survey and place.' } });
    const assistant = JSON.parse(lines[1]);
    expect(assistant.type).toBe('assistant');
    expect(assistant.message.content).toEqual([{ type: 'text', text: 'Placed WI-9 on a bee; next wake in 10m.' }]);
  });

  it('returns [] when the stream carries no agent_message (write nothing; the pane keeps the last wake)', () => {
    expect(codexTranscriptLines('prompt', '{"type":"turn.started"}')).toEqual([]);
    expect(codexTranscriptLines('prompt', '')).toEqual([]);
  });
});

describe('writeCodexTranscript', () => {
  it('writes <uuid>.jsonl under codex-transcripts and returns the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-tee-'));
    try {
      const p = writeCodexTranscript({ sessionId: 'aaaa-bbbb', prompt: 'wake', rawJsonl: STREAM, home });
      expect(p).toBe(join(codexTranscriptsDir(home), 'aaaa-bbbb.jsonl'));
      const body = readFileSync(p!, 'utf8').trim().split('\n');
      expect(body).toHaveLength(2);
      expect(JSON.parse(body[1]).type).toBe('assistant');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips (null) without a session id or without a turn — and never throws', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-tee-'));
    try {
      expect(writeCodexTranscript({ sessionId: undefined, prompt: 'p', rawJsonl: STREAM, home })).toBeNull();
      expect(writeCodexTranscript({ sessionId: 'x', prompt: 'p', rawJsonl: '', home })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
