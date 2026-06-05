/**
 * Subprocess usage-sample persistence (rate-limit-layer-v2 D-002, capture point 2;
 * backend-aware + run-attributed per cross-backend-cost-capture D-005).
 *
 * One row per finished governed subprocess run into `harness_shared.agent_usage_samples`
 * (migration 161 + 170): the token counts + $cost parsed from the run's JSONL terminal
 * events (`extractRunUsage` — claude `result`, codex `turn.completed`, omp `message_end`).
 * The subprocess path exposes NO provider rate-limit headers (the subscription CLI hides
 * them), so the `rl_*` columns stay NULL here — the in-process meridian capture point
 * (operator-core `agent-usage-telemetry.ts`) fills those where they exist.
 *
 * Cost honesty (D-005): provider-reported cost wins (`cost_source='provider'` — claude
 * `total_cost_usd`, omp `usage.cost.total`); a tokens-only run (codex) is priced from
 * `@papercusp/model-pricing` list prices (`cost_source='estimated'`); an unpriceable run
 * persists NULL cost — never a fabricated zero. `harness_slug`/`run_id`/`role` make the
 * samples table the per-harness spend source (PG-canonical runs write no files, so the
 * FS-mirror `agent_runs_consolidated` cannot serve spend — see plan D-004).
 *
 * Best-effort: telemetry must never fail a run.
 *
 * The provider/model-class derivation mirrors `@papercusp/papercup-shared/agent`'s
 * `BACKEND_PROFILES` + `modelClassOf` — duplicated as tiny pure helpers because this
 * package does not (and should not) depend on papercup-shared.
 */
import { costFromTokens } from '@papercusp/model-pricing';
import type { OrchestratorPg } from './invoke';
import type { RunUsage } from './cost-cap';

export interface UsageSamplePgContext {
  pg: OrchestratorPg;
  workspaceId: string;
}

/** Backend → provider, mirroring papercup-shared's BACKEND_PROFILES. */
export function providerForBackend(backend: string): string {
  if (backend === 'claude-code' || backend === 'meridian') return 'anthropic';
  if (backend === 'codex') return 'openai';
  return 'unknown'; // omp is model-agnostic / multi-provider
}

/** Model string → bucket class, mirroring papercup-shared's modelClassOf (omp → 'self'). */
export function modelClassForRun(backend: string, model: string): string {
  if (backend === 'omp') return 'self'; // self-pacing backends collapse to one bucket
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'default';
}

export interface UsageSampleRun {
  backend: string;
  /** The model the spawn requested (resolvedModel). `usage.model` — the stream-reported actual — wins when present. */
  model: string;
  usage: RunUsage;
  harnessSlug?: string;
  runId?: string;
  role?: string;
}

/** INSERT one usage sample. Caller passes the parsed `RunUsage`; no-ops on an empty one. */
export async function recordUsageSamplePg(
  ctx: UsageSamplePgContext,
  run: UsageSampleRun,
): Promise<void> {
  const { usage } = run;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.costUsd === undefined) return;
  const provider = providerForBackend(run.backend);
  const modelClass = modelClassForRun(run.backend, run.model);
  const model = usage.model ?? run.model;
  const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Provider-reported cost wins; else estimate from list prices; else NULL (never a fake 0).
  let costUsd: number | null = n(usage.costUsd);
  let costSource: string | null = costUsd !== null ? 'provider' : null;
  if (costUsd === null && model) {
    const est = costFromTokens(model, usage);
    if (est.priced) {
      costUsd = est.usd;
      costSource = 'estimated';
    }
  }

  await ctx.pg`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cost_usd,
       model, cost_source, harness_slug, run_id, role)
    VALUES (
      ${ctx.workspaceId}, ${Date.now()}, ${`${provider}:${modelClass}`}, ${provider}, ${modelClass}, ${'jsonl'},
      ${n(usage.inputTokens)}, ${n(usage.outputTokens)}, ${n(usage.cacheReadTokens)}, ${costUsd},
      ${model || null}, ${costSource}, ${run.harnessSlug ?? null}, ${run.runId ?? null}, ${run.role ?? null}
    )
  `;
}
