import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mnemos — Persistent Memory & Context Engine',
  description: 'Persistent memory and context engine for personal AI applications.',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
