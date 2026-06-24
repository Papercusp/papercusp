/**
 * Deterministic ramp-gate for the operator-hosted `worker:chunk-loop` rollout
 * (worker-chunk-loop-operator-hosted-2026-06-14 P-021). The PURE decision logic — given
 * the P-020 outcome metrics (op vs subprocess) — that RECOMMENDS whether the cohort may
 * advance one ramp step (off → 25% → 50% → 100%), must HOLD, or should ROLL BACK.
 *
 * This is a RECOMMENDER, not an executor: the actual cohort %-advance is owner-gated per
 * step (D-003 — the workerMode flag ships incomplete-until-ramped). It mirrors
 * waves.ts `decideWaveAdvance` — a pure function the owner/operator (or a future deterministic
 * sweep) reads before approving a step, so "the ramp gates on metrics at-or-better than
 * baseline" is data, not vibes.
 *
 * The gate is intentionally conservative: it advances only on a SUFFICIENT op sample AND
 * completion-rate parity AND no op-specific planning_failed spike (the D-005 risk: a
 * mis-built operator-side InvokeContext shows up as the op path failing to PLAN, which
 * completion-rate alone can mask if the few that plan then complete). It recommends
 * rollback the moment the op path regresses past the threshold.
 */
import type { WorkerChunkMetrics, WorkerChunkPathMetrics } from './worker-chunk-outcome-pg.js';

export type RampStep = 0 | 25 | 50 | 100;
export const RAMP_STEPS: readonly RampStep[] = [0, 25, 50, 100];

export interface RampThresholds {
  /** Minimum op-path runs before ANY advance is considered (statistical floor). */
  minOpSamples: number;
  /** op completionRate may sit at most this far BELOW subprocess and still be "parity". */
  completionParityTolerance: number;
  /** op completionRate this far below subprocess (or worse) ⇒ recommend ROLLBACK. */
  regressionThreshold: number;
  /** op planning_failed RATE may exceed subprocess by at most this (the D-005 ctx-build guard). */
  maxPlanningFailedRateDelta: number;
}

export const DEFAULT_RAMP_THRESHOLDS: RampThresholds = {
  minOpSamples: 20,
  completionParityTolerance: 0.02,
  regressionThreshold: 0.05,
  maxPlanningFailedRateDelta: 0.05,
};

export interface RampDecision {
  decision: 'advance' | 'hold' | 'rollback';
  fromStep: RampStep;
  toStep: RampStep;
  reasons: string[];
}

const nextStep = (s: RampStep): RampStep => {
  const i = RAMP_STEPS.indexOf(s);
  return i < 0 || i >= RAMP_STEPS.length - 1 ? s : RAMP_STEPS[i + 1];
};
const prevStep = (s: RampStep): RampStep => {
  const i = RAMP_STEPS.indexOf(s);
  return i <= 0 ? s : RAMP_STEPS[i - 1];
};

const planningFailedRate = (p: WorkerChunkPathMetrics): number =>
  p.total === 0 ? 0 : p.distribution.planning_failed / p.total;

/**
 * Recommend a ramp action from the current step + the latest P-020 metrics. Pure +
 * exhaustively unit-tested. NEVER advances past 100 / below 0. Conservative: any of
 * {regression, planning_failed spike} ⇒ rollback; advance needs sample + parity + no spike.
 */
export function decideRampAdvance(
  metrics: WorkerChunkMetrics,
  currentStep: RampStep,
  thresholds: RampThresholds = DEFAULT_RAMP_THRESHOLDS,
): RampDecision {
  const sub = metrics.byPath.subprocess;
  const op = metrics.byPath.op;
  const reasons: string[] = [];
  const hold = (): RampDecision => ({ decision: 'hold', fromStep: currentStep, toStep: currentStep, reasons });
  const haveBoth = sub.completionRate != null && op.completionRate != null;

  // ── ROLLBACK checks (run first; apply at any step that has op traffic) ──
  if (op.total >= thresholds.minOpSamples && haveBoth) {
    const compGap = (sub.completionRate as number) - (op.completionRate as number); // >0 ⇒ op worse
    if (compGap > thresholds.regressionThreshold) {
      reasons.push(
        `op completion-rate ${(op.completionRate as number).toFixed(3)} is ${compGap.toFixed(3)} below subprocess ${(sub.completionRate as number).toFixed(3)} (> regressionThreshold ${thresholds.regressionThreshold}) — regression`,
      );
    }
    const pfDelta = planningFailedRate(op) - planningFailedRate(sub);
    if (pfDelta > thresholds.maxPlanningFailedRateDelta) {
      reasons.push(
        `op planning_failed rate ${planningFailedRate(op).toFixed(3)} exceeds subprocess ${planningFailedRate(sub).toFixed(3)} by ${pfDelta.toFixed(3)} (> ${thresholds.maxPlanningFailedRateDelta}) — likely a broken operator-side InvokeContext (D-005)`,
      );
    }
    if (reasons.length > 0) {
      return { decision: 'rollback', fromStep: currentStep, toStep: prevStep(currentStep), reasons };
    }
  }

  // ── Terminal: already at 100% with no regression ⇒ hold (fully ramped) ──
  if (currentStep === 100) {
    reasons.push('cohort fully ramped at 100% with no regression — hold');
    return hold();
  }

  // ── ADVANCE gate ──
  if (op.total < thresholds.minOpSamples) {
    reasons.push(`insufficient op samples: ${op.total}/${thresholds.minOpSamples} — hold for more dark-launch data`);
    return hold();
  }
  if (!haveBoth) {
    reasons.push('missing a baseline completion-rate for one path — hold');
    return hold();
  }
  const compGap = (sub.completionRate as number) - (op.completionRate as number);
  if (compGap > thresholds.completionParityTolerance) {
    reasons.push(
      `op completion-rate ${(op.completionRate as number).toFixed(3)} below subprocess ${(sub.completionRate as number).toFixed(3)} by ${compGap.toFixed(3)} (> parity tolerance ${thresholds.completionParityTolerance}) — not yet at parity, hold`,
    );
    return hold();
  }
  reasons.push(
    `op at parity: completion-rate ${(op.completionRate as number).toFixed(3)} vs subprocess ${(sub.completionRate as number).toFixed(3)} over ${op.total} op runs; no planning_failed spike`,
  );
  return { decision: 'advance', fromStep: currentStep, toStep: nextStep(currentStep), reasons };
}
