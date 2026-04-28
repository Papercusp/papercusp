// Forked from @electric-sql/pglite-socket@0.1.5 (Apache-2.0).
//
// Difference from upstream: per-handler **batch stickiness**. Upstream
// pops messages off a single shared FIFO queue; that interleaves
// messages from different socket clients onto the same pglite backend.
// The unnamed prepared statement (used by postgres-js when prepare:false)
// is GLOBAL inside pglite, so when client A sends `Parse "" ...` and
// client B sends `Parse "" ...` concurrently, B's Parse can overwrite
// A's before A's subsequent `Bind ""` runs. Bind then fails with:
//
//   bind message supplies 1 parameters, but prepared statement "" requires 0
//
// Reproduction: 50 concurrent SELECT $1 queries through a postgres-js
// pool with max=8 and prepare:false → ~10–20% failure rate.
//
// Fix: track `currentBatchHandlerId`. Once we begin processing a Parse/
// Bind/Execute/Describe/Close from handler X, keep popping X's messages
// (skipping over interleaved messages from other handlers) until we see
// X's Sync, then resume FIFO. Postgres protocol guarantees Sync ends a
// batch, so this respects the wire-protocol contract — it just stops
// the multiplexer from corrupting state across batches.
//
// Other than the batching fix, this is a line-by-line port of upstream
// (no .ts → .js conversion deltas of substance; types stripped, JSDoc
// added where useful for callers).
import { createServer } from 'net';

export const CONNECTION_QUEUE_TIMEOUT = 60_000;

// Postgres wire protocol message-type bytes (frontend → backend).
const MSG_PARSE = 0x50;        // 'P'
const MSG_BIND = 0x42;         // 'B'
const MSG_EXECUTE = 0x45;      // 'E'
const MSG_DESCRIBE = 0x44;     // 'D'
const MSG_CLOSE = 0x43;        // 'C'
const MSG_SYNC = 0x53;         // 'S'
const MSG_FLUSH = 0x48;        // 'H'

function isExtendedQueryStart(type) {
  return (
    type === MSG_PARSE ||
    type === MSG_BIND ||
    type === MSG_EXECUTE ||
    type === MSG_DESCRIBE ||
    type === MSG_CLOSE ||
    type === MSG_FLUSH
  );
}

class QueryQueueManager {
  constructor(db, debug = false) {
    this.queue = [];
    this.processing = false;
    this.db = db;
    this.debug = debug;
    this.lastHandlerId = null;
    // Batch stickiness: when set, only this handler's messages are
    // dequeued. Cleared when the handler's Sync is processed.
    this.batchHandlerId = null;
  }

  log(msg, ...args) {
    if (this.debug) console.log(`[QueryQueueManager] ${msg}`, ...args);
  }

