import { EventEmitter } from 'node:events';
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
});
