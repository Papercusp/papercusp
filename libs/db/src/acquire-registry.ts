/**
 * acquire-registry — this process's own count of how many DB-connection
 * ACQUISITIONS are waiting, how many are holding, and when this pool last
 * actually obtained a connection. EI-19485014132257783 / EI-19448641861408544.
 *
 * ## Why this exists
 *
 * `ConnectPhaseDeadlineError` / `DbCallDeadlineError` name two causes that
 * present identically at the failure point:
 *
 *   (a) the pool's resolved endpoint is DEAD — postgres-js retries a first
 *       connect forever and never rejects (connect_timeout is unset in prod);
 *   (b) the CLIENT pool is saturated while the endpoint is perfectly healthy.
 *
 * Both messages were rewritten twice (EI-19448665862739845, WI-8848) to stop
 * asserting one confident cause and to spell out how to tell them apart. That
 * is still a THREE-STEP MANUAL PROBE handed to a reader mid-incident — and the
 * probe is a database probe, against a pool that is saturated by hypothesis, so
 * the diagnostic itself queues behind the thing being diagnosed.
 *
 * Every acquisition in this process funnels through ONE seam
 * (`withAcquisitionDeadline`, reached from `withWorkspace` / `withHarnessSchema`),
 * so the process can simply COUNT ITS OWN and put the numbers in the error. Zero
 * I/O on the failing path, which is the whole point.
 *
 * ## What the numbers can and cannot prove
 *
 * The one measurement that genuinely DISCRIMINATES is `lastAcquiredAt`: a
 * successful acquisition on this pool is proof the endpoint answered. So
 *
 *   - a RECENT successful acquisition RULES OUT (a) for this pool — whatever
 *     the caller is waiting on, it is a queue, not a dead endpoint;
 *   - ZERO successful acquisitions in this process is consistent with (a);
 *   - `held >= max` CONFIRMS (b) from this seam alone.
 *
 * ⚠ `held` counts only acquisitions that went THROUGH this seam. Direct users of
 * the same pool (a bare `getOrgPgApp().sql\`…\``, a drizzle call, a LISTEN) hold
 * connections without registering here, so `held` is a LOWER BOUND on pool
 * occupancy and `held < max` NEVER means the pool has free slots. Stating that
 * out loud is deliberate: the failure this module exists to end is a
 * confidently-worded diagnosis that outran its evidence.
 *
 * ⚠ It is also PER-PROCESS. It says nothing about the ~15 vitest workers that
 * each open their own `pcusp:org-app:p<pid>` pool — the measured mechanism
 * behind EI-19448641861408544. A healthy-looking registry in one process is not
 * evidence the pooler's queue is healthy.
 *
 * State is pinned via `pinModuleState` (NOT a hand-rolled globalThis+Symbol.for
 * pair): a split module record would give each copy its own Map and silently
 * HALVE the very counts this exists to report, which is the failure mode
 * `@papercusp/module-singleton` was built for (EI-19451658870832332).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { randomUUID } from 'node:crypto';
import { readBuildStamp } from './build-stamp';

/** A successful acquisition at most this long ago proves the endpoint answers. */
export const ACQUIRE_RECENT_SUCCESS_MS = 60_000;

/**
 * Keep only the newest completed-query records per pool. This is diagnostic
 * state, not telemetry storage: the bound must stay small enough to inspect on
 * a failed epoch without turning a busy query path into a new memory leak.
 */
export const PG_RESULT_DIAGNOSTIC_LIMIT = 32;

/** Keep recent failures separately so successful query volume cannot erase them. */
export const PG_FAILURE_DIAGNOSTIC_LIMIT = 16;

/** At most this many active acquisition tickets are copied into a deadline error. */
export const ACQUIRE_TICKET_DIAGNOSTIC_LIMIT = 8;

/** Per-request pool acquisition history is local and bounded. */
export const PG_ACQUIRE_TIMING_LIMIT = 8;

export interface PgAcquireTiming {
  pool: string;
  elapsedMs: number;
  outcome: 'acquired' | 'released-before-acquire';
}

export interface PgAcquireTimingSnapshot {
  requestId: string;
  operation: string | null;
  capacity: number;
  omitted: number;
  acquisitions: PgAcquireTiming[];
}

interface PgAcquireTimingContext {
  requestId: string;
  operation: string | null;
  omitted: number;
  acquisitions: PgAcquireTiming[];
}

export interface AcquireTicketDiagnostic {
  state: 'waiting' | 'held';
  /** Time this ticket has spent waiting or holding a connection. */
  ageMs: number;
  /** Validated local/proxy request identity, or null when no safe identity exists. */
  requestId: string | null;
  /** Source-registered operation name, or null when no safe label exists. */
  operation: string | null;
}

export interface AcquireTicketSnapshot {
  pool: string;
  capacity: number;
  /** All active tickets at this seam, including the caller that hit the deadline. */
  active: number;
  omitted: number;
  /** Oldest active tickets first. */
  tickets: AcquireTicketDiagnostic[];
}

