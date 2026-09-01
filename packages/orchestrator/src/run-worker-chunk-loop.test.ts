import { describe, test, expect } from 'vitest';
import type { HarnessConfig } from './types';
import { shouldUseWorkerChunkLoop } from './run-worker-chunk-loop.js';

const cfg = (over: Record<string, unknown> = {}): HarnessConfig => over as HarnessConfig;

describe('shouldUseWorkerChunkLoop — retired invoke-once route', () => {
  test('always selects ordinary invoke, including for stale default/true config', () => {
    for (const role of ['worker', 'validator', 'director', 'debugger', 'scoper']) {
      expect(shouldUseWorkerChunkLoop(role, cfg())).toBe(false);
      expect(shouldUseWorkerChunkLoop(role, cfg({ parallelWorkers: { useChunkLoop: true } }))).toBe(false);
      expect(shouldUseWorkerChunkLoop(role, cfg({ parallelWorkers: { useChunkLoop: false } }))).toBe(false);
    }
  });
});
