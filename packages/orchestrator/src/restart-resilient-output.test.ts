import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  installRestartResilientOutputHandlers,
  isLauncherPipeDisconnect,
} from './restart-resilient-output.js';

describe('restart-resilient invoke-once output', () => {
  it('classifies only an OS EPIPE as a launcher-pipe disconnect', () => {
    expect(isLauncherPipeDisconnect(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isLauncherPipeDisconnect(Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(false);
    expect(isLauncherPipeDisconnect(new Error('EPIPE mentioned only in prose'))).toBe(false);
  });

  it('keeps the driver alive after EPIPE on either inherited output stream', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdoutOn = vi.spyOn(stdout, 'on');
    const stderrOn = vi.spyOn(stderr, 'on');

    installRestartResilientOutputHandlers([stdout, stderr]);

    expect(stdoutOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(stderrOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(() => stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });

  it('does not hide unrelated stream failures', () => {
    const stream = new EventEmitter();
    installRestartResilientOutputHandlers([stream]);

    expect(() => stream.emit('error', Object.assign(new Error('disk IO failed'), { code: 'EIO' }))).toThrow(
      'disk IO failed',
    );
  });

  it('survives a real closed launcher pipe long enough to finalize its result artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-output-restart-'));
    const resultPath = join(dir, 'result.log');
    const helperUrl = new URL('./restart-resilient-output.ts', import.meta.url).href;
    const script = `
      import { appendFileSync } from 'node:fs';
      import { installRestartResilientOutputHandlers } from ${JSON.stringify(helperUrl)};
      installRestartResilientOutputHandlers();
      setTimeout(() => process.stdout.write('post-restart output\\n'), 25);
      setTimeout(() => {
        appendFileSync(${JSON.stringify(resultPath)}, '__INVOCATION_RESULT__:{"exitCode":0}\\n__INVOCATION_DONE__\\n');
        process.exit(0);
      }, 75);
    `;

    try {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.destroy();
      const [code] = await once(child, 'exit');

      expect(code).toBe(0);
      expect(readFileSync(resultPath, 'utf8')).toContain('__INVOCATION_DONE__');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