export interface AcquireSnapshot {
  /** The pool's `buildClient` label, e.g. `org-app` / `org-admin`. */
  pool: string;
  /** Acquisitions currently WAITING at this seam (includes the caller that is asking). */
  waiting: number;
  /** How long the longest-waiting acquisition has waited, or null when none wait. */
  oldestWaitMs: number | null;
  /** Acquisitions that obtained a connection and have not released it — a LOWER BOUND. */
  held: number;
  /** How long the longest-held acquisition has held, or null when none are held. */
  oldestHeldMs: number | null;
  /** The pool's configured `max`, or null if this pool was never built in this process. */
  max: number | null;
  /** Successful acquisitions at this seam since the process started. */
  totalAcquired: number;
  /** Age of the most recent successful acquisition, or null if there has never been one. */
  lastAcquiredAgoMs: number | null;
}

export interface AcquireTicket {
  /** The connection was obtained — move this ticket from waiting to held. Idempotent. */
  acquired(): void;
  /** The acquisition finished (either way) — drop this ticket. Idempotent. */
  release(): void;
}

interface PoolState {
  waiting: Map<number, number>;
  held: Map<number, number>;
  /** Optional during in-place upgrades of the pinned registry state. */
  ticketContexts?: Map<number, { requestId: string | null; operation: string | null }>;
  max: number | null;
  totalAcquired: number;
  lastAcquiredAt: number | null;
  /** Optional for in-place upgrade of a PoolState pinned by older live code. */
  pgResults?: Array<PgResultDiagnostic & { objectRefs?: PgDiagnosticObjectRefs }>;
  totalPgResults?: number;
  /** Failure-only ring is separate from successful-result churn. */
  pgFailures?: PgResultDiagnostic[];
  totalPgFailures?: number;
}

interface RegistryState {
  pools: Map<string, PoolState>;
  seq: number;
  contextResolver?: PgDiagnosticContextResolver | null;
  acquireTimingStorage?: AsyncLocalStorage<PgAcquireTimingContext>;
}

const STATE = pinModuleState<RegistryState>('@papercusp/db-org.acquire-registry', () => ({
  pools: new Map<string, PoolState>(),
  seq: 0,
}));
const acquireTimingStorage = STATE.acquireTimingStorage ??= new AsyncLocalStorage<PgAcquireTimingContext>();

/** Scope successful and incomplete pool waits to one bounded request. */
export function withPgAcquireDiagnostics<T>(operation: string, run: (requestId: string) => T): T {
  const context: PgAcquireTimingContext = {
    requestId: randomUUID(),
    operation: /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(operation) ? operation : null,
    omitted: 0,
    acquisitions: [],
  };
  return acquireTimingStorage.run(context, () => run(context.requestId));
}

/** Read only the current async request's bounded acquisition timings. */
export function pgAcquireTimingSnapshot(): PgAcquireTimingSnapshot | null {
  const context = acquireTimingStorage.getStore();
  if (!context) return null;
  return {
    requestId: context.requestId,
    operation: context.operation,
    capacity: PG_ACQUIRE_TIMING_LIMIT,
    omitted: context.omitted,
    acquisitions: context.acquisitions.map((item) => ({ ...item })),
  };
}

function poolState(pool: string): PoolState {
  let s = STATE.pools.get(pool);
  if (!s) {
    s = {
      waiting: new Map(),
      held: new Map(),
      ticketContexts: new Map(),
      max: null,
      totalAcquired: 0,
      lastAcquiredAt: null,
    };
    STATE.pools.set(pool, s);
  }
  s.ticketContexts ??= new Map();
  return s;
}

export interface PgResultDiagnosticInput {
  connectionId: number;
  queryId: number;
  backendPid: number | null;
  query: string;
  command?: string | null;
  rowCount: number;
  wireBytes: number;
  elapsedMs?: number | null;
  preBuildMs?: number | null;
  status: 'ok' | 'error';
  errorCode?: string | null;
  /** Bounded PostgreSQL error labels only; the server message is never retained. */
  errorClass?: string | null;
  serverRoutine?: string | null;
  /** Caller stack from postgres-js Query.origin; never query text or parameters. */
  queryOrigin?: string | null;
  /** Caller stack captured when end({ timeout }) starts forced pool teardown. */
  endCaller?: string | null;
  /** Opaque to postgres.js; sanitized both at capture and retention. */
  context?: unknown;
  /** Exact fulfilled postgres-js object; consumed synchronously into a WeakRef only. */
  result?: object;
}

export type PgDiagnosticBoundary = 'await' | 'sync';
/** Source-defined stage names only; a token-shaped secret is still a secret. */
export const PG_DIAGNOSTIC_STAGES = [
  'scope-query', 'epoch-query', 'epoch-load', 'baseline-evidence', 'owner-check',
  'key-provider', 'keychain', 'native-loader', 'serialize', 'native-encrypt',
  'epoch-encrypt', 'hypercore-append', 'mark-drained',
  'scorecards-get-evidence-read', 'scorecards-get-rubric-read',
] as const;
/** Source-defined query legs retained only as bounded diagnostic labels. */
export const PG_DIAGNOSTIC_QUERY_LEGS = [
  'work-items-page', 'work-items-presentation',
] as const;
export type PgDiagnosticQueryLeg = (typeof PG_DIAGNOSTIC_QUERY_LEGS)[number];

/**
 * Optional local-only attribution captured at query construction time.
 *
 * This is deliberately a small, sanitized identity tuple. It is never part of
 * LocalWriteOp, AAD, a federated envelope, or SQL/parameter data.
 */
