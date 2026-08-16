"use client";

import { ArrowRight, Clock3, FileLock2, ShieldCheck, UsersRound } from "lucide-react";
import { StudioTabRow } from "@/components/creatives/StudioTabRow";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";

const audienceReadiness = [
  {
    contract: "Provider account scope",
    status: "Required",
    evidence: "No audience route contract supplies an explicit providerAccountId.",
  },
  {
    contract: "Audience identity",
    status: "Required",
    evidence: "Audience ids, types, and source lineage are not available to this surface.",
  },
  {
    contract: "Matched-event coverage",
    status: "Required",
    evidence: "Seed match rate and source-event coverage are not available.",
  },
  {
    contract: "Overlap and exclusion freshness",
    status: "Required",
    evidence: "No server read model currently proves overlap or exclusion recency.",
  },
  {
    contract: "Audience decision producer",
    status: "Not proposed",
    evidence: "No server buyerAction, confidence, or execution contract exists for audiences.",
  },
];

export default function MetaAudiencesPage() {
  const searchParams = useSearchParams();
  const routeScope = {
    businessId: searchParams?.get("businessId")?.trim() ?? "",
    providerAccountId: searchParams?.get("providerAccountId")?.trim() ?? "",
  };

  return (
    <main
      className="ad-final"
      data-testid="audiences-studio-page"
      data-audience-state="contract_blocked"
    >
      <div className="flex w-full flex-col gap-4">
          <StudioTabRow active="audiences" />
        <header className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="crumbs">Platforms · <b>Meta</b> · Creative Studio</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <h1 className="page-title">Audiences</h1>
                <span className="chip chip--warn">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                  Planned surface
                </span>
              </div>
              <p className="mt-1 max-w-3xl text-[13px] text-[var(--muted)]">
                This Studio surface is intentionally quiet until audience contracts exist. Reach,
                overlap, match-rate, and ROAS numbers are not fabricated.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]" data-testid="audience-readiness-ledger">
            <div className="flex items-start justify-between gap-4">
              <div className="px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  Readiness ledger
                </div>
                <h2 className="mt-1 text-[15px] font-semibold text-[var(--ink)]">No live audience contract</h2>
              </div>
              <span className="chip chip--warn mr-4 mt-3">All gates closed</span>
            </div>
            <div className="hidden overflow-x-auto border-t border-[var(--border)] md:block">
              <div className="min-w-[620px]">
                <div className="grid grid-cols-[minmax(160px,0.8fr)_110px_minmax(260px,1.4fr)] gap-3 bg-[var(--surface-2)] px-4 py-2 text-[10px] font-semibold uppercase text-[var(--muted)]">
                  <span>Contract</span><span>State</span><span>Current evidence</span>
                </div>
                {audienceReadiness.map((item) => (
                  <div key={item.contract} className="grid grid-cols-[minmax(160px,0.8fr)_110px_minmax(260px,1.4fr)] gap-3 border-t border-[var(--border)] px-4 py-3 text-[12px]">
                    <strong className="font-semibold text-[var(--ink)]">{item.contract}</strong>
                    <span className="text-[var(--warn)]">{item.status}</span>
                    <span className="text-[var(--muted)]">{item.evidence}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid border-t border-[var(--border)] md:hidden">
              {audienceReadiness.map((item) => (
                <div
                  key={item.contract}
                  className="grid gap-2 border-t border-[var(--border)] px-4 py-4 first:border-t-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <strong className="text-[12.5px] font-semibold text-[var(--ink)]">
                      {item.contract}
                    </strong>
                    <span className="shrink-0 text-[11.5px] font-medium text-[var(--warn)]">
                      {item.status}
                    </span>
                  </div>
                  <p className="text-[12px] leading-5 text-[var(--muted)]">
                    {item.evidence}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <aside className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
              <ShieldCheck className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />
              Current safe routes
            </div>
            <p className="mt-2 text-[12.5px] leading-5 text-[var(--muted)]">
              Until audience intelligence ships, use surfaces that already have server-backed
              evidence and guarded execution.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Link
                href={buildMetaScopedHref("/platforms/meta/creatives", routeScope)}
                className="group btn justify-between"
              >
                Review creative evidence
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                href={buildMetaScopedHref("/platforms/meta", routeScope)}
                className="group btn justify-between"
              >
                Open Decisions
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                href={buildMetaScopedHref("/platforms/meta/launchpad", routeScope)}
                className="group btn justify-between"
              >
                Build in Launchpad
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </div>
            <div className="mt-4 rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-[12px] leading-5 text-[var(--muted)]">
              <FileLock2 className="mr-2 inline h-3.5 w-3.5 text-[var(--muted)]" aria-hidden="true" />
              Reach, match rate, overlap, revenue, and recommendations stay absent until server evidence exists.
            </div>
          </aside>
        </section>

        <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <UsersRound className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            Contract needed
          </div>
          <p className="mt-2 text-[12.5px] leading-5 text-[var(--muted)]">
            Backend acceptance for this page is explicit: audience identity, source event coverage,
            overlap checks, and exclusion freshness must be available before any score is rendered.
          </p>
        </section>
      </div>
    </main>
  );
}