  enqueue(handlerId, message, onData) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        handlerId,
        message,
        resolve,
        reject,
        timestamp: Date.now(),
        onData,
      });
      this.log(`enqueued from handler #${handlerId}, queue=${this.queue.length}`);
      if (!this.processing) this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      let query;

      // Priority 1: in-progress extended-query batch from one handler.
      if (this.batchHandlerId !== null) {
        const i = this.queue.findIndex((q) => q.handlerId === this.batchHandlerId);
        if (i === -1) {
          // The batch handler hasn't queued more messages yet; yield until
          // its next handleData call wakes us.
          this.log(`batch from #${this.batchHandlerId} stalled; releasing queue`);
          this.processing = false;
          return;
        }
        query = this.queue.splice(i, 1)[0];
      }
      // Priority 2: open transaction sticky to one handler (upstream behavior).
      else if (this.db.isInTransaction() && this.lastHandlerId) {
        const i = this.queue.findIndex((q) => q.handlerId === this.lastHandlerId);
        if (i === -1) {
          this.log(`transaction open but no queued query from handler ${this.lastHandlerId}`);
          query = null;
        } else {
          query = this.queue.splice(i, 1)[0];
        }
      }
      // Default: FIFO.
      else {
        query = this.queue.shift();
      }

      if (!query) break;

      // Detect message type to decide whether this opens or closes a batch.
      // Untyped startup messages (length-prefix only) are never extended-query.
      const msgType = query.message[0];
      if (msgType === MSG_SYNC) {
        // Close the batch AFTER processing this Sync.
      } else if (isExtendedQueryStart(msgType) && this.batchHandlerId === null) {
        this.batchHandlerId = query.handlerId;
        this.log(`opening batch sticky to #${query.handlerId} (msg=${String.fromCharCode(msgType)})`);
      }

      const waited = Date.now() - query.timestamp;
      this.log(`processing #${query.handlerId} msg=${String.fromCharCode(msgType || 0)} (waited ${waited}ms)`);

      let result = 0;
      try {
        await this.db.runExclusive(async () => {
          return await this.db.execProtocolRawStream(query.message, {
            onRawData: (data) => {
              result += data.length;
              query.onData(data);
            },
          });
        });
      } catch (err) {
        this.log(`#${query.handlerId} failed:`, err);
        query.reject(err);
        return;
      }

      // After Sync, release batch stickiness so other handlers can run.
      if (msgType === MSG_SYNC && this.batchHandlerId === query.handlerId) {
        this.log(`closing batch from #${query.handlerId}`);
        this.batchHandlerId = null;
      }

      this.lastHandlerId = query.handlerId;
      query.resolve(result);
    }

    this.processing = false;
  }

  getQueueLength() {
    return this.queue.length;
  }

  clearQueueForHandler(handlerId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => {
      if (q.handlerId === handlerId) {
        q.reject(new Error('Handler disconnected'));
        return false;
      }
      return true;
    });
    if (this.batchHandlerId === handlerId) this.batchHandlerId = null;
    const removed = before - this.queue.length;
    if (removed > 0) this.log(`cleared ${removed} queries for #${handlerId}`);
  }

  async clearTransactionIfNeeded(handlerId) {
    if (this.db.isInTransaction() && this.lastHandlerId === handlerId) {
      await this.db.exec('ROLLBACK');
      this.lastHandlerId = null;
      await this.processQueue();
    }
  }
}

export class PGLiteSocketHandler extends EventTarget {
  static nextHandlerId = 1;

  constructor(opts) {
    super();
    this.queryQueue = opts.queryQueue;
    this.socket = null;
    this.active = false;
    this.closeOnDetach = opts.closeOnDetach ?? false;
    this.inspect = opts.inspect ?? false;
    this.debug = opts.debug ?? false;
    this.id = PGLiteSocketHandler.nextHandlerId++;
    this.messageBuffer = Buffer.alloc(0);
    this.idleTimer = undefined;
    this.idleTimeout = opts.idleTimeout ?? 0;
    this.lastActivityTime = Date.now();
  }

  get handlerId() {
    return this.id;
  }

  log(msg, ...args) {
    if (this.debug) console.log(`[PGLiteSocketHandler#${this.id}] ${msg}`, ...args);
  }

  async attach(socket) {
    if (this.socket) throw new Error('Socket already attached');
    this.socket = socket;
    this.active = true;
    this.lastActivityTime = Date.now();
    socket.setNoDelay(true);
    if (this.idleTimeout > 0) this.resetIdleTimer();

    socket.on('data', (data) => {
      this.lastActivityTime = Date.now();
      this.resetIdleTimer();
      setImmediate(async () => {
        try { await this.handleData(data); } catch (e) { this.handleError(e); }
      });
    });
    socket.on('error', (e) => setImmediate(() => this.handleError(e)));
    socket.on('close', () => setImmediate(() => this.handleClose()));
    return this;
  }

