import { ReactNode } from "react";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingNavbar } from "@/components/marketing/MarketingNavbar";

interface PublicLegalPageProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function PublicLegalPage({ title, subtitle, children }: PublicLegalPageProps) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* The real marketing header, not a reduced copy of it.
          These six pages are exactly where the footer sends people — Privacy,
          Terms, Security, About, Contact, AI Transparency — and each one used to
          replace the header with a logo and a "back to home" link. A visitor who
          followed a footer link lost the product nav and, more to the point,
          lost every way to sign in or sign up without going back first. */}
      <MarketingNavbar />

      <main id="main-content" className="flex-1">
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

      </div>
      </main>
      {/* One footer for the whole public site. The bespoke legal-links strip
          this replaces already duplicated what MarketingFooter carries. */}
      <MarketingFooter />
    </div>
  );
}
