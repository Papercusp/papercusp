/**
 * connect-retry — unit tests (no DB needed; pure retry-loop logic).
 * EI-9279.
 */
import { describe, expect, it, vi } from 'vitest';
import { isRetriableConnectionSetupError, retryBeforeCallbackStarts } from './connect-retry';

describe('isRetriableConnectionSetupError', () => {
  it('matches a CONNECTION_CLOSED code', () => {
    expect(isRetriableConnectionSetupError({ code: 'CONNECTION_CLOSED' })).toBe(true);
  });

  it('matches a CONNECT_TIMEOUT code', () => {
    expect(isRetriableConnectionSetupError({ code: 'CONNECT_TIMEOUT' })).toBe(true);
  });

  it('matches on message when code is absent (postgres-js message fallback)', () => {
    expect(
      isRetriableConnectionSetupError({ message: 'write CONNECTION_CLOSED 127.0.0.1:6432' }),
    ).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isRetriableConnectionSetupError({ code: '23505', message: 'duplicate key' })).toBe(false);
  });

  it('does not match null/undefined', () => {
    expect(isRetriableConnectionSetupError(null)).toBe(false);
    expect(isRetriableConnectionSetupError(undefined)).toBe(false);
  });
});

describe('retryBeforeCallbackStarts', () => {
  const noSleep = () => Promise.resolve();

  it('returns the result on first-try success', async () => {
    const out = await retryBeforeCallbackStarts(async (markStarted) => {
      markStarted();
      return 42;
    });
    expect(out).toBe(42);
  });

  it('retries a CONNECTION_CLOSED thrown BEFORE markStarted(), then succeeds', async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const out = await retryBeforeCallbackStarts(
      async (markStarted) => {
        attempts++;
        if (attempts < 3) {
          // Fails before the caller's own work starts — safe to retry.
          throw { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };
        }
        markStarted();
        return 'ok';
      },
      { sleep: noSleep, onRetry },
    );
    expect(out).toBe('ok');
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries once markStarted() has fired, even on a retriable-looking error', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async (markStarted) => {
          attempts++;
          markStarted();
          // Simulate a connection blip AFTER the caller's own query began —
          // must propagate untouched, never re-run (could double-apply a write).
          throw { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    expect(attempts).toBe(1);
  });

  it('does not retry a non-classified error, even before markStarted()', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async () => {
          attempts++;
          throw new Error('boom: unrelated failure');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('boom: unrelated failure');
    expect(attempts).toBe(1);
  });

  it('gives up after `retries` attempts and rethrows the last error', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async () => {
          attempts++;
          throw { code: 'CONNECTION_CLOSED' };
        },
        { sleep: noSleep, retries: 2 },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('backs off with the configured sleep between retries', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await retryBeforeCallbackStarts(
      async (markStarted) => {
        attempts++;
        if (attempts < 2) throw { code: 'CONNECT_TIMEOUT' };
        markStarted();
        return 'done';
      },
      {
        backoffMs: 150,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(sleeps).toEqual([150]); // backoffMs * attempt(1)
  });
});
