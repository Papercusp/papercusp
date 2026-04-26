'use client';

import { useEffect, useState } from 'react';
import { X, ArrowUpRight, CheckCircle, XCircle, Eye, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import type { Issue, IssueStatus } from './types';

async function call(slug: string, id: string, action: string, body: any) {
  const res = await fetch(`/api/harness/${slug}/issues/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function IssueDetail({
  slug, issue, onClose, onChange, onRefreshAll,
}: {
  slug: string;
  issue: Issue;
  onClose: () => void;
  onChange: (next: Issue) => void;
  onRefreshAll: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateStatus = async (status: IssueStatus) => {
    setBusy(true);
    try {
      const next = await call(slug, issue.id, 'update', { status });
      onChange(next);
    } catch (e: any) { toast.error(`Update failed: ${e.message ?? e}`); }
    finally { setBusy(false); }
  };

  const promote = async () => {
    setBusy(true);
    try {
      const res = await call(slug, issue.id, 'promote', {});
      onChange(res.issue);
      onRefreshAll();
    } catch (e: any) { toast.error(`Promote failed: ${e.message ?? e}`); }
    finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const next = await call(slug, issue.id, 'update', { note, by: 'human' });
      onChange(next);
      setNote('');
    } catch (e: any) { toast.error(`Add note failed: ${e.message ?? e}`); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      zIndex: 60, display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(720px, 72vw)', height: '100%',
        background: 'var(--bg-2)', borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span className={`h-issue-sev sev-${issue.severity}`}>{issue.severity}</span>
          <span className="h-issue-id">{issue.id}</span>
          <span className={`h-issue-status st-${issue.status}`}>{issue.status}</span>
          {issue.linkedFeatureId && (
            <span className="h-issue-linked"><ArrowUpRight size={11} /> {issue.linkedFeatureId}</span>
          )}
          <button className="h-btn-icon" onClick={onClose} style={{ marginLeft: 'auto' }}>
            <X size={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px' }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px', color: 'var(--fg)' }}>
            {issue.title}
          </h2>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 14 }}>
            {issue.source === 'human' ? 'filed by human' : `found by ${issue.source}`}
            {issue.foundDuring && ` during ${issue.foundDuring}`}
            {' · '}{new Date(issue.foundAt).toLocaleString()}
            {issue.codePointer && <> · <code style={{ color: 'var(--counter)' }}>{issue.codePointer}</code></>}
          </div>

          {issue.evidence && (
            <Section title="Evidence">
              <pre className="h-issue-pre">{issue.evidence}</pre>
            </Section>
          )}
          {issue.repro && (
            <Section title="Reproduction">
              <pre className="h-issue-pre">{issue.repro}</pre>
            </Section>
          )}
          {issue.suggestedFix && (
            <Section title="Suggested fix">
              <pre className="h-issue-pre">{issue.suggestedFix}</pre>
            </Section>
          )}

          {issue.notes.length > 0 && (
            <Section title="Notes">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {issue.notes.map((n, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg)', borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
                    <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginBottom: 2 }}>
                      {n.by} · {new Date(n.ts).toLocaleString()}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        <div style={{
          borderTop: '1px solid var(--border)', padding: '10px 16px',
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
        }}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
            placeholder="add a note…"
            style={{
              flex: 1, background: 'var(--bg-3)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '6px 10px', fontSize: 12, outline: 'none',
            }}
          />
          <button className="h-btn ghost" disabled={busy || !note.trim()} onClick={addNote}>
            <MessageSquarePlus size={13} /> note
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          {!issue.linkedFeatureId && issue.status !== 'closed' && issue.status !== 'wontfix' && (
            <button className="h-btn primary" disabled={busy} onClick={promote}>
              <ArrowUpRight size={13} /> promote to feature
            </button>
          )}
          {issue.status !== 'acknowledged' && issue.status !== 'closed' && (
            <button className="h-btn ghost" disabled={busy} onClick={() => updateStatus('acknowledged')}>
              <Eye size={13} /> acknowledge
            </button>
          )}
          {issue.status !== 'closed' && (
            <button className="h-btn ghost" disabled={busy} onClick={() => updateStatus('closed')}>
              <CheckCircle size={13} /> close
            </button>
          )}
          {issue.status !== 'wontfix' && (
            <button className="h-btn ghost" disabled={busy} onClick={() => updateStatus('wontfix')}>
              <XCircle size={13} /> won't fix
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.7,
        textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}