export interface PgResultDiagnosticCorrelation {
  processInstanceId: string;
  buildSha: string | null;
  rowId: string | null;
  attemptId: string;
  hopId: number | null;
  stage: string | null;
  boundary: PgDiagnosticBoundary | null;
  /** Server-created request identity and source-registered operation; never caller args. */
  requestId?: string;
  operation?: string;
  /** Fixed source labels distinguish same-table query legs without retaining SQL. */
  queryLeg?: PgDiagnosticQueryLeg;
}

export type PgDiagnosticCorrelationState = 'linked' | 'unobserved' | 'unknown';

export type PgDiagnosticContextResolver = () => PgResultDiagnosticCorrelation | null;

interface PgDiagnosticLink {
  readonly state: PgDiagnosticCorrelationState;
  readonly correlation?: PgResultDiagnosticCorrelation;
}

export interface PgDiagnosticSource {
  readonly processInstanceId: string;
  readonly buildSha: string | null;
  /** Null for legacy/direct recorders, never inferred from a pool label. */
  readonly poolInstanceId: string | null;
}

/** The same local process identity is used by named hops and PG results. */
export function pgDiagnosticIdentity(): Omit<PgDiagnosticSource, 'poolInstanceId'> {
  const identity = pinModuleState('@papercusp/db-org.diagnostic-identity', () => randomUUID());
  const build = readBuildStamp();
  return {
    processInstanceId: identity,
    buildSha: build && /^[a-f0-9]{7,64}$/i.test(build) ? build : null,
  };
}

/**
 * The bounded, safe-to-render record retained for a completed postgres-js
 * query. It deliberately contains no SQL text, values, parameters, or rows.
 */
export interface PgResultDiagnostic {
  pool: string;
  source: PgDiagnosticSource;
  connectionId: number;
  queryId: number;
  backendPid: number | null;
  queryFamily: string;
  /** Same setup SELECT's physical PG backend, distinct from protocol-peer backendPid. */
  physicalBackendPid: number | null;
  /** Server statement receipt/start, with microseconds; not completion or local recordedAt. */
  serverStatementAt: string | null;
  command: string | null;
  rowCount: number;
  wireBytes: number;
  elapsedMs: number | null;
  /** Execution start to build, including queue/connect/preparation, not CPU or pure acquisition. */
  preBuildMs: number | null;
  status: 'ok' | 'error';
  errorCode: string | null;
  errorClass: string | null;
  serverRoutine: string | null;
  /** Bounded caller stack, without postgres internals, SQL text, or parameters. */
  queryOrigin: string | null;
  /** Bounded end({ timeout }) caller stack for a forced queued-query rejection. */
  endCaller: string | null;
  /** Added only for terminal errors; inferred from the query/command, not SQL values. */
  failurePhase?: PgFailurePhase;
  recordedAt: number;
  correlationState: PgDiagnosticCorrelationState;
  correlation?: PgResultDiagnosticCorrelation;
}

export interface PgResultDiagnosticSnapshot {
  pool: string;
  capacity: number;
  totalRecorded: number;
  dropped: number;
  results: Array<PgResultDiagnostic & { objectRefs?: PgDiagnosticObjectRefs }>;
  failureCapacity: number;
  totalFailures: number;
  droppedFailures: number;
  failures: PgResultDiagnostic[];
}

export type PgFailurePhase =
  | 'transaction-start'
  | 'transaction-setup'
  | 'statement'
  | 'transaction-commit'
  | 'transaction-rollback'
  | 'transaction-control'
  | 'unknown';

/** Local inspector opt-in only. Dereferencing temporarily keeps the target alive. */
export interface PgDiagnosticObjectRefs {
  decodedResult?: WeakRef<object>;
  resolvedRows?: WeakRef<object>;
  responseValue?: WeakRef<object>;
}

function boundedWholeNumber(value: number, nullable = false): number | null {
  if (!Number.isFinite(value)) return nullable ? null : 0;
  return Math.max(0, Math.floor(value));
}

function safeToken(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const token = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '').slice(0, max);
  return token || null;
}

/** Keep only source-independent identifier labels; reject mixed prose entirely. */
function safeDiagnosticIdentifier(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string' || value.length > max) return null;
  const identifier = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : null;
}

/** Retain a short caller-only stack, excluding postgres internals and SQL data. */
function safeDiagnosticStack(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const frames = value
    .split(/\r?\n/)
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => frame && !/node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?postgres[\\/]/i.test(frame))
    .slice(0, 8);
  const stack = frames.join('\n').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 768);
  return stack || null;
}

