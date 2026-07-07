import { ArrowRight, Clock3, Network, ShieldCheck, UsersRound } from "lucide-react";
import Link from "next/link";

const audienceModules = [
  {
    title: "Cohort map",
    status: "Not live",
    description: "Segment growth, overlap, and fatigue signals will appear here once the audience intelligence service is connected.",
  },
  {
    title: "Seed quality",
    status: "Waiting on data",
    description: "Lookalike and retargeting seeds need matched source events before this surface can score them honestly.",
  },
  {
    title: "Exclusion health",
    status: "Planned",
    description: "Audience conflict checks will flag duplicated reach and stale exclusions without rewriting campaign rules.",
  },
];

export default function MetaAudiencesPage() {
  return (
    <main className="min-h-screen bg-[#f7f8fa] px-6 py-6 text-[#10151c]">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[12px] font-medium text-neutral-600">
              <UsersRound className="h-3.5 w-3.5 text-[#2f6bff]" aria-hidden="true" />
              Meta audiences
            </div>
            <h1 className="text-[24px] font-semibold tracking-normal text-[#10151c]">
              Audience intelligence
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-neutral-600">
              This dedicated audience surface is not live yet. Current Meta workflows remain available in Creatives and Launchpad.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800">
            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
            Planned surface
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-xl border border-neutral-200 bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-medium text-neutral-500">Readiness</div>
                <div className="mt-1 text-[30px] font-semibold tabular-nums text-[#10151c]">--</div>
              </div>
              <span className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[12px] font-medium text-neutral-600">
                No live audience score
              </span>
            </div>
            <p className="mt-4 max-w-3xl text-[13px] leading-5 text-neutral-600">
              The UI is intentionally not showing placeholder reach, match-rate, overlap, or ROAS numbers. Those values require backend evidence before they can be useful to an operator.
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {audienceModules.map((module) => (
                <article key={module.title} className="rounded-lg border border-neutral-200 bg-[#fafafa] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[14px] font-semibold text-[#10151c]">{module.title}</h2>
                    <span className="rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                      {module.status}
                    </span>
                  </div>
                  <p className="mt-3 text-[12.5px] leading-5 text-neutral-600">{module.description}</p>
                </article>
              ))}
            </div>
          </div>

          <aside className="rounded-xl border border-neutral-200 bg-white p-5">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-[#10151c]">
              <ShieldCheck className="h-4 w-4 text-[#2f6bff]" aria-hidden="true" />
              Current safe routes
            </div>
            <p className="mt-2 text-[12.5px] leading-5 text-neutral-600">
              Until audience intelligence ships, use existing surfaces that already have server-backed evidence.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Link
                href="/platforms/meta/creatives"
                className="group inline-flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-[13px] font-medium text-[#10151c] hover:border-[#d3e0ff] hover:bg-[#eef3ff]"
              >
                Review creative decisions
                <ArrowRight className="h-4 w-4 text-neutral-400 transition group-hover:translate-x-0.5 group-hover:text-[#2f6bff]" aria-hidden="true" />
              </Link>
              <Link
                href="/platforms/meta/launchpad"
                className="group inline-flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-[13px] font-medium text-[#10151c] hover:border-[#d3e0ff] hover:bg-[#eef3ff]"
              >
                Build from Launchpad
                <ArrowRight className="h-4 w-4 text-neutral-400 transition group-hover:translate-x-0.5 group-hover:text-[#2f6bff]" aria-hidden="true" />
              </Link>
            </div>
            <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-[12px] leading-5 text-neutral-600">
              <Network className="mr-2 inline h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
              Cross-audience totals are not fabricated here. The page stays quiet until the data contract exists.
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
