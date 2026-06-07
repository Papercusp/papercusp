/**
 * Per-spawn MCP config: write a `.mcp.json` so OMP discovers the
 * Papercusp MCP host with the seven per-spawn URL params baked in.
 *
 * OMP's MCP discovery is path-based (no env-var override exists for an
 * explicit MCP config path), so this module does the dance:
 *
 *   1. Save any existing `<cwd>/.mcp.json` to a sibling backup.
 *   2. Write our spawn-specific `.mcp.json`.
 *   3. After the spawn exits, delete ours and restore the backup.
 *
 * Workers running in parallel must use distinct cwds (worktrees) — two
 * spawns sharing a cwd would race-clobber each other's `.mcp.json`. The
 * orchestrator's existing branch-isolation worktree pattern provides
 * that automatically.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (D4: tool discovery
 * for OMP — single mcpServers entry, seven URL query params).
 */

import { createHmac } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import postgres from 'postgres';

/** Construction inputs — all seven per-spawn URL params plus the host URL. */
export interface SpawnMcpConfigInput {
  /**
   * Base URL of the operator's MCP HTTP/SSE endpoint.
   * Default `http://localhost:3070/api/sse`. Override via the
   * `PAPERCUSP_OPERATOR_URL` env var if the operator runs on a
   * different host:port.
   */
  operatorUrl?: string;
  /** Harness slug. Required. */
  harnessSlug: string;
  /** Workspace ID. Required. */
  workspaceId: string;
  /** Calling agent role. Required. */
  role: string;
  /** Orchestrator run ID. Required. */
  runId: string;
  /** Unique per-spawn ID. Required. */
  spawnId: string;
  /** Feature ID, if the spawn is feature-scoped (workers, validators, debuggers). */
  featureId?: string | null;
  /** Chunk ID, if the spawn is chunk-scoped (worker chunks). */
  chunkId?: string | null;
  /** Parent spawn ID, set when this spawn was created by another agent's `orchestrator.spawn` call. */
  parentSpawnId?: string | null;
  /**
   * Stable coordination owner id for the spawn (THE UMBILICAL voice-gap fix).
   * Baked as the signed URL's `client=` param so the operator's
   * resolveAgentIdentity() attributes the child's coord:* / plans:* / improvements:*
   * writes to a STABLE id (the operator's durable `s-…` spawnId) instead of throwing
   * "no attributable identity". Distinct from `spawnId` (which the legacy path
   * regenerated per boot); when set this is the operator-assigned spawned_agents
   * owner, so a bee's messages, file locks, and fleet:cancel target all line up.
   * Optional — pipeline roles (worker/scoper/…) that never coord can omit it.
   */
  clientId?: string | null;
}

// Default port flips on NODE_ENV: dev operator runs on :3055, prod on :3070.
// Override with PAPERCUSP_OPERATOR_URL when neither default applies (CI,
// Tauri sidecar with custom port, etc).
const DEFAULT_OPERATOR_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:3055/api/sse'
    : 'http://localhost:3070/api/sse';

/** Build the JSON-serializable mcp.json contents for a spawn. */
export function buildSpawnMcpConfig(input: SpawnMcpConfigInput): {
  mcpServers: Record<string, { type: 'http'; url: string }>;
} {
  const base = input.operatorUrl ?? process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL;
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  // Stable coord owner id (operator's `s-…` spawnId). See buildSpawnUrlParams.
  if (input.clientId) params.set('client', input.clientId);
  return {
    mcpServers: {
      papercusp: {
        // `type: 'http'` is required by claude-code's --mcp-config schema.
        // omp accepts it too — the operator brain's converse path already
        // ships an explicit `type:'http'` server through omp — so emitting
        // it unconditionally keeps ONE config shape that both backends load.
        type: 'http',
        url: `${base}?${params.toString()}`,
      },
    },
  };
}

const FILENAME = '.mcp.json';
const BACKUP_SUFFIX = '.papercusp.bak';

/**
 * Write a per-spawn `.mcp.json` to `cwd`, saving any existing file's
 * content. Returns a token the caller passes to `restoreSpawnMcp`.
 *
 * Writes are best-effort: if anything fails (permission, disk full),
 * we throw rather than silently spawn without our config — the agent
 * would then have built-in tools but no plugin tools, which is a
 * confusing partial state.
 */
