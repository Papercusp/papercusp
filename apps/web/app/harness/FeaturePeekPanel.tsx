'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus } from './theme';
import { StatusPill, IdPill, RolePill, IconButton, KbdHint } from './primitives';

const FeatureTimelinePanel = dynamic(() => import('./FeatureTimelinePanel'), { ssr: false });

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: HarnessStatus;
  attempts: number;
  summary?: string;
}

interface AgentRun {
  runId: string;
  role: string;
  ts: number;
  sizeBytes: number;
  running?: boolean;
}

interface Props {
  slug: string;
  feature: Feature | null;
  agents: AgentRun[];
  issues: string;
  onClose: () => void;
  onReset: (id: string) => void;
  onEdit: (f: Feature) => void;
  onInspectRun: (runId: string) => void;
  onSetStatus: (id: string, status: HarnessStatus) => void;
}

export default function FeaturePeekPanel({
  slug, feature, agents, issues, onClose, onReset, onEdit, onInspectRun, onSetStatus,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [debugNote, setDebugNote] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Fetch PR URL (if branchIsolation.onPass=pr has opened one for this feature).
  useEffect(() => {
    if (!feature) return;
    fetch(`/api/harness/${slug}/prs`)
      .then((r) => r.json())
      .then((d) => setPrUrl(d.prs?.[feature.id]?.url ?? null))
      .catch(() => setPrUrl(null));
  }, [slug, feature?.id]);

  // Fetch debug note (if debugger role has investigated this feature).
  useEffect(() => {
    if (!feature) { setDebugNote(null); setShowDebug(false); return; }
    fetch(`/api/harness/${slug}/debug-notes/${feature.id}`)
      .then((r) => r.json())
      .then((d) => setDebugNote(d.content ?? null))
      .catch(() => setDebugNote(null));
    setShowDebug(false);
  }, [slug, feature?.id]);

  // Filter issues.md excerpt to lines mentioning this feature id
  const issuesForFeature = useMemo(() => {
    if (!feature || !issues) return '';
    const lines = issues.split('\n');
    const re = new RegExp(feature.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Extract contiguous blocks containing the feature id
    const chunks: string[] = [];
    let current: string[] = [];
    let hit = false;
    for (const l of lines) {
      if (/^##\s/.test(l)) {
        if (hit && current.length) chunks.push(current.join('\n'));
        current = [l];
        hit = re.test(l);
      } else {
        current.push(l);
        if (!hit && re.test(l)) hit = true;
      }
    }
    if (hit && current.length) chunks.push(current.join('\n'));
    return chunks.join('\n\n').trim();
  }, [feature, issues]);

  // Find agent runs plausibly linked to this feature. Backend doesn't tag
  // runs with feature id yet, so we approximate: surrounding window of any
  // run in a state-transition period for this feature. For now just show
  // recent runs as "context."
  const recentRuns = useMemo(() => {
    if (!feature) return [];
    return agents.slice(0, 8);
  }, [feature, agents]);

  useEffect(() => {
    // Close on escape
    if (!feature) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [feature, onClose]);

  if (!feature) return null;

  const s = STATUS[feature.status];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          height: '100%',
          background: COLORS.surfaceRaised,
          borderLeft: `1px solid ${COLORS.borderStrong}`,
          boxShadow: '-12px 0 30px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', gap: 10,
          flexShrink: 0,
        }}>
          <IdPill id={feature.id} onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }} />
          {copied && <span style={{ fontSize: SIZES.xs, color: COLORS.successText }}>copied</span>}
          <StatusPill status={feature.status} />
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={prUrl}
              style={{
                fontSize: SIZES.xs,
                color: '#3b82f6',
                textDecoration: 'none',
                padding: '2px 8px',
                border: '1px solid #1e40af',
                borderRadius: RADIUS.sm,
                background: 'color-mix(in oklab, #3b82f6, transparent 85%)',
              }}
            >
              View PR ↗
            </a>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <IconButton onClick={() => onEdit(feature)} title="Edit feature (E)">edit</IconButton>
            <IconButton onClick={() => onReset(feature.id)} title="Reset to todo, attempts=0 (R)">reset</IconButton>
            <IconButton onClick={onClose} variant="ghost" title="Close (Esc)">✕</IconButton>
          </span>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
          <h2 style={{
            margin: 0, marginBottom: feature.summary ? 6 : 12,
            fontSize: SIZES.lg, fontWeight: 600, color: COLORS.text,
            lineHeight: 1.3,
          }}>
            {feature.summary || feature.title}
          </h2>
          {feature.summary && (
            <div style={{
              fontFamily: FONTS.mono,
              fontSize: SIZES.xs,
              color: COLORS.textDim,
              marginBottom: 12,
            }}>{feature.title}</div>
          )}

          {/* Property rail */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 14, rowGap: 6,
            fontSize: SIZES.sm,
            marginBottom: 18,
            paddingBottom: 14,
            borderBottom: `1px solid ${COLORS.borderSubtle}`,
          }}>
            <span style={{ color: COLORS.textDim }}>Status</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(['todo','in_progress','validating','failing','blocked','passed'] as HarnessStatus[]).map((st) => {
                const active = st === feature.status;
                const ss = STATUS[st];
                return (
                  <button
                    key={st}
                    onClick={() => onSetStatus(feature.id, st)}
                    disabled={active}
                    title={`Set status to ${ss.label}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '3px 8px',
                      background: active ? ss.bg : 'transparent',
                      border: `1px solid ${active ? ss.solid : COLORS.border}`,
                      borderRadius: RADIUS.sm,
                      fontSize: SIZES.xs,
                      color: active ? ss.text : COLORS.textMuted,
                      cursor: active ? 'default' : 'pointer',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: ss.solid }} />
                    {ss.label}
                  </button>
                );
              })}
            </div>

            <span style={{ color: COLORS.textDim }}>Attempts</span>
            <span style={{
              color: feature.attempts >= 3 ? STATUS.blocked.text : COLORS.text,
              fontFamily: FONTS.mono,
            }}>
              {feature.attempts}
              {feature.attempts >= 3 && <span style={{ color: COLORS.textDim, marginLeft: 6 }}>(stuck)</span>}
            </span>
          </div>

          {/* Claims */}
          {feature.claims && feature.claims.length > 0 && (
            <Section title="Claims">
              <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.text, fontSize: SIZES.sm, lineHeight: 1.6 }}>
                {feature.claims.map((c, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{c}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Debugger notes, if the debugger role has investigated this feature */}
          {debugNote && (
            <Section title="Debugger notes">
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setShowDebug((v) => !v)}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${COLORS.borderSubtle}`,
                    color: COLORS.text,
                    padding: '4px 10px',
                    borderRadius: RADIUS.sm,
                    cursor: 'pointer',
                    fontSize: SIZES.sm,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span>{showDebug ? '▾' : '▸'}</span>
                  <span>Root-cause investigation ({debugNote.length.toLocaleString()} chars) · from debugger role</span>
                </button>
              </div>
              {showDebug && (
                <pre style={{
                  background: COLORS.bg, color: COLORS.text,
                  padding: '10px 12px', borderRadius: RADIUS.sm,
                  fontFamily: FONTS.mono, fontSize: SIZES.xs,
                  whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto',
                  margin: 0, border: `1px solid ${COLORS.borderSubtle}`,
                }}>{debugNote}</pre>
              )}
            </Section>
          )}

          {/* Related runs */}
          <Section title={`Recent agent runs${recentRuns.length ? ` · ${recentRuns.length}` : ''}`}>
            {recentRuns.length === 0 ? (
              <Empty>No runs yet</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentRuns.map((r) => (
                  <button
                    key={r.runId}
                    onClick={() => onInspectRun(r.runId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 8px',
                      background: 'transparent',
                      border: `1px solid ${COLORS.borderSubtle}`,
                      borderRadius: RADIUS.sm,
                      color: COLORS.text,
                      cursor: 'pointer',
                      fontSize: SIZES.sm,
                      textAlign: 'left',
                    }}
                  >
                    <RolePill role={r.role} />
                    <span style={{ fontFamily: FONTS.mono, color: COLORS.textMuted, fontSize: SIZES.xs }}>
                      {r.runId.slice(-20)}
                    </span>
                    <span style={{ marginLeft: 'auto', color: COLORS.textDim, fontSize: SIZES.xs }}>
                      {new Date(r.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {/* Issues for this feature */}
          {issuesForFeature && (
            <Section title="Validator issues">
              <pre style={{
                margin: 0,
                fontFamily: FONTS.mono,
                fontSize: SIZES.xs,
                color: COLORS.text,
                background: COLORS.bg,
                border: `1px solid ${COLORS.borderSubtle}`,
                borderRadius: RADIUS.sm,
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
                maxHeight: 300,
                overflow: 'auto',
              }}>
                {issuesForFeature}
              </pre>
            </Section>
          )}

          {/* Actions row */}
          <div style={{
            marginTop: 18, padding: '10px 0',
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <button
              onClick={() => setShowTimeline(true)}
              style={{
                background: 'transparent',
                border: `1px solid ${COLORS.borderSubtle}`,
                color: COLORS.text,
                padding: '5px 12px',
                borderRadius: RADIUS.sm,
                cursor: 'pointer',
                fontSize: SIZES.sm,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
              title="Aggregate snapshots, agent runs, debug notes, and PR metadata into one timeline"
            >
              🕰 View timeline
            </button>
            <span style={{ marginLeft: 'auto', fontSize: SIZES.xs, color: COLORS.textDim, display: 'flex', gap: 10 }}>
              <span><KbdHint>E</KbdHint> edit</span>
              <span><KbdHint>R</KbdHint> reset</span>
              <span><KbdHint>Esc</KbdHint> close</span>
            </span>
          </div>
        </div>
      </aside>

      {showTimeline && (
        <FeatureTimelinePanel
          slug={slug}
          featureId={feature.id}
          onClose={() => setShowTimeline(false)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontSize: '0.65rem',
        color: COLORS.textDim,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontWeight: 600,
        marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: SIZES.sm, color: COLORS.textDim, fontStyle: 'italic' }}>
      {children}
    </div>
  );
}
