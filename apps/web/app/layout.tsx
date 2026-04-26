import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import SessionIndicator from './_components/SessionIndicator';
import './globals.css';

export const metadata: Metadata = {
  title: 'Papercusp',
  description: 'Open-source autonomous-harness framework. Build, share, and run multi-agent missions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="pc-header">
          <a href="/" className="brand">PAPERCUSP</a>
          <nav>
            <a href="/marketplace">Marketplace</a>
            <a href="/settings/api-keys">Settings</a>
            <SessionIndicator />
          </nav>
        </header>
        <main>{children}</main>
        <Toaster theme="dark" position="top-right" />
      </body>
    </html>
  );
}
