/**
 * codex-gateway-config.ts — the ONE codex inference-gateway config.toml builder (WI-3645).
 *
 * Renders the `model_provider` blocks that point a codex CLI session at the localhost
 * Papercusp inference gateway. Consumed by BOTH codex config writers:
 *   • `spawn-mcp.ts` `writeSignedSpawnCodexHome` (same package) — SPAWNED agents
 *     (fleet members, bees; env-driven via PAPERCUSP_ACCOUNT_ID / PAPERCUSP_CODEX_GATEWAY);
 *   • operator-core `role-codex-home.ts` (via the `@papercusp/orchestrator/codex-gateway-config`
 *     subpath export) — the INTERACTIVE psu path (resolveAccountPin / bootstrap-su).
 *
 * Before this extraction each writer carried its own near-identical copy, and they DRIFTED:
 * the spawned copy learned unpinned auto-routing (WI-3645) while the interactive copy still
 * required a pin — which is exactly how "auto" stayed unwired interactively. One builder,
 * one behavior. (Owner directive 2026-07-09: "share as much code as possible with the claude
 * implementation, abstracting away the model specific things into shared code" — the claude
 * analogue is operator-core's `gatewaySpawnEnv`, which likewise routes pin-or-no-pin.)
 *
 * ROUTING SEMANTICS (mirrors the claude path):
 *   • `accountId` set   → gateway config WITH the `x-papercusp-account` pin header.
 *   • `gatewayOn` set   → gateway config WITHOUT the pin header (explicit-auto / unpinned):
 *     the gateway's own codex handling auto-selects — bearer pool first, then the codex-CLI
 *     account fallback — when no account header is present. The header is OMITTED entirely,
 *     never emitted empty (an empty pin would name a nonexistent account and 4xx).
 *   • neither           → `{ root: [], tables: [] }` (gateway off; direct egress unchanged).
 *
 * The `# BEGIN/END PAPERCUSP_CODEX_GATEWAY_*` marker lines are LOAD-BEARING: config writers
 * and diagnostics locate/replace the managed blocks by them — keep them byte-stable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { resolveCapabilityPolicy, type CapabilityPolicyRequest } from '@papercusp/orchestrator/managed-capability-policy';

/** Publish one complete, valid private config. Never truncate the live file:
 * an interrupted write must leave either the prior document or the new one.
 * All managed home writers share this same-filesystem rename boundary. */
