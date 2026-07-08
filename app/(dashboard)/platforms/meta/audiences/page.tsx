import { ArrowRight, Clock3, Network, ShieldCheck, UsersRound } from "lucide-react";
import Link from "next/link";

const audienceModules = [
  {
    title: "Cohort map",
    status: "Not live",
    description:
      "Segment growth, overlap, and fatigue signals will appear here only after the audience intelligence service is connected.",
  },
  {
    title: "Seed quality",
    status: "Waiting on data",
    description:
      "Lookalike and retargeting seeds need matched source events before this surface can score them honestly.",
  },
  {
    title: "Exclusion health",
    status: "Planned",
    description:
      "Audience conflict checks will flag duplicated reach and stale exclusions without rewriting campaign rules.",
  },
];

export default function MetaAudiencesPage() {
  return (
    <main className="ad-final px-4 py-4" data-testid="audiences-studio-page">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
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
              <Link className="btn btn--sm" href="/platforms/meta/creatives">Library</Link>
              <Link className="btn btn--sm" href="/platforms/meta/copies">Copy</Link>
              <Link className="btn btn--sm" href="/platforms/meta/landing-pages">Landing pages</Link>
              <Link className="btn btn--sm" href="/platforms/meta/creative-inbox">Inbox</Link>
              <span className="btn btn--sm btn--primary" aria-current="page">Audiences</span>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  Readiness
                </div>
                <div className="mt-1 text-[28px] font-semibold tabular-nums text-[var(--ink)]">--</div>
              </div>
              <span className="chip chip--ghost">No live audience score</span>
            </div>
            <p className="mt-4 max-w-3xl text-[13px] leading-5 text-[var(--muted)]">
              The UI does not show placeholder reach, match-rate, overlap, or revenue values. Those
              fields require backend evidence before they can be useful to an operator.
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {audienceModules.map((module) => (
                <article key={module.title} className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[14px] font-semibold text-[var(--ink)]">{module.title}</h2>
                    <span className="chip chip--ghost">{module.status}</span>
                  </div>
                  <p className="mt-3 text-[12.5px] leading-5 text-[var(--muted)]">{module.description}</p>
                </article>
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
                href="/platforms/meta/creatives"
                className="group btn justify-between"
              >
                Review creative evidence
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                href="/platforms/meta"
                className="group btn justify-between"
              >
                Open Decisions
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                href="/platforms/meta/launchpad"
                className="group btn justify-between"
              >
                Build in Launchpad
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </div>
            <div className="mt-4 rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-[12px] leading-5 text-[var(--muted)]">
              <Network className="mr-2 inline h-3.5 w-3.5 text-[var(--muted)]" aria-hidden="true" />
              Cross-audience totals stay blank until the data contract exists.
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
