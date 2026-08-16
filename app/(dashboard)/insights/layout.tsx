"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlanGate } from "@/components/pricing/PlanGate";
import { WorkspaceSurface } from "@/components/workspace/workspace-surface";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
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

/**
 * Source chip for one of the two data providers Insights reads from. The label
 * reflects the real connection state from the integrations store — never a
 * hardcoded "connected".
 */
function SourceChip({
  label,
  provider,
  businessId,
}: {
  label: string;
  provider: "ga4" | "search_console";
  businessId: string | null;
}) {
  const domains = useIntegrationsStore((state) =>
    businessId ? state.domainsByBusinessId[businessId] : undefined,
  );
  const view = deriveProviderViewState(
    provider,
    domains?.[provider] ?? buildDefaultProviderDomains()[provider],
  );

  const tone = view.isConnected
    ? "pos"
    : view.status === "action_required" || view.status === "degraded"
      ? "warn"
      : "neutral";
  const stateLabel = view.isConnected
    ? "connected"
    : view.status === "action_required"
      ? "action required"
      : view.status === "degraded"
        ? "degraded"
        : view.status === "loading_data"
          ? "loading"
          : "not connected";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[11px] py-1.5 text-[12.5px] font-semibold text-[var(--adv-ink)]">
      {label}
      <span
        className={cn(
          "rounded-md px-[7px] py-px text-[10.5px] font-semibold",
          tone === "pos" && "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
          tone === "warn" &&
            "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
          tone === "neutral" &&
            "bg-[var(--adv-fill-2)] text-[var(--adv-ink-3)]",
        )}
      >
        {stateLabel}
      </span>
    </span>
  );
}

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  // Keeps the source chips honest: without the bootstrap the store holds
  // defaults, which would read as "not connected" for every business.
  useBusinessIntegrationsBootstrap(selectedBusinessId ?? null);

  return (
    <PlanGate requiredPlan="pro">
      <WorkspaceSurface
        eyebrow="Growth · GA4 + Search Console"
        title="Insights"
        description="Analytics, AI visibility, and SEO intelligence share the same workspace context."
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <SourceChip
              label="GA4"
              provider="ga4"
              businessId={selectedBusinessId ?? null}
            />
            <SourceChip
              label="Search Console"
              provider="search_console"
              businessId={selectedBusinessId ?? null}
            />
          </div>
        }
      >
        <div
          className="flex flex-wrap items-center gap-2"
          role="tablist"
          aria-label="Insights"
        >
          {INSIGHTS_TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.id}
                href={tab.href}
                role="tab"
                aria-selected={active}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-[13px] text-[12.5px] font-semibold transition-colors",
                  active
                    ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                    : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]",
                )}
                title={tab.desc}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        {children}
      </WorkspaceSurface>
    </PlanGate>
  );
}
