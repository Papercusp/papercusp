'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, STATUS_ORDER, BOARD_COLUMN_ORDER, HarnessStatus, getStatusMeta } from './theme';
import { StatusPill, IdPill, IconButton, KbdHint } from './primitives';

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: HarnessStatus;
  attempts: number;
  summary?: string;
  labels?: string[];
}

type ViewMode = 'list' | 'board';

interface SavedView {
  id: string;
  name: string;
  filter: {
    statuses?: HarnessStatus[];
    minAttempts?: number;
    search?: string;
  };
}

const BUILT_IN_VIEWS: SavedView[] = [
  { id: 'all', name: 'All', filter: {} },
  { id: 'running', name: 'Running', filter: { statuses: ['in_progress', 'validating'] } },
  { id: 'stuck', name: 'Stuck', filter: { minAttempts: 3 } },
  { id: 'blocked', name: 'Blocked', filter: { statuses: ['blocked', 'failing'] } },
  { id: 'todo', name: 'Todo', filter: { statuses: ['todo'] } },
  { id: 'done', name: 'Passed', filter: { statuses: ['passed'] } },
];

interface Props {
  features: Feature[];
  activeFeatureId: string | null;
  onSelect: (f: Feature) => void;
  onReset: (id: string) => void;
  onAdd: () => void;
  onBatchReset: (ids: string[]) => void;
  onBatchDelete: (ids: string[]) => void;
}

