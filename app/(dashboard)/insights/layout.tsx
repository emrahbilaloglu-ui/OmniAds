"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlanGate } from "@/components/pricing/PlanGate";
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
      <div className="space-y-5">
        <div className="border-b border-slate-200">
          <div className="flex items-center gap-1" role="tablist" aria-label="Insights">
            {INSIGHTS_TABS.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={cn(
                    "px-3 py-2 text-[12.5px] border-b-2 -mb-px",
                    active
                      ? "border-blue-600 text-slate-900 font-medium"
                      : "border-transparent text-slate-500 hover:text-slate-900"
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
      </div>
    </PlanGate>
  );
}
