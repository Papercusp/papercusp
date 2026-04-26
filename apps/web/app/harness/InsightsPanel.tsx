'use client';

import { useEffect, useMemo } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, STATUS_ORDER, HarnessStatus } from './theme';
import { IconButton } from './primitives';

interface Feature {
  id: string;
  status: HarnessStatus;
  attempts: number;
  title: string;
}

interface Props {
  features: Feature[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  iteration: number;
  onClose: () => void;
  inline?: boolean;
}

export default function InsightsPanel({
  features, totalCostUsd, totalInputTokens, totalOutputTokens, iteration, onClose, inline = false,
}: Props) {
  const stats = useMemo(() => {
    const byStatus: Record<HarnessStatus, number> = {
      todo: 0, in_progress: 0, validating: 0, failing: 0, blocked: 0, passed: 0,
    };
    let totalAttempts = 0;
    let stuckCount = 0;
    const attemptsHist = [0, 0, 0, 0, 0]; // 0, 1, 2, 3+, 5+
    for (const f of features) {
      byStatus[f.status]++;
      totalAttempts += f.attempts;
      if (f.attempts >= 3) stuckCount++;
      if (f.attempts === 0) attemptsHist[0]++;
      else if (f.attempts === 1) attemptsHist[1]++;
      else if (f.attempts === 2) attemptsHist[2]++;
      else if (f.attempts < 5) attemptsHist[3]++;
      else attemptsHist[4]++;
    }
    const passed = byStatus.passed;
    const failRate = features.length ? stuckCount / features.length : 0;
    const avgAttemptsPerPassed = passed > 0 ? totalAttempts / passed : 0;
    const costPerPassed = passed > 0 ? totalCostUsd / passed : 0;
    return { byStatus, totalAttempts, stuckCount, attemptsHist, failRate, avgAttemptsPerPassed, costPerPassed, passed };
  }, [features, totalCostUsd]);

  const maxStatusCount = Math.max(1, ...Object.values(stats.byStatus));
  const maxAttemptsBin = Math.max(1, ...stats.attemptsHist);

  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, inline]);

  const inner = (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width: inline ? '100%' : 'min(720px, 94vw)',
        height: inline ? '100%' : undefined,
        maxHeight: inline ? '100%' : '88vh',
        background: COLORS.surfaceRaised,
        border: inline ? 'none' : `1px solid ${COLORS.borderStrong}`,
        borderRadius: inline ? 0 : 8,
        boxShadow: inline ? 'none' : '0 20px 50px rgba(0,0,0,0.5)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${COLORS.border}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontSize: SIZES.md, color: COLORS.text, fontWeight: 600 }}>Insights</div>
        <span style={{ fontSize: SIZES.xs, color: COLORS.textDim }}>iteration {iteration} · {features.length} features</span>
        {!inline && (
          <span style={{ marginLeft: 'auto' }}>
            <IconButton onClick={onClose}>close</IconButton>
          </span>
        )}
      </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Top KPIs */}
          <KpiCard label="Passed" value={`${stats.passed}/${features.length}`} sub={`${Math.round(100 * stats.passed / Math.max(1, features.length))}%`} />
          <KpiCard label="Stuck (≥3 attempts)" value={String(stats.stuckCount)} sub={stats.stuckCount > 0 ? `${Math.round(stats.failRate * 100)}% of work` : 'none'} color={stats.stuckCount > 0 ? STATUS.blocked.text : COLORS.text} />
          <KpiCard label="Mission cost" value={`$${totalCostUsd.toFixed(2)}`} sub={`${(totalInputTokens/1000).toFixed(0)}k in · ${(totalOutputTokens/1000).toFixed(0)}k out`} />
          <KpiCard
            label="Cost per passed feature"
            value={stats.passed > 0 ? `$${stats.costPerPassed.toFixed(2)}` : '—'}
            sub={stats.avgAttemptsPerPassed > 0 ? `avg ${stats.avgAttemptsPerPassed.toFixed(1)} attempts` : ''}
          />

          {/* Status distribution bar chart */}
          <div style={{ gridColumn: '1 / -1' }}>
            <SectionTitle>Status distribution</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {STATUS_ORDER.map((st) => {
                const count = stats.byStatus[st];
                const s = STATUS[st];
                const pct = (count / maxStatusCount) * 100;
                return (
                  <div key={st} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 40px', alignItems: 'center', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: SIZES.xs, color: s.text }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.solid }} />
                      {s.label}
                    </div>
                    <div style={{ background: COLORS.bg, borderRadius: 2, height: 14, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: s.solid, transition: 'width 300ms' }} />
                    </div>
                    <div style={{ fontFamily: FONTS.mono, fontSize: SIZES.xs, color: COLORS.text, textAlign: 'right' }}>
                      {count}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Attempts histogram */}
          <div style={{ gridColumn: '1 / -1' }}>
            <SectionTitle>Attempts histogram</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              {stats.attemptsHist.map((count, i) => {
                const labels = ['0', '1', '2', '3-4', '5+'];
                const color = i < 2 ? COLORS.textMuted : i < 3 ? STATUS.in_progress.solid : i < 4 ? STATUS.blocked.solid : STATUS.failing.solid;
                const pct = (count / maxAttemptsBin) * 100;
                return (
                  <div key={i} style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 4,
                    padding: 8,
                    background: COLORS.bg,
                    borderRadius: RADIUS.sm,
                    border: `1px solid ${COLORS.borderSubtle}`,
                  }}>
                    <div style={{
                      width: '100%', height: 60, display: 'flex', alignItems: 'flex-end',
                    }}>
                      <div style={{
                        width: '100%',
                        height: `${pct}%`,
                        background: color,
                        borderRadius: 2,
                        transition: 'height 300ms',
                      }} />
                    </div>
                    <div style={{ fontFamily: FONTS.mono, fontSize: SIZES.base, color: COLORS.text, fontWeight: 600 }}>
                      {count}
                    </div>
                    <div style={{ fontSize: SIZES.xs, color: COLORS.textDim }}>
                      {labels[i]} attempts
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Stuck features list */}
          {stats.stuckCount > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <SectionTitle>
                Stuck features <span style={{ color: STATUS.blocked.text }}>· {stats.stuckCount}</span>
              </SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {features
                  .filter((f) => f.attempts >= 3)
                  .sort((a, b) => b.attempts - a.attempts)
                  .map((f) => {
                    const s = STATUS[f.status];
                    return (
                      <div key={f.id} style={{
                        display: 'grid',
                        gridTemplateColumns: '90px auto minmax(0, 1fr) 40px',
                        alignItems: 'center', gap: 10,
                        padding: '5px 8px',
                        background: COLORS.bg,
                        border: `1px solid ${COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        fontSize: SIZES.xs,
                      }}>
                        <span style={{ fontFamily: FONTS.mono, color: COLORS.textMuted }}>{f.id}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: s.text }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.solid }} />
                          {s.label}
                        </span>
                        <span style={{ color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.title}
                        </span>
                        <span style={{ fontFamily: FONTS.mono, color: STATUS.blocked.text, textAlign: 'right' }}>
                          ×{f.attempts}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
  );

  if (inline) return inner;

  return (
    <div
      data-harness-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}
    >
      {inner}
    </div>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{
      background: COLORS.bg,
      border: `1px solid ${COLORS.borderSubtle}`,
      borderRadius: RADIUS.sm,
      padding: '10px 12px',
    }}>
      <div style={{ fontSize: '0.65rem', color: COLORS.textDim, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.3rem', color: color ?? COLORS.text, fontWeight: 600, fontFamily: FONTS.mono, marginTop: 4 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: SIZES.xs, color: COLORS.textDim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '0.65rem',
      color: COLORS.textDim,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      fontWeight: 600,
      marginBottom: 8,
    }}>
      {children}
    </div>
  );
}