  resetIdleTimer() {
    if (this.idleTimeout <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.handleError(new Error('Idle timeout'));
    }, this.idleTimeout);
  }

  async detach(close) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.queryQueue.clearQueueForHandler(this.id);
    await this.queryQueue.clearTransactionIfNeeded(this.id);
    if (!this.socket) return this;
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    if (close ?? this.closeOnDetach) {
      if (this.socket.writable) {
        try { this.socket.end(); this.socket.destroy(); } catch {}
      }
    }
    this.socket = null;
    this.active = false;
    this.messageBuffer = Buffer.alloc(0);
    return this;
  }

  get isAttached() { return this.socket !== null; }

  async handleData(data) {
    if (!this.socket || !this.active) return 0;
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);
    let totalProcessed = 0;
    while (this.messageBuffer.length > 0) {
      let messageLength = 0;
      let isComplete = false;
      if (this.messageBuffer.length >= 4) {
        const firstInt = this.messageBuffer.readInt32BE(0);
        if (this.messageBuffer.length >= 8) {
          const secondInt = this.messageBuffer.readInt32BE(4);
          if (secondInt === 196608 || secondInt === 0x00030000) {
            messageLength = firstInt;
            isComplete = this.messageBuffer.length >= messageLength;
          }
        }
        if (!isComplete && this.messageBuffer.length >= 5) {
          const msgLength = this.messageBuffer.readInt32BE(1);
          messageLength = 1 + msgLength;
          isComplete = this.messageBuffer.length >= messageLength;
        }
      }
      if (!isComplete || messageLength === 0) break;
      const message = this.messageBuffer.slice(0, messageLength);
      this.messageBuffer = this.messageBuffer.slice(messageLength);
      if (!this.active || !this.socket) break;

      let socketWriteError;
      await this.queryQueue.enqueue(this.id, new Uint8Array(message), (data) => {
        if (data.length > 0 && this.socket && this.socket.writable && this.active) {
          this.socket.write(Buffer.from(data), (err) => {
            if (err) socketWriteError = err;
          });
        }
        totalProcessed += data.length;
      });
      if (socketWriteError) throw socketWriteError;
    }
    this.dispatchEvent(new CustomEvent('data', {
      detail: { incoming: data.length, outgoing: totalProcessed },
    }));
    return totalProcessed;
  }

  handleError(err) {
    if (!this.active) return;
    this.active = false;
    this.dispatchEvent(new CustomEvent('error', { detail: err }));
    this.detach(true);
  }

  handleClose() {
    this.active = false;
    this.dispatchEvent(new CustomEvent('close'));
    this.detach(false);
  }
}

export class PGLiteSocketServer extends EventTarget {
  constructor(opts) {
    super();
    this.db = opts.db;
    if (opts.path) {
      this.path = opts.path;
    } else {
      this.port = typeof opts.port === 'number' ? opts.port : 5432;
      this.host = opts.host || '127.0.0.1';
    }
    this.inspect = opts.inspect ?? false;
    this.debug = opts.debug ?? false;
    this.idleTimeout = opts.idleTimeout ?? 0;
    this.maxConnections = opts.maxConnections ?? 32;
    this.handlers = new Set();
    this.queryQueue = new QueryQueueManager(this.db, this.debug);
    this.server = null;
    this.active = false;
  }

  log(msg, ...args) {
    if (this.debug) console.log(`[PGLiteSocketServer] ${msg}`, ...args);
  }

  async start() {
    if (this.server) throw new Error('Socket server already started');
    await this.db.waitReady;
    this.active = true;
    this.server = createServer((s) => setImmediate(() => this.handleConnection(s)));
    this.server.maxConnections = this.maxConnections;
    return new Promise((resolve, reject) => {
      this.server.on('error', (err) => {
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
        if (!this.active) reject(err);
      });
      const onListening = () => {
        if (!this.path) {
          const addr = this.server.address();
          if (addr && typeof addr === 'object') this.port = addr.port;
        }
        this.dispatchEvent(new CustomEvent('listening', {
          detail: this.path ? { path: this.path } : { port: this.port, host: this.host },
        }));
        resolve();
      };
      if (this.path) this.server.listen(this.path, onListening);
      else this.server.listen(this.port, this.host, onListening);
    });
  }

  async stop() {
    this.active = false;
    for (const h of this.handlers) h.detach(true);
    this.handlers.clear();
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        this.dispatchEvent(new CustomEvent('close'));
        resolve();
      });
    });
  }

  async handleConnection(socket) {
    if (!this.active) {
      try { socket.end(); } catch {}
      return;
    }
    if (this.handlers.size >= this.maxConnections) {
      socket.write(Buffer.from('Too many connections\n'));
      socket.end();
      return;
    }
    const handler = new PGLiteSocketHandler({
      queryQueue: this.queryQueue,
      closeOnDetach: true,
      inspect: this.inspect,
      debug: this.debug,
      idleTimeout: this.idleTimeout,
    });
    this.handlers.add(handler);
    handler.addEventListener('close', () => this.handlers.delete(handler));
    try {
      await handler.attach(socket);
      this.dispatchEvent(new CustomEvent('connection', {
        detail: { clientAddress: socket.remoteAddress, clientPort: socket.remotePort },
      }));
    } catch (err) {
      this.handlers.delete(handler);
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      try { socket.end(); } catch {}
    }
  }

  getStats() {
    return {
      activeConnections: this.handlers.size,
      queuedQueries: this.queryQueue.getQueueLength(),
      maxConnections: this.maxConnections,
    };
  }
}
