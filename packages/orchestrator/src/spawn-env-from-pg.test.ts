/**
 * spawn-env-from-pg — decrypted search-provider credentials → spawn env map.
 *
 * The PG seam (the OrchestratorPg tagged template) is stubbed with an
 * in-memory credentials table. The production cipher is pgcrypto's
 * pgp_sym_decrypt and runs INSIDE Postgres — the module's only crypto
 * surface is the SQL it sends — so the fake reproduces pgcrypto's contract
 * with a genuinely reversible authenticated cipher (AES-256-GCM keyed off
 * the passphrase): the round-trip test decrypts real ciphertext produced
 * with the test key, and a wrong key / corrupt payload fails authentication
 * and throws, exactly like pgcrypto's "Wrong key or corrupt data". What this
 * unit proves is the module's side: key resolution (env var → key file →
 * none), verbatim key binding, workspace scoping via the RLS GUC + WHERE,
 * payload filtering, and every graceful return-{} failure path.
 *
 * Run: npx vitest run src/spawn-env-from-pg.test.ts
 */
import { describe, test, beforeEach, afterEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// The module resolves KEY_FILE = join(homedir(), '.papercusp', 'db-encryption-key')
// at import time. Point HOME at an empty temp dir BEFORE importing so a real
// key file on the dev box can never leak into these tests, then restore.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = mkdtempSync(join(tmpdir(), 'spawn-env-pg-'));
process.env.HOME = TMP_HOME;
const { buildSearchProviderSpawnEnv } = await import('./spawn-env-from-pg');
if (ORIGINAL_HOME === undefined) delete process.env.HOME;
else process.env.HOME = ORIGINAL_HOME;

const KEY_FILE = join(TMP_HOME, '.papercusp', 'db-encryption-key');
const ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY';
const ORIGINAL_KEY = process.env[ENV_VAR];

beforeEach(() => {
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = ORIGINAL_KEY;
  rmSync(KEY_FILE, { force: true });
});

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// --- pgcrypto stand-in: real encrypt/decrypt, decrypt-or-throw like pgp_sym_* ---

function deriveKey(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase).digest();
}

