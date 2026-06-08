/**
 * Tests for createLogger — the timestamped run-log + event-marker writer.
 * Run with: npx vitest run packages/orchestrator/src/log.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './log';

let stateDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'logger-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  stdoutSpy.mockRestore();
  await rm(stateDir, { recursive: true, force: true });
});

const ISO_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /;

describe('createLogger', () => {
  it('creates the logs dir and writes timestamped lines to run.log + stdout', async () => {
    const logger = createLogger(stateDir);
    expect(existsSync(join(stateDir, 'logs'))).toBe(true);
    logger.log('hello world');
    const runLog = await readFile(join(stateDir, 'logs', 'run.log'), 'utf8');
    expect(runLog).toMatch(ISO_LINE);
    expect(runLog.trimEnd()).toMatch(/\] hello world$/);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('appends successive log lines', async () => {
    const logger = createLogger(stateDir);
    logger.log('first');
    logger.log('second');
    const runLog = await readFile(join(stateDir, 'logs', 'run.log'), 'utf8');
    expect(runLog.trimEnd().split('\n')).toHaveLength(2);
  });

  it('notifyEvent writes an event-marker file AND an EVENT line to run.log', async () => {
    const logger = createLogger(stateDir);
    logger.notifyEvent('feature-done', 'F-001');
    const eventLog = await readFile(join(stateDir, 'events', 'feature-done.log'), 'utf8');
    expect(eventLog.trimEnd()).toMatch(/\] F-001$/);
    const runLog = await readFile(join(stateDir, 'logs', 'run.log'), 'utf8');
    expect(runLog).toContain('EVENT feature-done: F-001');
  });

  it('notifyEvent with no body still logs the bare event', async () => {
    const logger = createLogger(stateDir);
    logger.notifyEvent('boot');
    const runLog = await readFile(join(stateDir, 'logs', 'run.log'), 'utf8');
    expect(runLog).toContain('EVENT boot');
    expect(runLog).not.toContain('EVENT boot:');
  });
});
