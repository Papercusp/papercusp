/**
 * VSCodeTab — iframes operator-local code-server scoped to the harness's
 * project directory. The host loader passes `slug` so we can ask the substrate
 * for the project path; this is read via the api shim.
 */
import { useEffect, useState } from 'react';
import type { PapercuspApi } from '@papercusp/plugin-sdk';

interface Props {
  slug: string;
  api: PapercuspApi;
  readOnly: boolean;
}

export default function VSCodeTab({ slug, api }: Props): JSX.Element {
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const project = await api.harness.getProjectDir(slug);
        if (!cancelled) setFolder(project);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? 'failed to resolve project dir');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, api]);

  const codeServerUrl = (api.config?.get?.('codeServerUrl') as string | undefined) ?? 'http://localhost:8082';

  if (error) {
    return (
      <div style={{ padding: 24, color: '#c0392b' }}>
        Failed to load VS Code: {error}
      </div>
    );
  }
  if (!folder) {
    return <div style={{ padding: 24, color: '#888' }}>Loading…</div>;
  }

  const url = `${codeServerUrl.replace(/\/$/, '')}/?folder=${encodeURIComponent(folder)}`;
  return (
    <iframe
      src={url}
      style={{ display: 'block', width: '100%', height: 'calc(100vh - 56px)', border: 'none' }}
      title="VS Code"
    />
  );
}
