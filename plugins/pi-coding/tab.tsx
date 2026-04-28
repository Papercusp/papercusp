import type { PapercuspApi } from '@papercusp/plugin-sdk';

interface Props {
  slug: string;
  api: PapercuspApi;
  readOnly: boolean;
}

export default function PiTab({ slug, api }: Props): JSX.Element {
  const piUrl = (api.config?.get?.('piUrl') as string | undefined) ?? 'http://localhost:3055/pi';
  const url = `${piUrl.replace(/\/$/, '')}?harness=${encodeURIComponent(slug)}`;
  return (
    <iframe
      src={url}
      style={{ display: 'block', width: '100%', height: 'calc(100vh - 56px)', border: 'none' }}
      title="Pi"
    />
  );
}
