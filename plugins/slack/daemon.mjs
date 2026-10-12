// Slack provider daemon for Papercusp.
//
// Cupboard-installed providers run as sandboxed daemons (runtime.kind "daemon"): no network, no host
// files, no credentials. This process speaks the provider daemon protocol — newline-delimited
// JSON-RPC 2.0 on stdin/stdout (PROVIDER_DAEMON_METHODS in @papercusp/plugin-sdk):
//   host → daemon: papercup.ping, provider.describe, provider.syncPage, provider.invoke
//   daemon → host: host.fetch { callToken, source, request } — valid only during the call that
//   issued the callToken, and the host injects the bot token for slack.com itself.
// All Slack logic lives in provider.mjs so it can be tested without a process.
import fs from 'node:fs';
import readline from 'node:readline';
import { invokeCapability, syncPage } from './provider.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('./papercusp.json', import.meta.url), 'utf8'));
const DESCRIPTOR = manifest.provider;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

let nextId = 1;
const pending = new Map();

function hostFetch(callToken, source, request) {
  return new Promise((resolve, reject) => {
    const id = `d${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method: 'host.fetch', params: { callToken, source, request } });
  });
}

async function handle(method, params) {
  if (method === 'papercup.ping') return 'pong';
  if (method === 'provider.describe') return DESCRIPTOR;
  // New messages arrive over the host-held socket (ingress.normalize); syncPage backfills an
  // organization source's channel history and refreshes who may read each channel.
  if (method === 'provider.syncPage') {
    const request = params?.request ?? {};
    const callToken = params?.callToken;
    return syncPage(request, (fetchRequest) => hostFetch(callToken, request.source, fetchRequest));
  }
  if (method === 'provider.invoke') {
    const request = params?.request ?? {};
    const callToken = params?.callToken;
    return invokeCapability(request, (fetchRequest) => hostFetch(callToken, request.source, fetchRequest));
  }
  const err = new Error(`method not found: ${method}`);
  err.code = -32601;
  throw err;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;
  if (message.method === undefined) {
    // A reply to one of our host.fetch requests.
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      const err = new Error(message.error.message ?? 'host.fetch failed');
      err.data = message.error.data;
      waiter.reject(err);
    } else {
      waiter.resolve(message.result);
    }
    return;
  }
  if (message.id === undefined) return; // a notification; this provider takes none
  Promise.resolve()
    .then(() => handle(message.method, message.params))
    .then(
      (result) => send({ jsonrpc: '2.0', id: message.id, result }),
      (error) =>
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: typeof error?.code === 'number' ? error.code : -32000,
            message: String(error?.message ?? error),
            ...(error?.data ? { data: error.data } : {}),
          },
        }),
    );
});
