import Link from "next/link";
import { ReactNode } from "react";
import { BrandLogo } from "@/components/brand/BrandLogo";

interface PublicLegalPageProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

const LEGAL_LINKS = [
  { href: "/about", label: "About Us" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/ai-transparency", label: "AI Transparency" },
  { href: "/contact", label: "Contact" },
  { href: "/security", label: "Security" },
];

export function PublicLegalPage({ title, subtitle, children }: PublicLegalPageProps) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto max-w-3xl px-5 sm:px-8 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <BrandLogo markClassName="h-7 w-7" size={28} />
          </Link>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="flex-1">
      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        <header className="mb-10">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Adsecute
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">{subtitle}</p>
          ) : null}
        </header>

        <article className="space-y-8 text-sm leading-7 sm:text-base">
          {children}
        </article>

        <footer className="mt-12 border-t pt-6">
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {LEGAL_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-foreground">
                {link.label}
              </Link>
            ))}
          </nav>
        </footer>
      </div>
      </main>
    </div>
  );
}