export default function FeatureList({
  features, activeFeatureId, onSelect, onReset, onAdd, onBatchReset, onBatchDelete,
}: Props) {
  const [mode, setMode] = useState<ViewMode>('list');
  const [viewId, setViewId] = useState<string>('all');
  const [search, setSearch] = useState('');
  // Item 7 (2026-04-26): project + tag filters for the new project_id and tags fields
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);

  const view = BUILT_IN_VIEWS.find((v) => v.id === viewId) ?? BUILT_IN_VIEWS[0];

  // Item 7: derive project + tag filter options from current features
  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const f of features) if ((f as any).project_id) set.add((f as any).project_id);
    return Array.from(set).sort();
  }, [features]);

  const filtered = useMemo(() => {
    let out = features;
    if (view.filter.statuses) out = out.filter((f) => view.filter.statuses!.includes(f.status));
    if (view.filter.minAttempts != null) out = out.filter((f) => f.attempts >= view.filter.minAttempts!);
    if (projectFilter !== 'all') {
      out = out.filter((f) => (projectFilter === '__none' ? !(f as any).project_id : (f as any).project_id === projectFilter));
    }
    const tagQ = tagFilter.trim().toLowerCase();
    if (tagQ) {
      out = out.filter((f) => Array.isArray((f as any).tags) && (f as any).tags.some((t: string) => t.toLowerCase().includes(tagQ)));
    }
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((f) =>
      f.id.toLowerCase().includes(q) || f.title.toLowerCase().includes(q)
    );
    return out.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [features, view, search, projectFilter, tagFilter]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Keep focusIdx in bounds
  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, focusIdx]);

  // Keyboard navigation on the list panel when it has focus (or nothing else does)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip if user is typing in a text field
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        // Allow search focus
        if (e.key === 'Escape' && tgt === searchRef.current) {
          searchRef.current?.blur();
          e.preventDefault();
        }
        return;
      }
      // Skip if a modal is open (peek panel / dialog)
      if (document.querySelector('[data-harness-modal="true"]')) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const f = filtered[focusIdx];
        if (f) onSelect(f);
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        const f = filtered[focusIdx];
        if (f) onReset(f.id);
      } else if (e.key === 'x' || e.key === 'X') {
        const f = filtered[focusIdx];
        if (!f) return;
        setSelected((s) => {
          const next = new Set(s);
          if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, focusIdx, onReset, onSelect]);

  // Auto-scroll focused row into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-feat-idx="${focusIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const selectedArr = Array.from(selected);
  const hasSelection = selectedArr.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: filters + search + view mode + actions */}
      <div className="h-feature-toolbar">
        <div className="h-feature-viewbar" role="tablist" aria-label="Feature filters">
          {BUILT_IN_VIEWS.map((v) => {
            const active = v.id === viewId;
            const count = features.filter((f) => {
              if (v.filter.statuses && !v.filter.statuses.includes(f.status)) return false;
              if (v.filter.minAttempts != null && f.attempts < v.filter.minAttempts) return false;
              return true;
            }).length;
            return (
              <button
                key={v.id}
                className={`h-feature-filter${active ? ' active' : ''}`}
                onClick={() => setViewId(v.id)}
                aria-pressed={active}
                type="button"
              >
                <span>{v.name}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>

        <div className="h-feature-toolrow">
          <div className="h-feature-search">
            <span className="h-feature-search-icon" aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search features…"
              className="h-feature-search-input"
              aria-label="Search features"
            />
            {search && (
              <button
                type="button"
                className="h-feature-search-clear"
                onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                aria-label="Clear feature search"
              >
                ×
              </button>
            )}
          </div>

          {/* Item 7: project filter dropdown (small fixed list) */}
          {projectOptions.length > 0 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label="Filter by project"
              style={{
                fontSize: SIZES.xs, padding: '4px 8px', borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text,
              }}
            >
              <option value="all">All projects</option>
              <option value="__none">No project</option>
              {projectOptions.map((pid) => (
                <option key={pid} value={pid}>{pid}</option>
              ))}
            </select>
          )}

          {/* Item 7: tag search (free-form, can grow infinitely) */}
          <input
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            placeholder="Tag…"
            aria-label="Filter by tag"
            style={{
              fontSize: SIZES.xs, padding: '4px 8px', borderRadius: RADIUS.sm,
              border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text,
              width: 90,
            }}
          />

          <span className="h-feature-result-count" title="Filtered features">
            {filtered.length}/{features.length} shown
          </span>

          <div className="h-feature-mode" role="group" aria-label="View mode">
            {(['list', 'board'] as ViewMode[]).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  className={`h-feature-mode-btn${active ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                  title={`${m} view`}
                  aria-pressed={active}
                  type="button"
                >
                  {m}
                </button>
              );
            })}
          </div>

          <button type="button" className="h-feature-add" onClick={onAdd}>
            + new
          </button>
        </div>
      </div>

      {/* Batch action bar */}
      {hasSelection && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px',
          background: 'rgba(94,106,210,0.12)',
          borderBottom: `1px solid ${COLORS.border}`,
          fontSize: SIZES.xs, color: COLORS.text,
          flexShrink: 0,
        }}>
          <span>{selectedArr.length} selected</span>
          <IconButton onClick={() => { onBatchReset(selectedArr); setSelected(new Set()); }} variant="subtle">Reset all</IconButton>
          <IconButton onClick={() => { if (confirm(`Delete ${selectedArr.length} features?`)) { onBatchDelete(selectedArr); setSelected(new Set()); }}} variant="danger">Delete</IconButton>
          <IconButton onClick={() => setSelected(new Set())} variant="ghost">Clear</IconButton>
        </div>
      )}

      {/* Body */}
      <div ref={listRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 24, color: COLORS.textDim, fontSize: SIZES.sm, textAlign: 'center' }}>
            {features.length === 0 ? 'No features yet — planner may still be running.' : 'No features match this view.'}
          </div>
        ) : mode === 'list' ? (
          <ListView
            features={filtered}
            focusIdx={focusIdx}
            activeId={activeFeatureId}
            selected={selected}
            onSelect={onSelect}
            onToggleSelect={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            compact={isCompact}
          />
        ) : (
          <BoardView
            features={filtered}
            activeId={activeFeatureId}
            selected={selected}
            onSelect={onSelect}
            onToggleSelect={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          />
        )}
      </div>

      {/* Footer keyboard hints */}
      <div style={{
        display: 'flex', gap: 10, padding: '4px 10px',
        borderTop: `1px solid ${COLORS.borderSubtle}`,
        fontSize: '0.65rem', color: COLORS.textDim,
        flexShrink: 0,
      }}>
        <span><KbdHint>J/K</KbdHint> move</span>
        <span><KbdHint>↵</KbdHint> open</span>
        <span><KbdHint>R</KbdHint> reset</span>
        <span><KbdHint>X</KbdHint> select</span>
        <span><KbdHint>/</KbdHint> search</span>
      </div>
    </div>
  );
}

// ─── List view ─────────────────────────────────────────────────────

function ListView({
  features, focusIdx, activeId, selected, onSelect, onToggleSelect, compact = false,
}: {
  features: Feature[];
  focusIdx: number;
  activeId: string | null;
  selected: Set<string>;
  onSelect: (f: Feature) => void;
  onToggleSelect: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div>
      {features.map((f, i) => {
        const isFocus = i === focusIdx;
        const isActive = f.id === activeId;
        const isSel = selected.has(f.id);
        return (
          <div
            key={f.id}
            data-feat-idx={i}
            className={`h-feature-row status-${f.status}${compact ? ' compact' : ''}${isFocus ? ' is-focused' : ''}${isActive ? ' is-active' : ''}${isSel ? ' is-selected' : ''}`}
            role="button"
            tabIndex={0}
            aria-selected={isActive || isFocus}
            aria-label={`${f.id}: ${f.summary || f.title} (${getStatusMeta(f.status).label})`}
            onClick={() => onSelect(f)}
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).tagName === 'INPUT') return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(f);
              }
            }}
            style={{
              display: 'grid',
              gridTemplateColumns: compact ? 'auto minmax(0, 1fr) auto' : 'auto auto minmax(0, 1fr) auto auto',
              alignItems: 'center',
              gap: compact ? 8 : 10,
              padding: compact ? '8px 10px' : '6px 10px',
              borderLeft: `2px solid ${isFocus ? COLORS.accent : isActive ? COLORS.accent : 'transparent'}`,
              background: isSel ? 'rgba(94,106,210,0.10)' : (isActive ? COLORS.surfaceHover : 'transparent'),
              borderBottom: `1px solid ${COLORS.borderSubtle}`,
              cursor: 'pointer',
              minHeight: compact ? 52 : 34,
            }}
          >
            <input
              type="checkbox"
              checked={isSel}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect(f.id)}
              style={{ accentColor: COLORS.accent, margin: 0, cursor: 'pointer' }}
            />
            {!compact && <StatusPill status={f.status} showLabel={false} size="xs" />}
            <div style={{
              display: 'flex',
              alignItems: compact ? 'stretch' : 'center',
              flexDirection: compact ? 'column' : 'row',
              gap: compact ? 4 : 10,
              minWidth: 0,
            }}>
              {compact ? (
                <>
                  <span
                    title={f.title}
                    style={{
                      color: COLORS.text,
                      fontSize: SIZES.sm,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >{f.summary || f.title}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: COLORS.textDim, fontSize: SIZES.xs }}>
                    <StatusPill status={f.status} showLabel={false} size="xs" />
                    <span style={{ fontFamily: FONTS.mono, color: COLORS.textMuted, flexShrink: 0 }}>{f.id}</span>
                    {f.claims && f.claims.length > 0 && <span style={{ flexShrink: 0 }}>{f.claims.length} claims</span>}
                    {f.attempts > 0 && <span style={{ marginLeft: 'auto', fontFamily: FONTS.mono, color: f.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim }}>×{f.attempts}</span>}
                  </span>
                </>
              ) : (
                <>
                  <span style={{
                    fontFamily: FONTS.mono,
                    fontSize: SIZES.xs,
                    color: COLORS.textMuted,
                    letterSpacing: '0.02em',
                    flexShrink: 0,
                  }}>{f.id}</span>
                  <span
                    title={f.title}
                    style={{
                      color: COLORS.text,
                      fontSize: SIZES.sm,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >{f.summary || f.title}</span>
                  {f.claims && f.claims.length > 0 && (
                    <span style={{
                      fontSize: '0.65rem',
                      color: COLORS.textDim,
                      background: COLORS.bg,
                      padding: '1px 6px',
                      borderRadius: RADIUS.sm,
                      border: `1px solid ${COLORS.borderSubtle}`,
                      flexShrink: 0,
                    }}>
                      {f.claims.length} claims
                    </span>
                  )}
                </>
              )}
            </div>
            {!compact && (
              <span style={{
                fontFamily: FONTS.mono,
                fontSize: SIZES.xs,
                color: f.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim,
                textAlign: 'right',
                minWidth: 20,
              }}>{f.attempts}</span>
            )}
            <span style={{
              fontSize: SIZES.xs,
              color: getStatusMeta(f.status).text,
              whiteSpace: 'nowrap',
              minWidth: compact ? 62 : 80,
              textAlign: 'right',
              fontWeight: compact ? 600 : 400,
            }}>{getStatusMeta(f.status).label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Board view ────────────────────────────────────────────────────

function BoardView({
  features, activeId, selected, onSelect, onToggleSelect,
}: {
  features: Feature[];
  activeId: string | null;
  selected: Set<string>;
  onSelect: (f: Feature) => void;
  onToggleSelect: (id: string) => void;
}) {
  const cols: Record<HarnessStatus, Feature[]> = {
    todo: [], in_progress: [], validating: [], failing: [], blocked: [], passed: [],
  };
  for (const f of features) cols[f.status].push(f);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${BOARD_COLUMN_ORDER.length}, minmax(160px, 1fr))`,
      gap: 6,
      padding: 8,
      height: '100%',
      overflowX: 'auto',
    }}>
      {BOARD_COLUMN_ORDER.map((st) => {
        const s = STATUS[st];
        const items = cols[st];
        return (
          <div key={st} style={{
            display: 'flex', flexDirection: 'column',
            minHeight: 0,
            background: COLORS.bg,
            border: `1px solid ${COLORS.borderSubtle}`,
            borderRadius: RADIUS.sm,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 8px',
              borderBottom: `1px solid ${COLORS.borderSubtle}`,
              flexShrink: 0,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.solid }} />
              <span style={{ fontSize: SIZES.xs, color: s.text, fontWeight: 600 }}>{s.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: SIZES.xs, color: COLORS.textDim }}>{items.length}</span>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {items.length === 0 ? (
                <div style={{ padding: 10, color: COLORS.textFaint, fontSize: SIZES.xs, textAlign: 'center' }}>—</div>
              ) : (
                items.map((f) => {
                  const isActive = f.id === activeId;
                  const isSel = selected.has(f.id);
                  return (
                    <div
                      key={f.id}
                      onClick={() => onSelect(f)}
                      style={{
                        padding: '6px 8px',
                        background: isSel ? 'rgba(94,106,210,0.15)' : COLORS.surfaceRaised,
                        border: `1px solid ${isActive ? COLORS.accent : COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        cursor: 'pointer',
                        fontSize: SIZES.xs,
                      }}
                    >
                      <div style={{
                        fontFamily: FONTS.mono,
                        color: COLORS.textDim,
                        fontSize: '0.65rem',
                        letterSpacing: '0.02em',
                        marginBottom: 2,
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => onToggleSelect(f.id)}
                          style={{ accentColor: COLORS.accent, margin: 0 }}
                        />
                        {f.id}
                        {f.attempts > 0 && (
                          <span style={{
                            marginLeft: 'auto',
                            color: f.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim,
                          }}>×{f.attempts}</span>
                        )}
                      </div>
                      <div
                        title={f.title}
                        style={{
                          color: COLORS.text,
                          fontSize: SIZES.xs,
                          lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {f.summary || f.title}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
