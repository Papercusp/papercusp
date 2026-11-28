import { mkdtemp, open, rm, watch } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Codex exec writes JSONL synchronously. A regular file keeps fd 1 writable
 * independently of pipe capacity, including when a descendant sets O_NONBLOCK.
 * The reader has its own file offset. Notifications only wake it; the file holds
 * the bytes across coalesced notifications and the producer's final write.
 */
export async function withCodexStdout<T>(
  consume: (bytes: Buffer) => void,
  run: (fd: number, readFailure: AbortSignal) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'papercusp-codex-stdout-'));
  try {
    const path = join(dir, 'events');
    await using writer = await open(path, 'ax', 0o600);
    await using reader = await open(path, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const drain = async () => {
      for (;;) {
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        consume(Buffer.from(buffer.subarray(0, bytesRead)));
      }
    };

    const stop = new AbortController();
    const failure = new AbortController();
    const follow = async () => {
      try {
        for await (const _change of watch(path, { signal: stop.signal })) await drain();
      } catch (error) {
        if (!(stop.signal.aborted && error instanceof Error && error.name === 'AbortError')) {
          failure.abort(error);
        }
      }
    };
    const following = follow();
    try {
      return await run(writer.fd, failure.signal);
    } finally {
      stop.abort();
      await following;
      await drain();
      failure.signal.throwIfAborted();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
