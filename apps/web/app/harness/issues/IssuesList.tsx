'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertOctagon, AlertTriangle, Info, FileCode, User, Bot,
  ArrowUpRight, CheckCircle, CheckCircle2, XCircle, Loader2, Hammer, Inbox, Circle,
} from 'lucide-react';
import type { Issue, IssueSeverity, IssueSource, IssueStatus } from './types';
import { IssueDetail } from './IssueDetail';

const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  critical: 'sev-critical',
  major: 'sev-major',
  minor: 'sev-minor',
  nit: 'sev-nit',
};
const SEVERITY_ICON: Record<IssueSeverity, typeof AlertOctagon> = {
  critical: AlertOctagon,
  major: AlertTriangle,
  minor: Info,
  nit: Info,
};

const STATUS_ICON: Record<IssueStatus, typeof CheckCircle> = {
  open: AlertTriangle,
  acknowledged: Info,
  fixing: Hammer,
  closed: CheckCircle,
  wontfix: XCircle,
  passed: CheckCircle2,
};

const SOURCE_ICON: Record<IssueSource, typeof User> = {
  validator: Bot,
  worker: Bot,
  human: User,
};

function IssueRow({
  issue,
  onSelect,
}: {
  issue: Issue;
  onSelect: () => void;
}) {
  const SevIcon = SEVERITY_ICON[issue.severity] ?? Circle;
  const StatusIcon = STATUS_ICON[issue.status] ?? Circle;
  const SrcIcon = SOURCE_ICON[issue.source] ?? Circle;
  return (
    <div
      className={`h-issue h-issue-${issue.severity} h-issue-${issue.status}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-label={`Open ${issue.severity} ${issue.status} issue ${issue.id}: ${issue.title}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={`h-issue-sev ${SEVERITY_CLASS[issue.severity]}`}>
        <SevIcon size={11} />
        {issue.severity}
      </span>
      <div className="h-issue-body">
        <div className="h-issue-title">{issue.title}</div>
        <div className="h-issue-meta">
          <span className="h-issue-source" title={`source: ${issue.source}`}><SrcIcon size={10} /> {issue.source}</span>
          <span className="h-issue-id">{issue.id}</span>
          {issue.foundDuring && <span className="h-issue-feat">found in {issue.foundDuring}</span>}
          {issue.codePointer && (
            <span className="h-issue-code"><FileCode size={10} /> {issue.codePointer}</span>
          )}
        </div>
      </div>
      <div className="h-issue-right">
        {issue.linkedFeatureId && (
          <span className="h-issue-linked" title={`Fix in progress: ${issue.linkedFeatureId}`}>
            <ArrowUpRight size={10} /> {issue.linkedFeatureId}
          </span>
        )}
        <span className={`h-issue-status st-${issue.status}`}>
          <StatusIcon size={10} className={issue.status === 'fixing' ? 'h-spin' : ''} />
          {issue.status}
        </span>
        <span className="h-issue-open" aria-hidden="true">open</span>
      </div>
    </div>
  );
}

export function IssuesList({ slug, onCount }: { slug: string; onCount?: (n: number) => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pending, setPending] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('active');
  const [reloadTick, setReloadTick] = useState(0);
  const [triaging, setTriaging] = useState(false);

  useEffect(() => {
    // The dashboard mounts this panel before activeSlug is known and passes
    // `slug=""` as a placeholder. Firing a fetch for `/api/harness//issues-list`
    // produces a double-slash URL that the public-site admin proxy rejects
    // with "Empty slug — skipping fetch", surfacing as a permanent error in
    // the UI until the user toggles tabs. Skip the request until slug lands.
    if (!slug) return;
    let aborted = false;
    fetch(`/api/harness/${slug}/issues-list`)
      .then((r) => r.json())
      .then((d) => {
        if (aborted) return;
        if (d.error) setError(d.error);
        else {
          setIssues(d.issues ?? []);
          setPending(d.pending ?? []);
          onCount?.((d.issues?.length ?? 0) + (d.pending?.length ?? 0));
        }
      })
      .catch((e) => { if (!aborted) setError(String(e)); });
    return () => { aborted = true; };
  }, [slug, reloadTick]);

  const runTriage = async () => {
    setTriaging(true);
    try {
      const res = await fetch(`/api/harness/${slug}/triage`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      toast.success(`Triage: +${d.merged} new, ${d.deduped} deduped`);
      setReloadTick((t) => t + 1);
    } catch (e: any) {
      toast.error(`Triage failed: ${e.message ?? e}`);
    } finally {
      setTriaging(false);
    }
  };

  const filtered = (issues ?? []).filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'closed') return i.status === 'closed' || i.status === 'wontfix';
    return i.status !== 'closed' && i.status !== 'wontfix';
  });

  const selected = issues?.find((i) => i.id === selectedId);
  const activeCount = issues?.filter((i) => i.status !== 'closed' && i.status !== 'wontfix').length ?? 0;
  const closedCount = issues?.filter((i) => i.status === 'closed' || i.status === 'wontfix').length ?? 0;
  const openCount = issues?.filter((i) => i.status === 'open').length ?? 0;
  const fixingCount = issues?.filter((i) => i.status === 'fixing').length ?? 0;

  const refresh = () => setReloadTick((t) => t + 1);

  if (error) {
    return <div className="h-empty"><span style={{ color: 'var(--bad)' }}>{error}</span></div>;
  }
  if (!issues) {
    return <div className="h-empty"><Loader2 size={16} className="h-empty-icon h-spin" /><span>loading issues…</span></div>;
  }

  return (
    <>
      <div className="h-issues-toolbar" aria-label="Issue filters">
        <div className="h-issues-toolbar-main">
          {(['active', 'all', 'closed'] as const).map((f) => {
            const count = f === 'all' ? issues.length : f === 'closed' ? closedCount : activeCount;
            return (
              <button
                key={f}
                className={`h-chip${filter === f ? ' on' : ''}`}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                <span>{f}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>
        <div className="h-issues-toolbar-side">
          <span className="h-issue-mini-stat"><strong>{openCount}</strong> open</span>
          <span className="h-issue-mini-stat"><strong>{fixingCount}</strong> fixing</span>
          {pending.length > 0 && (
            <button
              className="h-chip h-chip-pending"
              disabled={triaging}
              onClick={runTriage}
              title="Merge pending validator findings into the tracker"
            >
              <Inbox size={10} />
              triage <strong>{pending.length}</strong>
            </button>
          )}
        </div>
      </div>
      {pending.length > 0 && (
        <div className="h-pending-banner">
          <Inbox size={11} />
          {pending.length} pending validator finding{pending.length === 1 ? '' : 's'} — click triage to merge
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="h-empty">
          <Info size={18} className="h-empty-icon" />
          <span>no {filter === 'all' ? '' : filter} issues</span>
        </div>
      ) : (
        <div className="h-issues">
          {filtered.map((i) => (
            <IssueRow key={i.id} issue={i} onSelect={() => setSelectedId(i.id)} />
          ))}
        </div>
      )}
      {selected && (
        <IssueDetail
          slug={slug}
          issue={selected}
          onClose={() => setSelectedId(null)}
          onChange={(next) => {
            setIssues((prev) => prev?.map((i) => (i.id === next.id ? next : i)) ?? null);
            if (next.linkedFeatureId) toast.success(`Promoted to ${next.linkedFeatureId}`);
          }}
          onRefreshAll={refresh}
        />
      )}
    </>
  );
}
