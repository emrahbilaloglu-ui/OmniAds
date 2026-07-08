'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { label: 'Decisions', href: '/platforms/google' },
  { label: 'Launchpad', href: '/platforms/google/launchpad' },
  { label: 'Ads', href: '/platforms/google/ads' },
  { label: 'Keywords', href: '/platforms/google/keywords' },
  { label: 'Audiences', href: '/platforms/google/audiences' },
];

export default function GoogleAdsNavTabs() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-2 rounded-xl border border-border/70 bg-muted/20 p-2">
      {TABS.map(tab => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            'whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            pathname === tab.href
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