export interface SpawnMcpHandle {
  /** Path of the written file. */
  path: string;
  /** Content of the file we displaced (null if there wasn't one). */
  prior: string | null;
  /** Path of our backup of the prior file (null if no prior). */
  backupPath: string | null;
}

export function writeSpawnMcp(cwd: string, input: SpawnMcpConfigInput): SpawnMcpHandle {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const config = buildSpawnMcpConfig(input);
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  // Mode 0600: stop a sibling worker on the same UID from `cat`-ing
  // this .mcp.json to steal the (signed, role-bearing) URL. Same-UID
  // root-equivalent code can still read it; this is friction, not
  // enforcement. See apps/operator/docs/spawn-signing-threat-model.md.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/**
 * Async variant — same as writeSpawnMcp but also signs the URL params
 * with the HMAC key stored at `harness_shared.operator_secrets`
 * (`spawn-signing-key`). Required by the operator's MCP route when
 * `PAPERCUSP_REQUIRE_SPAWN_SIG=1`; otherwise soft-warn but accept.
 *
 * Best-effort: if PG is unreachable or the key row is missing, falls
 * back to the unsigned URL and logs a warning. The operator side will
 * also warn — pair the two signals to spot transition issues.
 *
 * The operator subprocess that hosts the orchestrator inherits its
 * PG DSN via env (DATABASE_URL or PAPERCUSP_PG_DSN). If neither is
 * set we can't sign — that's the only case where we fall back.
 *
 * See: apps/operator/lib/spawn-signing.ts for the verification side.
 */
export async function writeSignedSpawnMcp(
  cwd: string,
  input: SpawnMcpConfigInput,
  opts: {
    ttlSec?: number;
    /**
     * If true, emit an unsigned URL with a console warning instead of
     * throwing when signing fails. Only safe when the operator is
     * running with PAPERCUSP_REQUIRE_SPAWN_SIG != '1' (soft-warn).
     * Default: false (strict — signing failure = spawn failure).
     */
    allowUnsigned?: boolean;
  } = {},
): Promise<SpawnMcpHandle> {
  const path = join(cwd, FILENAME);
  let prior: string | null = null;
  let backupPath: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    backupPath = `${path}${BACKUP_SUFFIX}`;
    renameSync(path, backupPath);
  }
  const base = input.operatorUrl ?? process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL;

  // ── Superuser-spawn mode ──────────────────────────────────────────────
  // An operator-initiated, loopback spawn (the /harness/:slug/invoke route)
  // sets PAPERCUSP_SPAWN_SU_BEARER. Connect via the `?superuser=1` door
  // (branch 1 in _mcp-handler.ts) instead of a signed spawn, so the spawned
  // coord-role agent carries the `isSuperuser` identity that
  // resolveAgentIdentity-gated tools (plans:promote, coord:*) require — a
  // plain signed spawn's ctx has none. Auth here is loopback + the bearer
  // (no URL `sig` needed; the superuser branch is checked before the sig one).
  const suBearer = process.env.PAPERCUSP_SPAWN_SU_BEARER;
  if (suBearer && suBearer.length > 0) {
    const su = new URLSearchParams();
    su.set('superuser', '1');
    su.set('harness', input.harnessSlug);
    su.set('workspace', input.workspaceId);
    su.set('client', input.spawnId); // per-spawn coord/lock owner label
    const config = {
      mcpServers: {
        papercusp: {
          type: 'http' as const,
          url: `${base}?${su.toString()}`,
          headers: { Authorization: `Bearer ${suBearer}` },
        },
      },
    };
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return { path, prior, backupPath };
  }

  const params = buildSpawnUrlParams(input);
  try {
    await signSpawnParams(params, opts.ttlSec ?? 24 * 60 * 60);
  } catch (err) {
    // Restore the prior .mcp.json (if any) so a half-written file
    // doesn't trip the next spawn's read-then-sign cycle.
    if (backupPath && existsSync(backupPath)) {
      try { renameSync(backupPath, path); } catch { /* best-effort */ }
    }
    // Strict mode is the default since 2026-05-11; an unsigned URL
    // would hard-reject at the operator with
    // `spawn_sig_missing_sig_required_mode` — agent boots, hits
    // its MCP endpoint, every tool call 4xxs, and from the user's
    // POV the agent silently does nothing. Failing loudly here
    // gives the caller a clear error to surface. To re-enable the
    // soft-warn fallback (PAPERCUSP_REQUIRE_SPAWN_SIG != '1' on
    // the operator), pass `allowUnsigned: true` from the caller —
    // see comment on opts. Without that, signing failures are
    // promoted to spawn failures.
    if (!opts.allowUnsigned) {
      throw new Error(
        `[spawn-mcp] signing failed and strict mode is the default; ` +
          `refusing to emit an unsigned URL. Underlying error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[spawn-mcp] signing failed (${err instanceof Error ? err.message : String(err)}); ` +
        'emitting unsigned URL (caller passed allowUnsigned=true).',
    );
  }
  const config = {
    // `type: 'http'` so claude-code's --mcp-config accepts it; omp loads
    // it too. See buildSpawnMcpConfig for the rationale.
    mcpServers: { papercusp: { type: 'http' as const, url: `${base}?${params.toString()}` } },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { path, prior, backupPath };
}

/** Handle for a per-spawn codex CODEX_HOME (cleaned up after the spawn). */
export interface SpawnCodexHomeHandle {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** The signed MCP URL written into config.toml (for logging). */
  mcpUrl: string;
  /** Remove the temp CODEX_HOME. Best-effort, idempotent. */
  cleanup(): void;
}

/**
 * codex equivalent of {@link writeSignedSpawnMcp}. codex has no
 * `.mcp.json` discovery and no `--mcp-config` flag — its MCP servers are
 * declared in `$CODEX_HOME/config.toml`. So we mint a per-spawn CODEX_HOME
 * tmpdir holding:
 *   - `config.toml` with `[mcp_servers.papercusp] url = "<signed URL>"` —
 *     the SAME signed, role-scoped URL the .mcp.json path uses; auth is the
 *     `sig` query param (verifySpawnParams), so NO bearer token is needed.
 *   - `auth.json` symlinked to `~/.codex/auth.json` so the ChatGPT OAuth
 *     login carries over (no API key).
 * Set `CODEX_HOME=<this>` on the spawn env; call `cleanup()` after exit.
 */
export async function writeSignedSpawnCodexHome(
  input: SpawnMcpConfigInput,
  opts: { ttlSec?: number } = {},
): Promise<SpawnCodexHomeHandle> {
  const base = input.operatorUrl ?? process.env.PAPERCUSP_OPERATOR_URL ?? DEFAULT_OPERATOR_URL;
  const params = buildSpawnUrlParams(input);
  await signSpawnParams(params, opts.ttlSec ?? 24 * 60 * 60);
  const mcpUrl = `${base}?${params.toString()}`;

  const codexHome = mkdtempSync(join(tmpdir(), 'codex-spawn-'));
  // Share the ChatGPT OAuth login (codex resolves auth from $CODEX_HOME/auth.json).
  try {
    const realAuth = join(homedir(), '.codex', 'auth.json');
    if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'));
  } catch { /* best-effort — codex surfaces an auth error if missing */ }
  // codex does NOT env-expand inside config.toml; the URL is fully baked
  // (incl. the sig), so no bearer_token_env_var is needed (unlike the
  // superuser codex-su home, which uses ?superuser=1 + a bearer).
  const toml = [
    '# Per-spawn codex MCP config (managed by spawn-mcp.ts writeSignedSpawnCodexHome).',
    '[mcp_servers.papercusp]',
    `url = "${mcpUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '',
  ].join('\n');
  writeFileSync(join(codexHome, 'config.toml'), toml, 'utf8');
  try { chmodSync(join(codexHome, 'config.toml'), 0o600); } catch { /* best-effort */ }

  return {
    codexHome,
    mcpUrl,
    cleanup() {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/** Handle for a per-spawn claude-code CLAUDE_CONFIG_DIR (cleaned up after the spawn). */
export interface SpawnClaudeConfigHandle {
  /**
   * Absolute path to set as the child's `CLAUDE_CONFIG_DIR`. An isolated
   * `.claude` carrying ONLY the credentials symlink — no `settings.json`
   * (⇒ no `enabledPlugins`) and no `plugins/` dir (⇒ no known marketplaces).
   */
  configDir: string;
  /** Remove the temp config dir. Best-effort, idempotent. */
  cleanup(): void;
}

/**
 * Mint a per-spawn, plugin-free `CLAUDE_CONFIG_DIR` for a claude-code spawn.
 *
 * Root cause (P-012, reproduced live on claude-code 2.1.161): claude-code
 * resolves an enabled plugin whose marketplace source is an external git repo
 * by `git clone --depth 1 --no-checkout <url> <tmp>` followed by
 * `git checkout <sha>` — and that checkout's work-tree is the git process's
 * **cwd**. When claude fails to pin that cwd to the temp clone, the cwd is the
 * spawned worker's cwd (itself a git repo), so the plugin's file tree
 * (`package.json` / `.mcp.json` / `README.md` / `.claude-plugin/…` / etc.) is
 * materialized into the worker's working directory via `O_WRONLY|O_CREAT|O_EXCL`
 * — the "full spawn writes empty config stubs" bug. It is a claude-code defect,
 * not ours (filed upstream); `DISABLE_AUTOUPDATER` does NOT gate it (that var
 * controls the binary self-updater; the marketplace refresh is gated by a
 * per-marketplace `autoUpdate` flag, default-true for official marketplaces).
 *
 * The fix on our side is to deny the worker any plugins/marketplaces to
 * resolve in the first place: point `CLAUDE_CONFIG_DIR` at a fresh dir that
 * carries only the auth symlink. With no `settings.json`/`plugins/`, claude-code
 * performs ZERO plugin/marketplace git activity during the spawn (verified: an
 * isolated config does 0 git execs / 0 temp clones / 0 cwd writes), so it cannot
 * check a plugin tree out into the worker cwd. This mirrors what the desktop
 * shell already does per-workspace (`workspaces.rs::link_workspace_credentials`
 * symlinks creds + gitconfig but NOT settings/plugins); here we extend the same
 * isolation to the dev / non-shared-operator path, where the worker would
 * otherwise inherit the engineer's full `~/.claude` (all enabled plugins).
 *
 * `realHome` is the spawn's effective HOME (post {@link resolveSpawnHome}); the
 * auth file is read from `<realHome>/.claude/.credentials.json`. **Symlinked,
 * not copied**, so an OAuth token refresh writes through to the real file — no
 * credential divergence (cf. the codex auth-copy hazard). A spawn whose home has
 * no credentials file simply runs unauthenticated, exactly as before.
 *
 * Set `CLAUDE_CONFIG_DIR=<this>` on the spawn env (and add it to the OS sandbox's
 * writable set, since claude writes session state under its config dir); call
 * `cleanup()` after exit.
 */
export function writeSpawnClaudeConfig(realHome: string): SpawnClaudeConfigHandle {
  const configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-spawn-'));
  // Share the user's Claude OAuth session (claude resolves auth from
  // $CLAUDE_CONFIG_DIR/.credentials.json) WITHOUT carrying its plugins.
  try {
    const realCreds = join(realHome, '.claude', '.credentials.json');
    if (existsSync(realCreds)) symlinkSync(realCreds, join(configDir, '.credentials.json'));
  } catch { /* best-effort — claude surfaces an auth error if missing */ }
  return {
    configDir,
    cleanup() {
      // Flight recorder: claude writes this spawn's session transcripts under
      // <configDir>/projects/** — the ONLY client-side record of MCP mount
      // failures / tool errors. Deleting them with the dir made the all-mute
      // 2026-06-06 re-fan batch undiagnosable post-mortem (zero coord writes,
      // zero transcripts, output_tail only). Preserve them durably first,
      // keyed by the durable spawn id, so a mute bee leaves evidence.
      try {
        const projectsDir = join(configDir, 'projects');
        if (existsSync(projectsDir)) {
          const spawnId = (process.env.PAPERCUSP_SPAWN_ID ?? '').trim();
          const root =
            process.env.PAPERCUSP_FLIGHT_RECORDER_DIR ||
            join(homedir(), '.papercusp', 'flight-recorder');
          const dest = join(root, spawnId || `unlabeled-${basename(configDir)}`);
          mkdirSync(dest, { recursive: true });
          cpSync(projectsDir, dest, { recursive: true });
        }
      } catch { /* best-effort — never block cleanup */ }
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/* ─── Signing (HMAC-SHA256 over canonical params) ─────────────────────
 * Duplicated in apps/operator/lib/spawn-signing.ts because the
 * orchestrator runs as a separate process and can't import from the
 * operator app directly. Keep the canonicalization rule in lockstep
 * with that file or signatures will mismatch.
 * ──────────────────────────────────────────────────────────────────── */

const SIGNED_PARAM_ALLOWLIST = new Set([
  'harness',
  'workspace',
  'role',
  'run',
  'spawn',
  'feature',
  'chunk',
  'parent_spawn',
  'client',
  'exp',
]);

interface KeyCache { buf: Buffer; rotatedAt: number; loadedAt: number; }
let __keyCache: KeyCache | null = null;

// Honor PG's authoritative rotated_at so a rotate on the operator
// invalidates this process's cache on its next read. Spawning is
// already a heavy op; one indexed PG read is in the noise. The
// 5-minute TTL is a safety net for when rotated_at can't be read.
async function loadSigningKey(): Promise<Buffer> {
  const dsn = process.env.DATABASE_URL ?? process.env.PAPERCUSP_PG_DSN;
  if (!dsn) throw new Error('no PG DSN in env (DATABASE_URL/PAPERCUSP_PG_DSN)');
  const sql = postgres(dsn);
  try {
    const rows = await sql<{ value_b64: string; rotated_at: Date }[]>`
      SELECT value_b64, rotated_at FROM harness_shared.operator_secrets
      WHERE name = 'spawn-signing-key' LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error('spawn-signing-key row missing — operator boots mint it on first verify call');
    }
    const rotatedAt = new Date(rows[0].rotated_at).getTime();
    if (
      __keyCache &&
      __keyCache.rotatedAt === rotatedAt &&
      Date.now() - __keyCache.loadedAt < 5 * 60 * 1000
    ) {
      return __keyCache.buf;
    }
    const buf = Buffer.from(rows[0].value_b64, 'base64');
    __keyCache = { buf, rotatedAt, loadedAt: Date.now() };
    return buf;
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

function canonicalizeForSign(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) throw new Error(`duplicate param: ${k}`);
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function signSpawnParams(params: URLSearchParams, ttlSec: number): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  params.set('exp', String(exp));
  params.delete('sig');
  const key = await loadSigningKey();
  const sig = createHmac('sha256', key).update(canonicalizeForSign(params)).digest('base64url');
  params.set('sig', sig);
}

function buildSpawnUrlParams(input: SpawnMcpConfigInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('harness', input.harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', input.runId);
  params.set('spawn', input.spawnId);
  if (input.featureId) params.set('feature', input.featureId);
  if (input.chunkId) params.set('chunk', input.chunkId);
  if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
  // THE UMBILICAL: the stable coord owner id (operator's `s-…` spawnId). It's in the
  // signed-param allowlist (`client`), so it's part of the HMAC — the operator
  // verifies it before trusting it as the child's coord identity. parseRequestContext
  // reads it into ctx.uiClientId, which resolveAgentIdentity attributes coord writes to.
  if (input.clientId) params.set('client', input.clientId);
  return params;
}

/**
 * Restore the prior `.mcp.json` after a spawn completes (or errors).
 * Always called from a finally block so the user's existing config
 * survives spawn failures.
 *
 * Idempotent: safe to call multiple times. Best-effort cleanup —
 * surfacing a failure here would mask the real spawn error.
 */
export function restoreSpawnMcp(handle: SpawnMcpHandle): void {
  try {
    if (existsSync(handle.path)) {
      unlinkSync(handle.path);
    }
  } catch { /* ignore */ }
  if (handle.backupPath) {
    try {
      if (existsSync(handle.backupPath)) {
        renameSync(handle.backupPath, handle.path);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Extract the `CHUNK_ID=<id>` value from the extras array (mirroring
 * `extractFeatureId` in run-id.ts). Returns null if absent.
 *
 * extras looks like `['FEATURE_ID=F-AUTH-003', 'CHUNK_ID=ck_01HXV9Z']`
 * — the orchestrator main loop and chunk-loop-driver both pass them.
 */
export function extractChunkId(extras: readonly string[]): string | null {
  for (const e of extras) {
    if (e.startsWith('CHUNK_ID=')) return e.slice('CHUNK_ID='.length).trim() || null;
  }
  return null;
}
