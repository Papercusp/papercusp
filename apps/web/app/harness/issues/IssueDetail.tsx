'use client';

import { useState } from 'react';
import { Drawer } from 'vaul';
import { X, ArrowUpRight, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import type { Issue } from './types';

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
  slug, issue, onClose, onChange,
}: {
  slug: string;
  issue: Issue;
  onClose: () => void;
  onChange: (next: Issue) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);


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
    <Drawer.Root open onOpenChange={(o) => { if (!o) onClose(); }} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.65)' }} />
        <Drawer.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 'min(720px, 72vw)',
            background: '#17131f', borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            zIndex: 61, outline: 'none',
          }}
        >
          <Drawer.Title style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
            Issue {issue.id}
          </Drawer.Title>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
          background: '#17131f',
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

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px', background: '#17131f' }}>
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
          background: '#17131f',
          boxShadow: '0 -12px 28px rgba(0,0,0,0.18)',
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
        </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 14,
      padding: '11px 12px 10px',
      border: '1px solid var(--border)',
      borderRadius: 12,
      background: '#1c1824',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.7,
        textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}
