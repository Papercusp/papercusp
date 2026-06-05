/**
 * Subprocess usage-sample persistence (rate-limit-layer-v2 D-002, capture point 2).
 *
 * One row per finished governed subprocess run into `harness_shared.agent_usage_samples`
 * (migration 161): the token counts + $cost parsed from the run's JSONL `result` event
 * (`extractRunUsage`). The subprocess path exposes NO provider rate-limit headers (the
 * subscription CLI hides them), so the `rl_*` columns stay NULL here — the in-process
 * meridian capture point (operator-core `agent-usage-telemetry.ts`) fills those where they
 * exist. Best-effort: telemetry must never fail a run.
 *
 * The provider/model-class derivation mirrors `@papercusp/papercup-shared/agent`'s
 * `BACKEND_PROFILES` + `modelClassOf` — duplicated as tiny pure helpers because this
 * package does not (and should not) depend on papercup-shared.
 */
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

/** INSERT one usage sample. Caller passes the parsed `RunUsage`; no-ops on an empty one. */
export async function recordUsageSamplePg(
  ctx: UsageSamplePgContext,
  run: { backend: string; model: string; usage: RunUsage },
): Promise<void> {
  const { usage } = run;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.costUsd === undefined) return;
  const provider = providerForBackend(run.backend);
  const modelClass = modelClassForRun(run.backend, run.model);
  const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  await ctx.pg`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cost_usd)
    VALUES (
      ${ctx.workspaceId}, ${Date.now()}, ${`${provider}:${modelClass}`}, ${provider}, ${modelClass}, ${'jsonl'},
      ${n(usage.inputTokens)}, ${n(usage.outputTokens)}, ${n(usage.cacheReadTokens)}, ${n(usage.costUsd)}
    )
  `;
}