export function publishCodexConfig(configPath: string, text: string): void {
  parseToml(text);
  const staging = mkdtempSync(join(dirname(configPath), '.config-toml-'));
  try {
    const stagedConfig = join(staging, 'config.toml');
    writeFileSync(stagedConfig, text, { mode: 0o600 });
    renameSync(stagedConfig, configPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The one provider id every managed codex config names. Exported because it is
 * not just a config-writing detail: codex stamps it into each rollout's
 * `session_meta.model_provider` and re-resolves it against the CURRENT config at
 * `thread/resume`, so the RESUME path has to recognise a thread that is bound to
 * it and refuse to strip the table (WI-38706). One constant, both readers.
 */
export const CODEX_GATEWAY_PROVIDER_ID = 'papercusp-codex-gateway';

/** Host-issued per-process route; independent launches strip this envelope. */
export const SCOPED_INFERENCE_GATEWAY_ENV = 'PAPERCUSP_SCOPED_INFERENCE_GATEWAY';
export interface ScopedInferenceGateway { baseURL: string; token: string }

/** Private native controllers bind only loopback listeners and high-entropy
 * credentials. An invalid explicit route must never fall back to the pool. */
export function snapshotScopedInferenceGateway(value: unknown): Readonly<ScopedInferenceGateway> {
  const route = value as ScopedInferenceGateway | null;
  if (!route || typeof route.baseURL !== 'string' || typeof route.token !== 'string' ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(route.token)) throw new Error('Invalid scoped inference gateway');
  let url: URL;
  try { url = new URL(route.baseURL); } catch { throw new Error('Invalid scoped inference gateway'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      route.baseURL !== url.origin) throw new Error('Invalid scoped inference gateway');
  return Object.freeze({ baseURL: url.origin, token: route.token });
}

/** Escape a value for a TOML double-quoted basic string. */
export function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The localhost gateway port (PAPERCUSP_GATEWAY_PORT override → default 8788). */
export function codexGatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : 8788;
}

export interface CodexGatewayConfigOpts {
  /** Exact private controller route, independent of process-wide pool defaults. */
  gateway?: ScopedInferenceGateway;
  /** Gateway attribution/owner header (x-papercusp-owner) — the spawn/session owner id. */
  ownerId?: string | null;
  /** Admission-tier label (x-papercusp-priority) — the spawn role, when the tier flag resolved one. */
  priority?: string | null;
  /** Route through the gateway even with NO account pin (explicit-auto / unpinned).
   *  Ignored when `accountId` is set (a pin implies the gateway). */
  gatewayOn?: boolean;
}

/**
 * Feature policy baked into every Papercusp-managed CODEX_HOME.
 *
 * Codex 0.147 enables `remote_compaction_v2` by default. That native path cuts
 * the conversation before Papercusp can write a carry note or deliberately
 * restart the session, so managed sessions disable it and use
 * `session:request-compaction` instead. Interactive role/SU homes also disable
 * Codex's native memory store; short-lived spawn homes preserve their existing
 * memory setting by passing `disableMemories: false`.
 */
export function codexManagedFeaturesToml(
  opts: { disableMemories?: boolean; headless?: boolean;
    capabilityPolicy?: Omit<CapabilityPolicyRequest, 'client'> } = {},
): string[] {
  return [
    // CLI versions are managed outside startup. An update dialog can block a
    // carry-respawn before it creates its native session or accepts wakes.
    'check_for_update_on_startup = false',
    // WI-6554700010009529: the Codex PreToolUse hook rewrites shell commands to
    // RTK, and RTK otherwise nags the tool output to install its own competing
    // hook. Must equal operator-core's RTK_SESSION_ENV (pinned by
    // role-codex-home.rtk-session-env.test.ts). Placed before [features] so
    // [features] stays the block's last table for callers that append to it.
    '[shell_environment_policy.set]',
    'RTK_SUPPRESS_HOOK_WARNING = "1"',
    '# Papercusp owns context carry/restart; Codex native compaction must not cut first.',
    '[features]',
    ...(opts.disableMemories === false ? [] : ['memories = false']),
    'remote_compaction_v2 = false',
    // client-native-features-adoption-2026-10-21 D-003/D-005: native subagents
    // fan work out of the orchestrator's spawn graph (the same reason Claude's
    // Task/Agent/Workflow are denied by default), and native goals compete with
    // Papercusp's own objective store (the reason memories are off). The home is
    // shared by every later session, so it always says false; the psu
    // `--allow-subagents` opt-in is a `-c features.multi_agent=true` on a NEW
    // session's launch (CODEX_SUBAGENT_OPT_IN_CONFIG). Codex fixes the setting at
    // session creation and resume/fork inherit it (D-008). These keys alone do NOT remove the tools:
    // the model catalog's multi_agent fields switch them on regardless, so every
    // managed home also runs on a stripped catalog (stripCodexCatalogMultiAgent).
    'multi_agent = false',
    'goals = false',
    // Custom providers do not consult `model_catalog_url` unless this Codex feature is on.
    // Without it, /model silently falls back to the shared/default-account cache even while
    // the gateway can serve newer model ids for inference.
    'api_key_model_discovery = true',
    // A headless managed PTY has no human who can answer Codex's plugin/app
    // authentication elicitation. Leaving plugins enabled makes a 401 from the
    // remote ChatGPT plugin catalog start an OAuth browser flow for every fleet
    // member, even when model inference uses an API key or custom provider and
    // needs no ChatGPT login. Suppress that optional interactive surface only
    // for headless sessions; visible sessions keep the ordinary plugin UX.
    ...(opts.headless
      ? [
          'plugins = false',
          'auth_elicitation = false',
        ]
      : []),
    ...Object.entries(resolveCapabilityPolicy({
      ...opts.capabilityPolicy,
      client: 'codex',
      surface: opts.capabilityPolicy?.surface ?? 'launch',
    }).featureSwitches).map(([feature, value]) => `${feature} = ${value}`),
    '',
  ];
}

/** The `-c` override psu adds to a NEW Codex session's launch argv for
 *  `--allow-subagents`. psu-launcher.mjs (plain node) duplicates this literal; a
 *  lockstep test pins the two copies together. On a stripped catalog it restores
 *  the v1 subagent tools (measured in D-003/D-008); goals stay off. It has no
 *  effect on `resume`/`fork`, which keep the session's creation-time setting. */
export const CODEX_SUBAGENT_OPT_IN_CONFIG = 'features.multi_agent=true';

/** Model-catalog fields that turn Codex native multi-agent tools on regardless
 *  of `[features]` (measured on codex-cli 0.163.0, plan D-003). */
export const CODEX_MULTI_AGENT_CATALOG_FIELDS = ['multi_agent_version', 'multi_agent_reasoning_effort'] as const;

/** The stripped catalog a non-gateway managed home points `model_catalog_json` at. */
export const CODEX_MANAGED_MODEL_CATALOG_FILE = 'papercusp-model-catalog.json';

type CatalogRecord = Record<string, unknown>;

function isCatalogRecord(value: unknown): value is CatalogRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One catalog model without the multi-agent fields (a copy; the input is not touched). */
export function stripCodexModelMultiAgent<T>(model: T): T {
  if (!isCatalogRecord(model)) return model;
  const copy: CatalogRecord = { ...model };
  for (const field of CODEX_MULTI_AGENT_CATALOG_FIELDS) delete copy[field];
  return copy as T;
}

/** A `{ models: [...] }` catalog with the multi-agent fields removed from every model. */
export function stripCodexCatalogMultiAgent<T>(catalog: T): T {
  if (!isCatalogRecord(catalog) || !Array.isArray(catalog.models)) return catalog;
  return { ...catalog, models: catalog.models.map(stripCodexModelMultiAgent) } as T;
}

/** Where a managed home's stripped catalog came from (recorded in home diagnostics). */
export type CodexModelCatalogSource = 'home-cache' | 'user-cache' | 'bundled';

export interface CodexModelCatalogMaterialized {
  path: string;
  source: CodexModelCatalogSource;
  sourcePath: string | null;
  modelCount: number;
  fetchedAt: string | null;
}

export class CodexModelCatalogUnavailableError extends Error {
  // A declared field, not a constructor parameter property: Node's strip-only
  // TypeScript loader refuses parameter properties, and the Codex launcher
  // imports this module that way.
  readonly attempts: string[];

  constructor(attempts: string[]) {
    super(
      `no Codex model catalog is available to strip (${attempts.join('; ')}); ` +
        'refusing to write a non-gateway Codex home that would start with native subagent tools',
    );
    this.name = 'CodexModelCatalogUnavailableError';
    this.attempts = attempts;
  }
}

let bundledCatalogMemo: string | null = null;

/** The catalog compiled into the installed codex binary. `codex debug models`
 *  renders it from an empty home with no auth and no network (measured
 *  2026-10-21, codex-cli 0.163.0: 11 models in 0.5s). Memoized per process. */
export function readBundledCodexModelCatalog(): string {
  if (bundledCatalogMemo !== null) return bundledCatalogMemo;
  const emptyHome = mkdtempSync(join(tmpdir(), 'papercusp-codex-catalog-'));
  try {
    bundledCatalogMemo = execFileSync('codex', ['debug', 'models'], {
      env: { ...process.env, CODEX_HOME: emptyHome },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return bundledCatalogMemo;
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

function parsedCatalog(text: string): (CatalogRecord & { models: unknown[] }) | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isCatalogRecord(parsed) && Array.isArray(parsed.models) && parsed.models.length > 0) {
      return parsed as CatalogRecord & { models: unknown[] };
    }
  } catch {
    /* unreadable source: try the next one */
  }
  return null;
}

/**
 * Write `<codexHome>/papercusp-model-catalog.json`: the freshest available Codex
 * catalog with the multi-agent fields removed (plan D-005 route 2). Sources, in
 * order: the newer (by `fetched_at`) of the home's own and the user's
 * `models_cache.json`, then the catalog compiled into the codex binary. Throws
 * {@link CodexModelCatalogUnavailableError} when none yields a model: a
 * non-gateway home without a stripped catalog would start WITH subagent tools,
 * because the `[features]` keys alone do not remove them.
 */
export function materializeStrippedCodexModelCatalog(opts: {
  codexHome: string;
  userCodexHome?: string;
  readBundledCatalog?: () => string;
}): CodexModelCatalogMaterialized {
  const attempts: string[] = [];
  const caches = [
    { source: 'home-cache' as const, path: join(opts.codexHome, 'models_cache.json') },
    { source: 'user-cache' as const, path: join(opts.userCodexHome ?? join(homedir(), '.codex'), 'models_cache.json') },
  ].flatMap((candidate) => {
    if (!existsSync(candidate.path)) {
      attempts.push(`${candidate.source}: absent`);
      return [];
    }
    let catalog: ReturnType<typeof parsedCatalog> = null;
    try {
      catalog = parsedCatalog(readFileSync(candidate.path, 'utf8'));
    } catch (error) {
      attempts.push(`${candidate.source}: ${(error as Error).message}`);
      return [];
    }
    if (!catalog) {
      attempts.push(`${candidate.source}: no models`);
      return [];
    }
    const fetchedAt = typeof catalog.fetched_at === 'string' ? catalog.fetched_at : null;
    const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
    return [{ ...candidate, catalog, fetchedAt, fetchedMs: Number.isFinite(fetchedMs) ? fetchedMs : 0 }];
  });
  caches.sort((a, b) => b.fetchedMs - a.fetchedMs);
  let chosen: {
    source: CodexModelCatalogSource;
    sourcePath: string | null;
    catalog: CatalogRecord & { models: unknown[] };
    fetchedAt: string | null;
  } | null = caches[0]
    ? { source: caches[0].source, sourcePath: caches[0].path, catalog: caches[0].catalog, fetchedAt: caches[0].fetchedAt }
    : null;
  if (!chosen) {
    try {
      const bundled = parsedCatalog((opts.readBundledCatalog ?? readBundledCodexModelCatalog)());
      if (bundled) chosen = { source: 'bundled', sourcePath: null, catalog: bundled, fetchedAt: null };
      else attempts.push('bundled: no models');
    } catch (error) {
      attempts.push(`bundled: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  if (!chosen) throw new CodexModelCatalogUnavailableError(attempts);
  const stripped = stripCodexCatalogMultiAgent({ models: chosen.catalog.models });
  const path = join(opts.codexHome, CODEX_MANAGED_MODEL_CATALOG_FILE);
  const staging = mkdtempSync(join(opts.codexHome, '.model-catalog-'));
  try {
    const staged = join(staging, CODEX_MANAGED_MODEL_CATALOG_FILE);
    writeFileSync(staged, `${JSON.stringify(stripped)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    path,
    source: chosen.source,
    sourcePath: chosen.sourcePath,
    modelCount: chosen.catalog.models.length,
    fetchedAt: chosen.fetchedAt,
  };
}

/** The root config line pointing a non-gateway home at its stripped catalog.
 *  Top-level key: it must precede every `[table]`. */
export function codexModelCatalogToml(catalogPath: string): string[] {
  return [`model_catalog_json = "${tomlEscape(catalogPath)}"`];
}

/**
 * The managed gateway blocks for a codex `config.toml`: `root` lines (top-level
 * `model_provider = …`) and `tables` lines (the `[model_providers.…]` table).
 * Empty when neither a pin nor `gatewayOn` asked for the gateway.
 */
export function codexGatewayConfigToml(
  accountId?: string | null,
  opts: CodexGatewayConfigOpts = {},
): { root: string[]; tables: string[] } {
  const scoped = opts.gateway === undefined ? null : snapshotScopedInferenceGateway(opts.gateway);
  const pinnedAccount = accountId?.trim();
  // WI-3645: a pin gets routing config as before; a caller that passes NO pin but sets
  // `gatewayOn` (the explicit-auto / unpinned case) ALSO gets routing config, just without the
  // account-pin header — the gateway's own codex fallback auto-selects when the header is
  // absent. Only a caller that passes neither (gateway fully off) gets no config.
  if (!pinnedAccount && !opts.gatewayOn && !scoped) return { root: [], tables: [] };
  const providerId = CODEX_GATEWAY_PROVIDER_ID;
  // `/v1/models` is shared by the Claude and Codex adapters. Inference is
  // unambiguous from `/v1/responses`, but the native model-catalog client does
  // not stamp Codex's usual originator header. Make the provider identity
  // explicit so an unpinned `account=auto` catalog request cannot fall through
  // to Claude's differently-shaped `{ data: [...] }` response.
  const headers: Record<string, string> = { originator: 'codex_cli_rs' };
  if (pinnedAccount) headers['x-papercusp-account'] = pinnedAccount;
  const ownerId = opts.ownerId?.trim();
  if (ownerId) headers['x-papercusp-owner'] = ownerId;
  const priority = opts.priority?.trim();
  if (priority) headers['x-papercusp-priority'] = priority;
  const gatewayBaseUrl = scoped?.baseURL ?? `http://127.0.0.1:${codexGatewayPort()}`;
  const headerEntries = Object.entries(headers);
  const httpHeadersLine = headerEntries.length
    ? [`http_headers = { ${headerEntries.map(([k, v]) => `"${tomlEscape(k)}" = "${tomlEscape(v)}"`).join(', ')} }`]
    : [];
  return {
    root: [
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
      '# Route Codex model traffic through the Papercusp inference gateway account pin.',
      `model_provider = "${providerId}"`,
      '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
      '',
    ],
    tables: [
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      `[model_providers.${providerId}]`,
      'name = "Papercusp Codex Gateway"',
      `base_url = "${gatewayBaseUrl}/v1"`,
      // Codex model discovery is a distinct provider endpoint. Without this full URL,
      // the TUI falls back to its shared/default-account cache instead of asking our
      // selected gateway account, so newly released models disappear only in PSU
      // `--account=auto` sessions even though inference can already serve them.
      `model_catalog_url = "${gatewayBaseUrl}/v1/models"`,
      'wire_api = "responses"',
      // The gateway owns upstream credentials, not the ambient default ChatGPT login.
      'requires_openai_auth = false',
      `experimental_bearer_token = "${scoped?.token ?? 'papercusp-gateway'}"`,
      ...httpHeadersLine,
      '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      '',
    ],
  };
}