function sanitizePgCorrelation(
  input: unknown,
): PgResultDiagnosticCorrelation | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<PgResultDiagnosticCorrelation>;
  const processInstanceId =
    typeof value.processInstanceId === 'string' && /^[a-f0-9-]{36}$/i.test(value.processInstanceId)
      ? value.processInstanceId
      : null;
  const attemptId =
    typeof value.attemptId === 'string' && /^[a-f0-9-]{36}$/i.test(value.attemptId)
      ? value.attemptId
      : null;
  if (!processInstanceId || !attemptId) return null;
  const buildSha =
    value.buildSha === null
      ? null
      : typeof value.buildSha === 'string' && /^[a-f0-9]{7,64}$/i.test(value.buildSha)
        ? value.buildSha
        : null;
  const rowId =
    value.rowId === null
      ? null
      : typeof value.rowId === 'string' && /^\d{1,30}$/.test(value.rowId)
        ? value.rowId
        : null;
  const hopId =
    value.hopId === null
      ? null
      : typeof value.hopId === 'number' && Number.isSafeInteger(value.hopId) && value.hopId > 0
        ? Math.floor(value.hopId)
        : null;
  const stage =
    value.stage === null
      ? null
      : PG_DIAGNOSTIC_STAGES.includes(value.stage as typeof PG_DIAGNOSTIC_STAGES[number])
        ? value.stage!
        : null;
  const boundary =
    value.boundary === 'await' || value.boundary === 'sync' ? value.boundary : null;
  const requestId = typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(value.requestId)
    ? value.requestId : null;
  const operation = requestId && typeof value.operation === 'string' &&
    /^[a-z][a-z0-9_.-]{0,119}$/i.test(value.operation) ? value.operation : null;
  const queryLeg = PG_DIAGNOSTIC_QUERY_LEGS.includes(value.queryLeg as PgDiagnosticQueryLeg)
    ? value.queryLeg!
    : null;
  return Object.freeze({
    processInstanceId,
    buildSha,
    rowId,
    attemptId,
    hopId,
    stage,
    boundary,
    ...(requestId ? { requestId } : {}),
    ...(operation ? { operation } : {}),
    ...(queryLeg ? { queryLeg } : {}),
  });
}

/** Register the host's current local attempt resolver (last registration wins). */
export function setPgDiagnosticContextResolver(
  resolver: PgDiagnosticContextResolver | null,
): void {
  STATE.contextResolver = resolver;
}

/** Clear the optional local-attribution resolver (test seam + host teardown). */
export function resetPgDiagnosticContextResolver(): void {
  STATE.contextResolver = null;
}

/**
 * Capture only scalar context at the public Query's construction, BEFORE
 * queuing. Socket callbacks (including build/debug) can run in another query's
 * async context. No Query wrapping, FIFO guessing, or pending-context map.
 */
export function capturePgDiagnosticContext(): PgDiagnosticLink {
  try {
    const raw = STATE.contextResolver?.() ?? null;
    const correlation = sanitizePgCorrelation(raw);
    return Object.freeze({
      state: raw === null ? 'unobserved' : correlation ? 'linked' : 'unknown',
      ...(correlation ? { correlation } : {}),
    });
  } catch {
    return Object.freeze({ state: 'unknown' });
  }
}

