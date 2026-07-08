"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlanGate } from "@/components/pricing/PlanGate";
import { WorkspacePill, WorkspaceSurface } from "@/components/workspace/workspace-surface";
import { cn } from "@/lib/utils";

const INSIGHTS_TABS = [
  {
    id: "analytics",
    label: "Analytics",
    href: "/insights/analytics",
    desc: "Account-wide attribution, cohorts, LTV trends",
  },
  {
    id: "ai-visibility",
    label: "AI Visibility",
    href: "/insights/ai-visibility",
    desc: "Generative Engine · how your brand surfaces in AI tools",
  },
  {
    id: "seo",
    label: "SEO Intelligence",
    href: "/insights/seo",
    desc: "Organic and paid overlap, keyword surface",
  },
] as const;

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <PlanGate requiredPlan="pro">
      <WorkspaceSurface
        eyebrow="Workspace intelligence"
        title="Insights"
        description="Analytics, AI visibility, and SEO intelligence share the same workspace context."
        meta={<WorkspacePill tone="neutral">restyle only</WorkspacePill>}
      >
        <div className="border-b border-[var(--adc-b1)]">
          <div className="flex items-center gap-1" role="tablist" aria-label="Insights">
            {INSIGHTS_TABS.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={cn(
                    "-mb-px border-b-2 px-3 py-2 text-[12.5px]",
                    active
                      ? "border-[var(--adc-ink)] font-medium text-[var(--adc-ink)]"
                      : "border-transparent text-[var(--adc-ink2)] hover:text-[var(--adc-ink)]"
                  )}
                  title={tab.desc}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </div>
        {children}
      </WorkspaceSurface>
    </PlanGate>
  );
}
