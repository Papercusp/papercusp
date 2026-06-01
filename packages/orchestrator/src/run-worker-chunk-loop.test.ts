import { describe, test, expect } from 'vitest';
import type { HarnessConfig } from './types';
import { shouldUseWorkerChunkLoop } from './run-worker-chunk-loop.js';

const cfg = (over: Record<string, unknown> = {}): HarnessConfig => over as HarnessConfig;

describe('shouldUseWorkerChunkLoop — when the DBOS worker step runs the chunk loop (#2)', () => {
  test('role=worker + useChunkLoop default(true) → true (the canonical worker model)', () => {
    expect(shouldUseWorkerChunkLoop('worker', cfg())).toBe(true);
  });

  test('role=worker + explicit useChunkLoop:false → false (legacy single-shot worker)', () => {
    expect(shouldUseWorkerChunkLoop('worker', cfg({ parallelWorkers: { useChunkLoop: false } }))).toBe(false);
  });

  test('non-worker roles never use the chunk loop, even under useChunkLoop:true', () => {
    expect(shouldUseWorkerChunkLoop('validator', cfg())).toBe(false);
    expect(shouldUseWorkerChunkLoop('director', cfg())).toBe(false);
    expect(shouldUseWorkerChunkLoop('debugger', cfg())).toBe(false);
    expect(shouldUseWorkerChunkLoop('scoper', cfg())).toBe(false);
  });
});