function pgpSymEncrypt(plaintext: string, passphrase: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function pgpSymDecrypt(ciphertext: Buffer, passphrase: string): string {
  // 12B iv + 16B tag minimum — a shorter (malformed) buffer would hand
  // setAuthTag a clamped short tag, tripping DEP0182 instead of a clean throw.
  if (ciphertext.length < 28) throw new Error('pgp_sym_decrypt: ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase), ciphertext.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAuthTag(ciphertext.subarray(12, 28));
  // Wrong key or corrupt data → authentication failure → throws, like pgcrypto.
  return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8');
}

// --- fake PG client over an in-memory credentials table ---

interface CredRow {
  workspace_id: string;
  payload_ct: Buffer | null;
  payload: unknown;
}

interface MockState {
  rows: CredRow[];
  queries: string[];
  values: unknown[][];
}

function makeMockPg(rows: CredRow[] = []): {
  pg: (template: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>;
  state: MockState;
} {
  const state: MockState = { rows, queries: [], values: [] };
  const pg = async (template: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = template.join('?');
    state.queries.push(sql);
    state.values.push(vals);
    if (/set_config\('app\.workspace_id'/.test(sql)) {
      return [{ set_config: vals[0] }];
    }
    if (/FROM harness_shared\.operator_search_provider_credentials/.test(sql)) {
      const [key, workspaceId] = vals as [string, string];
      const row = state.rows.find((r) => r.workspace_id === workspaceId);
      if (!row) return [];
      // Emulate the CASE: decrypt payload_ct with the BOUND key (throws on
      // mismatch/corruption), else fall back to the legacy plaintext payload.
      const plaintext =
        row.payload_ct !== null
          ? (JSON.parse(pgpSymDecrypt(row.payload_ct, key)) as unknown)
          : row.payload;
      return [{ plaintext }];
    }
    return [];
  };
  return { pg, state };
}

const encryptedRow = (workspaceId: string, payload: unknown, passphrase: string): CredRow => ({
  workspace_id: workspaceId,
  payload_ct: pgpSymEncrypt(JSON.stringify(payload), passphrase),
  payload: null,
});

describe('buildSearchProviderSpawnEnv', () => {
  test('round-trips credentials encrypted with the test key (env-var key, bound verbatim)', async () => {
    process.env[ENV_VAR] = 'test-key-123';
    const creds = { TAVILY_API_KEY: 'tvly-abc', EXA_API_KEY: 'exa-def' };
    const mock = makeMockPg([encryptedRow('ws-1', creds, 'test-key-123')]);

    const env = await buildSearchProviderSpawnEnv(mock.pg, 'ws-1');
    assert.deepEqual(env, creds);

    // Query #2 is the credentials SELECT: the env key is the decrypt
    // parameter and the workspace id is the WHERE parameter.
    assert.equal(mock.state.values[1][0], 'test-key-123');
    assert.equal(mock.state.values[1][1], 'ws-1');
  });

  test('sets the RLS GUC transactionally and scopes rows to the requested workspace', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([
      encryptedRow('ws-a', { A_KEY: 'a' }, 'k'),
      encryptedRow('ws-b', { B_KEY: 'b' }, 'k'),
    ]);

    const env = await buildSearchProviderSpawnEnv(mock.pg, 'ws-b');
    assert.deepEqual(env, { B_KEY: 'b' });

    // First statement is the set_config('app.workspace_id', $1, true) GUC set.
    assert.match(mock.state.queries[0], /set_config\('app\.workspace_id', \?, true\)/);
    assert.deepEqual(mock.state.values[0], ['ws-b']);
  });

  test('filters non-string and empty-string payload entries out of the env map', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([
      encryptedRow(
        'ws-1',
        { GOOD: 'value', EMPTY: '', NUM: 42, NIL: null, OBJ: { nested: true } },
        'k',
      ),
    ]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), { GOOD: 'value' });
  });

  test('falls back to the legacy plaintext payload when payload_ct is NULL', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([
      { workspace_id: 'ws-1', payload_ct: null, payload: { LEGACY_KEY: 'plain' } },
    ]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), { LEGACY_KEY: 'plain' });
  });

  test('no resolvable key (env unset, no key file) → {} without ever touching PG', async () => {
    const mock = makeMockPg([encryptedRow('ws-1', { K: 'v' }, 'whatever')]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
    assert.equal(mock.state.queries.length, 0);
  });

  test('reads the key from ~/.papercusp/db-encryption-key (trimmed) when env is unset', async () => {
    mkdirSync(join(TMP_HOME, '.papercusp'), { recursive: true });
    writeFileSync(KEY_FILE, 'file-key-9\n', 'utf8'); // trailing newline must be trimmed

    const creds = { FILE_KEYED: 'yes' };
    const mock = makeMockPg([encryptedRow('ws-1', creds, 'file-key-9')]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), creds);
    assert.equal(mock.state.values[1][0], 'file-key-9');
  });

  test('wrong key → decryption failure is swallowed, returns {}', async () => {
    process.env[ENV_VAR] = 'wrong-key';
    const mock = makeMockPg([encryptedRow('ws-1', { K: 'v' }, 'right-key')]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
  });

  test('malformed ciphertext → decryption failure is swallowed, returns {}', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([
      { workspace_id: 'ws-1', payload_ct: Buffer.from('not real ciphertext at all'), payload: null },
    ]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
  });

  test('PG error (e.g. table missing) → {} (best-effort, never throws)', async () => {
    process.env[ENV_VAR] = 'k';
    const pg = async (): Promise<Array<Record<string, unknown>>> => {
      throw new Error('relation "harness_shared.operator_search_provider_credentials" does not exist');
    };
    assert.deepEqual(await buildSearchProviderSpawnEnv(pg, 'ws-1'), {});
  });

  test('no credentials row for the workspace → {}', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([encryptedRow('ws-other', { K: 'v' }, 'k')]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
  });

  test('payload decrypts to a non-object (jsonb string scalar) → {}', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([encryptedRow('ws-1', 'just-a-string', 'k')]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
  });

  test('NULL plaintext (no payload_ct AND no payload) → {}', async () => {
    process.env[ENV_VAR] = 'k';
    const mock = makeMockPg([{ workspace_id: 'ws-1', payload_ct: null, payload: null }]);
    assert.deepEqual(await buildSearchProviderSpawnEnv(mock.pg, 'ws-1'), {});
  });
});