function normalizePgDiagnosticContext(input: unknown): PgDiagnosticLink {
  if (input === undefined) return { state: 'unobserved' };
  try {
    const link = input as PgDiagnosticLink;
    if (link?.state === 'unobserved') return { state: 'unobserved' };
    const correlation = link?.state === 'linked' && sanitizePgCorrelation(link.correlation);
    return correlation ? { state: 'linked', correlation } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/** One identity per physical pool construction, even when labels are reused. */
export function createPgDiagnosticHooks(pool: string) {
  let source: PgDiagnosticSource = Object.freeze({
    ...pgDiagnosticIdentity(),
    poolInstanceId: randomUUID(),
  });
  return {
    onquerycontext: capturePgDiagnosticContext,
    onresult: (diagnostic: PgResultDiagnosticInput) => {
      // Pools can be constructed before the host installs its loaded-build
      // resolver. Fill an unknown stamp once; keep the process/pool identities
      // and every already-recorded diagnostic unchanged.
      if (source.buildSha === null) {
        const buildSha = pgDiagnosticIdentity().buildSha;
        if (buildSha !== null) source = Object.freeze({ ...source, buildSha });
      }
      recordPgResult(pool, diagnostic, source);
    },
  };
}

// ── Query-family memo (WI-10002541) ──────────────────────────────────────
//
// `recordPgResult` runs on EVERY terminal postgres-js result, and the family
// classifier below makes five regex passes plus a lowercase over the whole SQL
// text. The texts repeat almost perfectly (a code path issues the same SQL with
// different parameters), so that work was recomputed for the same few hundred
// strings thousands of times a second. On the rig VM it was ~2-3% of the
// operator main thread (recordPgResult 3.3% inclusive in a 20s profile during
// the P-203 fold), paid on the fold's own query path. Measured per call on a
// representative mix: ~8.4us classified vs ~0.9us remembered.
//
// The family is a pure function of the text, so remembering it cannot change
// an answer. The memo holds query TEXT only (parameter values never reach it),
// is bounded, is never exposed by any snapshot, and skips very long texts.

/** Max distinct query texts remembered. */
export const PG_QUERY_FAMILY_MEMO_MAX = 1024;
/** Longer texts are classified every time and never remembered, so one huge
 *  generated statement cannot pin megabytes in the memo. */
export const PG_QUERY_FAMILY_MEMO_MAX_TEXT = 16 * 1024;

interface PgQueryFamilyMemo {
  families: Map<string, string>;
  hits: number;
  misses: number;
  evictions: number;
  max: number;
}

const FAMILY_MEMO = pinModuleState<PgQueryFamilyMemo>('@papercusp/db-org.pg-query-family-memo', () => ({
  families: new Map<string, string>(),
  hits: 0,
  misses: 0,
  evictions: 0,
  max: PG_QUERY_FAMILY_MEMO_MAX,
}));

/** Memo counters (no query text), for health reads and the call-count test. */
export function pgQueryFamilyMemoStats(): {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  max: number;
} {
  const { hits, misses, evictions, max, families } = FAMILY_MEMO;
  return { hits, misses, evictions, size: families.size, max };
}

/** Test-only: forget every remembered family, zero the counters, and
 *  optionally shrink the bound so eviction is testable. */
export function resetPgQueryFamilyMemoForTest(opts: { max?: number } = {}): void {
  FAMILY_MEMO.families.clear();
  FAMILY_MEMO.hits = 0;
  FAMILY_MEMO.misses = 0;
  FAMILY_MEMO.evictions = 0;
  FAMILY_MEMO.max = opts.max ?? PG_QUERY_FAMILY_MEMO_MAX;
}

/**
 * Reduce arbitrary SQL to a stable operation/relation family without retaining
 * literals or parameter values. This is intentionally a classifier, not a SQL
 * parser: an unknown shape becomes "other", never a clipped copy of the query.
 * Remembered per distinct text (see the memo above); the answer is identical.
 */
export function pgQueryFamily(query: string): string {
  const text = String(query);
  if (text.length > PG_QUERY_FAMILY_MEMO_MAX_TEXT) {
    FAMILY_MEMO.misses += 1;
    return classifyPgQuery(text);
  }
  const families = FAMILY_MEMO.families;
  const hit = families.get(text);
  if (hit !== undefined) {
    FAMILY_MEMO.hits += 1;
    families.delete(text); // refresh recency
    families.set(text, hit);
    return hit;
  }
  FAMILY_MEMO.misses += 1;
  const family = classifyPgQuery(text);
  families.set(text, family);
  while (families.size > FAMILY_MEMO.max) {
    const oldest = families.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    families.delete(oldest);
    FAMILY_MEMO.evictions += 1;
  }
  return family;
}

function classifyPgQuery(query: string): string {
  const scrubbed = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\$\w*\$[\s\S]*?\$\w*\$/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const operation =
    scrubbed.match(/\b(select|insert|update|delete|merge|copy|call|show|set|begin|commit|rollback)\b/)?.[1] ??
    'other';
  const relationMatch =
    operation === 'insert'
      ? scrubbed.match(/\binsert\s+into\s+("?[\w.-]+"?)/)
      : operation === 'update'
        ? scrubbed.match(/\bupdate\s+("?[\w.-]+"?)/)
        : scrubbed.match(/\b(?:from|copy|call)\s+("?[\w.-]+"?)/);
  const relation = safeToken(relationMatch?.[1]?.replace(/"/g, ''), 72);
  return relation ? `${operation}:${relation}` : operation;
}

/** Classify only the phase of a failed result; never retain its SQL text. */
function classifyPgFailurePhase(
  query: string,
  queryFamily: string,
  command: string | null | undefined,
): PgFailurePhase {
  const commandToken = safeToken(command, 32);
  const operation = queryFamily.split(':', 1)[0];
  if (commandToken === 'begin' || operation === 'begin' || /^start\s+transaction\b/i.test(query.trim())) {
    return 'transaction-start';
  }
  if (commandToken === 'commit' || operation === 'commit' || /^end\b/i.test(query.trim())) {
    return 'transaction-commit';
  }
  if (commandToken === 'rollback' || operation === 'rollback' || /^abort\b/i.test(query.trim())) {
    return 'transaction-rollback';
  }
  if (commandToken === 'savepoint' || commandToken === 'release' || /^savepoint\b|^release\b/i.test(query.trim())) {
    return 'transaction-control';
  }
  const withoutComments = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (withoutComments.startsWith('select set_config(')) return 'transaction-setup';
  return query.trim() ? 'statement' : 'unknown';
}

/** Extract only the two source-authored setup scalars; never retain a result row. */
function setupServerCorrelation(input: PgResultDiagnosticInput): {
  physicalBackendPid: number | null;
  serverStatementAt: string | null;
} {
  const absent = { physicalBackendPid: null, serverStatementAt: null };
  if (input.status !== 'ok' || input.rowCount !== 1 ||
      !/^select\s+set_config\(/i.test(input.query.trim()) ||
      !/pg_backend_pid\(\)\s+AS\s+diagnostic_pg_pid,\s*statement_timestamp\(\)::text\s+AS\s+diagnostic_statement_at\s*$/i.test(input.query)) {
    return absent;
  }
  try {
    if (!Array.isArray(input.result) || input.result.length !== 1) return absent;
    const row = Object.getOwnPropertyDescriptor(input.result, '0')?.value;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return absent;
    // Own data properties only: diagnostic extraction must not invoke row getters.
    const pid = Object.getOwnPropertyDescriptor(row, 'diagnostic_pg_pid')?.value;
    const at = Object.getOwnPropertyDescriptor(row, 'diagnostic_statement_at')?.value;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647 ||
        typeof at !== 'string' ||
        !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?[+-](?:0\d|1[0-5])(?::[0-5]\d)?$/.test(at) ||
        !Number.isFinite(Date.parse(at))) return absent;
    const [year, month, day] = at.slice(0, 10).split('-').map(Number);
    const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day! > days[month! - 1]!) return absent;
    return { physicalBackendPid: pid, serverStatementAt: at };
  } catch {
    return absent;
  }
}

/**
 * Record one terminal result from postgres-js. All fields are normalized and
 * the retained FIFO is bounded. This function is intentionally synchronous and
 * allocation-small because it runs on the protocol result path.
 */
export function recordPgResult(
  pool: string,
  input: PgResultDiagnosticInput,
  source: PgDiagnosticSource = { ...pgDiagnosticIdentity(), poolInstanceId: null },
): void {
  if (!pool) return;
  const s = poolState(pool);
  const results = (s.pgResults ??= []);
  const correlation = normalizePgDiagnosticContext(input.context);
  const queryFamily = pgQueryFamily(input.query);
  const failed = input.status === 'error';
  const diagnostic: PgResultDiagnostic & { objectRefs?: PgDiagnosticObjectRefs } = {
    pool,
    source: { ...source },
    connectionId: boundedWholeNumber(input.connectionId) ?? 0,
    queryId: boundedWholeNumber(input.queryId) ?? 0,
    backendPid:
      input.backendPid === null ? null : boundedWholeNumber(input.backendPid, true),
    queryFamily,
    ...setupServerCorrelation(input),
    command: safeToken(input.command, 32),
    rowCount: boundedWholeNumber(input.rowCount) ?? 0,
    wireBytes: boundedWholeNumber(input.wireBytes) ?? 0,
    elapsedMs:
      input.elapsedMs === null || input.elapsedMs === undefined
        ? null
        : boundedWholeNumber(input.elapsedMs, true),
    preBuildMs:
      input.preBuildMs === null || input.preBuildMs === undefined
        ? null
        : boundedWholeNumber(input.preBuildMs, true),
    status: failed ? 'error' : 'ok',
    errorCode: safeToken(input.errorCode, 16),
    errorClass: failed ? safeDiagnosticIdentifier(input.errorClass, 80) : null,
    serverRoutine: failed ? safeDiagnosticIdentifier(input.serverRoutine, 120) : null,
    queryOrigin: safeDiagnosticStack(input.queryOrigin),
    endCaller: safeDiagnosticStack(input.endCaller),
    ...(failed ? {
      failurePhase: classifyPgFailurePhase(input.query, queryFamily, input.command),
    } : {}),
    recordedAt: Date.now(),
    correlationState: correlation.state,
    ...(correlation.correlation ? { correlation: correlation.correlation } : {}),
    ...(input.status === 'ok' && input.result && typeof input.result === 'object'
      ? { objectRefs: { decodedResult: new WeakRef(input.result) } } : {}),
  };
  results.push(diagnostic);
  s.totalPgResults = (s.totalPgResults ?? 0) + 1;
  if (results.length > PG_RESULT_DIAGNOSTIC_LIMIT) {
    results.splice(0, results.length - PG_RESULT_DIAGNOSTIC_LIMIT);
  }
  if (failed) {
    const failures = (s.pgFailures ??= []);
    failures.push(diagnostic);
    s.totalPgFailures = (s.totalPgFailures ?? 0) + 1;
    if (failures.length > PG_FAILURE_DIAGNOSTIC_LIMIT) {
      failures.splice(0, failures.length - PG_FAILURE_DIAGNOSTIC_LIMIT);
    }
  }
}

/**
 * Link an observed response object to this request's retained query records.
 * Request + process identity is an exact join, never a row-count/time match.
 * No record is invented when the request made no query or its record was evicted.
 */
export function recordPgDiagnosticResponse(
  context: PgResultDiagnosticCorrelation,
  phase: 'resolvedRows' | 'responseValue',
  value: unknown,
): void {
  if (!context.requestId || !value || typeof value !== 'object') return;
  for (const s of STATE.pools.values()) {
    for (const diagnostic of s.pgResults ?? []) {
      if (diagnostic.correlation?.requestId !== context.requestId ||
          diagnostic.correlation.processInstanceId !== context.processInstanceId ||
          diagnostic.correlation.buildSha !== context.buildSha ||
          diagnostic.source.processInstanceId !== context.processInstanceId ||
          (diagnostic.source.buildSha !== null && diagnostic.source.buildSha !== context.buildSha)) continue;
      (diagnostic.objectRefs ??= {})[phase] = new WeakRef(value);
    }
  }
}

/** Read newest retained results for one pool without exposing mutable state. */
export function pgResultDiagnosticSnapshot(
  pool: string,
  limit = PG_RESULT_DIAGNOSTIC_LIMIT,
  options: { includeObjectRefs?: boolean } = {},
): PgResultDiagnosticSnapshot {
  const s = STATE.pools.get(pool);
  const all = s?.pgResults ?? [];
  const totalRecorded = s?.totalPgResults ?? 0;
  const appliedLimit = Math.max(0, Math.min(PG_RESULT_DIAGNOSTIC_LIMIT, Math.floor(limit)));
  const allFailures = s?.pgFailures ?? [];
  const totalFailures = s?.totalPgFailures ?? 0;
  const appliedFailureLimit = Math.min(PG_FAILURE_DIAGNOSTIC_LIMIT, appliedLimit);
  const results =
    appliedLimit === 0
      ? []
      : all.slice(-appliedLimit).map(({ objectRefs, ...item }) => ({
          ...item,
          source: { ...item.source },
          ...(item.correlation ? { correlation: { ...item.correlation } } : {}),
          ...(options.includeObjectRefs && objectRefs ? { objectRefs: { ...objectRefs } } : {}),
        }));
  const failures =
    appliedFailureLimit === 0
      ? []
      : allFailures.slice(-appliedFailureLimit).map((item) => ({
          ...item,
          source: { ...item.source },
          ...(item.correlation ? { correlation: { ...item.correlation } } : {}),
        }));
  return {
    pool,
    capacity: PG_RESULT_DIAGNOSTIC_LIMIT,
    totalRecorded,
    dropped: Math.max(0, totalRecorded - all.length),
    results,
    failureCapacity: PG_FAILURE_DIAGNOSTIC_LIMIT,
    totalFailures,
    droppedFailures: Math.max(0, totalFailures - allFailures.length),
    failures,
  };
}

/**
 * Record a pool's configured `max` at construction time. Called from
 * `buildClient` so the error can say "18 waiting against a max of 20" without
 * reaching into postgres-js internals (its queue and connection lists live in a
 * closure; only `options.max` is public, and only once you hold the client).
 */
export function recordPoolMax(pool: string, max: number): void {
  if (!pool || !Number.isFinite(max)) return;
  poolState(pool).max = Math.max(1, Math.floor(max));
}

function recordRequestAcquireTiming(
  context: PgAcquireTimingContext | undefined,
  timing: PgAcquireTiming,
): void {
  if (!context) return;
  if (context.acquisitions.length >= PG_ACQUIRE_TIMING_LIMIT) {
    context.omitted += 1;
    return;
  }
  context.acquisitions.push(Object.freeze({ ...timing }));
}

/**
 * Start tracking one acquisition on `pool`. Call `acquired()` the moment a
 * connection is in hand and `release()` when the acquisition is over — the
 * caller MUST release from a `finally`, or a stuck acquisition leaks a waiter
 * and inflates every later snapshot.
 */
export function beginAcquire(pool: string): AcquireTicket {
  const s = poolState(pool);
  const id = ++STATE.seq;
  const startedAt = Date.now();
  s.waiting.set(id, startedAt);
  const requestContext = acquireTimingStorage.getStore();
  const diagnostic = capturePgDiagnosticContext();
  const correlation = diagnostic.state === 'linked' ? diagnostic.correlation : undefined;
  if (correlation?.requestId) {
    s.ticketContexts?.set(id, {
      requestId: correlation.requestId,
      operation: correlation.operation ?? null,
    });
  }
  let done = false;
  return {
    acquired(): void {
      if (done) return;
      if (!s.waiting.delete(id)) return; // already moved
      const acquiredAt = Date.now();
      recordRequestAcquireTiming(requestContext, {
        pool,
        elapsedMs: Math.max(0, acquiredAt - startedAt),
        outcome: 'acquired',
      });
      s.held.set(id, acquiredAt);
      s.totalAcquired += 1;
      s.lastAcquiredAt = acquiredAt;
    },
    release(): void {
      if (done) return;
      done = true;
      if (s.waiting.delete(id)) {
        recordRequestAcquireTiming(requestContext, {
          pool,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          outcome: 'released-before-acquire',
        });
      }
      s.held.delete(id);
      s.ticketContexts?.delete(id);
    },
  };
}

function oldestAgeMs(m: Map<number, number>, now: number): number | null {
  let oldest: number | null = null;
  for (const startedAt of m.values()) {
    if (oldest === null || startedAt < oldest) oldest = startedAt;
  }
  return oldest === null ? null : Math.max(0, now - oldest);
}

/**
 * Point-in-time view of one pool. A pool this process never built and never
 * acquired on returns all-zero with `max: null` — read that as NOT MEASURED,
 * never as "the pool is idle".
 */
export function acquireSnapshot(pool: string): AcquireSnapshot {
  const s = STATE.pools.get(pool);
  const now = Date.now();
  if (!s) {
    return {
      pool,
      waiting: 0,
      oldestWaitMs: null,
      held: 0,
      oldestHeldMs: null,
      max: null,
      totalAcquired: 0,
      lastAcquiredAgoMs: null,
    };
  }
  return {
    pool,
    waiting: s.waiting.size,
    oldestWaitMs: oldestAgeMs(s.waiting, now),
    held: s.held.size,
    oldestHeldMs: oldestAgeMs(s.held, now),
    max: s.max,
    totalAcquired: s.totalAcquired,
    lastAcquiredAgoMs: s.lastAcquiredAt === null ? null : Math.max(0, now - s.lastAcquiredAt),
  };
}

/**
 * Copy a small, oldest-first view of active acquisition tickets. Only the
 * sanitized request/operation labels captured when each ticket opened are
 * retained; no query text, owner/session IDs, or connection details enter the
 * snapshot. This remains an in-memory read on the deadline path.
 */
export function acquireTicketSnapshot(pool: string): AcquireTicketSnapshot {
  const s = STATE.pools.get(pool);
  if (!s) {
    return { pool, capacity: ACQUIRE_TICKET_DIAGNOSTIC_LIMIT, active: 0, omitted: 0, tickets: [] };
  }
  const now = Date.now();
  const active = [
    ...Array.from(s.waiting, ([id, startedAt]) => ({ id, state: 'waiting' as const, startedAt })),
    ...Array.from(s.held, ([id, startedAt]) => ({ id, state: 'held' as const, startedAt })),
  ].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  const tickets = active.slice(0, ACQUIRE_TICKET_DIAGNOSTIC_LIMIT).map(({ id, state, startedAt }) => {
    const context = s.ticketContexts?.get(id);
    return {
      state,
      ageMs: Math.max(0, now - startedAt),
      requestId: context?.requestId ?? null,
      operation: context?.operation ?? null,
    };
  });
  return {
    pool,
    capacity: ACQUIRE_TICKET_DIAGNOSTIC_LIMIT,
    active: active.length,
    omitted: Math.max(0, active.length - tickets.length),
    tickets,
  };
}

function fmtAge(ms: number | null): string {
  if (ms === null) return 'n/a';
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * What the counters concluded.
 *
 * `client-saturation` and `queued` both RULE OUT a dead endpoint, so they are
 * `decisive` — the caller should print a short "where is the queue" residual
 * instead of the full dead-endpoint-vs-saturation procedure. `never-acquired`
 * and `stale-success` leave the fork open, so the full procedure still applies.
 */
export type AcquireVerdict = 'never-acquired' | 'stale-success' | 'queued' | 'client-saturation';

export interface AcquirePressureReport {
  /** Numbers first, then the ONE conclusion they license, then their honest bound. */
  text: string;
  verdict: AcquireVerdict;
  /** True when the measurement settles the dead-endpoint-vs-saturation fork by itself. */
  decisive: boolean;
}

/**
 * The measured lead for a deadline error.
 *
 * Returns null when nothing was measured for `pool` (no ticket has ever been
 * opened and the pool was never built here) — the caller then falls back to the
 * manual discriminator, rather than printing a row of confident zeroes.
 */
export function describeAcquirePressure(pool: string): AcquirePressureReport | null {
  const s = acquireSnapshot(pool);
  if (s.max === null && s.totalAcquired === 0 && s.waiting === 0 && s.held === 0) return null;

  const counts =
    `MEASURED IN THIS PROCESS (pid ${process.pid}), pool "${s.pool}": ` +
    `${s.waiting} acquisition(s) WAITING (oldest ${fmtAge(s.oldestWaitMs)}), ` +
    `${s.held} HELD at this seam (oldest ${fmtAge(s.oldestHeldMs)}), ` +
    `pool max ${s.max ?? 'unknown'}; last successful acquisition on this pool ` +
    `${s.lastAcquiredAgoMs === null ? 'NEVER' : `${fmtAge(s.lastAcquiredAgoMs)} ago`} ` +
    `(${s.totalAcquired} total this process).`;

  let verdict: AcquireVerdict;
  let conclusion: string;
  if (s.totalAcquired === 0) {
    verdict = 'never-acquired';
    conclusion =
      ` ⇒ this pool has NEVER obtained a connection in this process, which is what (a) a dead/` +
      `unreachable endpoint looks like — but a pooler queue that never granted a slot looks the ` +
      `same, so confirm with the steps below before declaring the endpoint dead.`;
  } else if (s.lastAcquiredAgoMs !== null && s.lastAcquiredAgoMs <= ACQUIRE_RECENT_SUCCESS_MS) {
    conclusion =
      ` ⇒ this pool obtained a connection ${fmtAge(s.lastAcquiredAgoMs)} ago, so (a) a dead endpoint ` +
      `is RULED OUT for this pool — you are queued, not disconnected.`;
    if (s.max !== null && s.held >= s.max) {
      verdict = 'client-saturation';
      conclusion +=
        ` And ${s.held} held ≥ max ${s.max}: this CLIENT pool is at its ceiling from this ` +
        `measurement alone, so (b) is CONFIRMED — raise PAPERCUSP_DB_POOL_MAX or reduce ` +
        `concurrency in THIS process; the server's spare capacity is irrelevant.`;
    } else {
      verdict = 'queued';
    }
  } else {
    verdict = 'stale-success';
    conclusion =
      ` ⇒ this pool DID work earlier but has not obtained a connection for ` +
      `${fmtAge(s.lastAcquiredAgoMs)}, so a previously-good endpoint going away is live again — ` +
      `note the resolved URL is memoized for the process lifetime.`;
  }

  const bound =
    ` (These counts cover acquisitions through withWorkspace/withHarnessSchema in THIS process ` +
    `only: direct pool users are not counted, so HELD is a LOWER BOUND and held < max does NOT ` +
    `mean free slots — and a sibling process, e.g. one vitest worker of ~15, has its own pool ` +
    `entirely.)`;

  return {
    text: counts + conclusion + bound,
    verdict,
    decisive: verdict === 'queued' || verdict === 'client-saturation',
  };
}

/**
 * The residual question after a DECISIVE verdict. The cause is settled; only
 * WHERE the queue lives is still open, and that is two lookups rather than the
 * full three-step cause procedure.
 *
 * Kept here, beside the verdict that selects it, so the two cannot drift — and
 * deliberately still naming `SHOW POOLS` / `application_name` /
 * `PAPERCUSP_DB_POOL_MAX`, because a decisive verdict about THIS process says
 * nothing about the pooler's own queue or a sibling process's pool.
 */
export const ACQUIRE_QUEUE_LOCATION_RESIDUAL =
  `The CAUSE is settled by the numbers above; only WHERE the queue sits is still open — ` +
  `(1) behind PgBouncer, "SHOW POOLS" on :6432: cl_waiting > 0 or maxwait > 0 means the queue ` +
  `is at the POOLER (its default_pool_size), not in this process; (2) otherwise group ` +
  `pg_stat_activity by application_name and compare this process's own pcusp:org-*:p<pid> row ` +
  `and its siblings' against PAPERCUSP_DB_POOL_MAX. Note a per-statement timeout does not help ` +
  `either way: it bounds how long each slot is HELD, not the wait to acquire one.`;

/** Test-only: drop every pool's counters. */
export function resetAcquireRegistryForTest(): void {
  STATE.pools.clear();
  STATE.seq = 0;
  resetPgQueryFamilyMemoForTest();
}
