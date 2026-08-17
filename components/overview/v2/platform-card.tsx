"use client";

import { usePathname, useRouter } from "next/navigation";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import type { OverviewMetricCardData } from "@/src/types/models";
import { AdvSparkline } from "./adv-sparkline";
import { formatOverviewMetricValue, formatOverviewSparklineValue } from "./metric-format";

const PROVIDER_META: Record<string, { label: string; logo: string; href: string; cta: string }> = {
  meta: {
    label: "Meta Ads",
    logo: "/platform-logos/Meta.png",
    href: "/platforms/meta",
    cta: "Open Decisions",
  },
  google: {
    label: "Google Ads",
    logo: "/platform-logos/googleAds.svg",
    href: "/platforms/google",
    cta: "Open workspace",
  },
};

const PLATFORM_STAT_SLOTS = [
  { key: "spend", label: "Spend", aliases: ["spend"] },
  { key: "revenue", label: "Revenue", aliases: ["revenue"] },
  { key: "roas", label: "ROAS", aliases: ["roas"] },
  {
    key: "purchases",
    label: "Purchases",
    aliases: ["purchases", "conversions"],
  },
  { key: "cpa", label: "CPA", aliases: ["cpa"] },
] as const;

function metricForSlot(metrics: OverviewMetricCardData[], slot: (typeof PLATFORM_STAT_SLOTS)[number]) {
  return metrics.find((metric) => {
    const id = metric.id.toLowerCase();
    const title = metric.title.trim().toLowerCase();
    return slot.aliases.some((alias) => id === alias || id.endsWith(`-${alias}`) || title === alias);
  });
}

export function formatProviderSyncLabel(
  finishedAt: string | null | undefined,
  status: string | null | undefined,
  now = Date.now()
) {
  const completed = /^(succeeded|success|completed|complete|ready)$/i.test(status?.trim() ?? "");
  const timestamp = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  if (!completed || !Number.isFinite(timestamp)) return "Synced —";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

export function PlatformMiniDashboard({
  provider,
  title,
  metrics,
  currencySymbol,
  latestSync,
}: {
  provider: string;
  title: string;
  metrics: OverviewMetricCardData[];
  currencySymbol: string;
  latestSync?: { finishedAt?: string | null; status?: string | null } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const meta = PROVIDER_META[provider];
  const label = meta?.label ?? title;
  const syncLabel = formatProviderSyncLabel(latestSync?.finishedAt, latestSync?.status);
  const stats = PLATFORM_STAT_SLOTS.map((slot) => ({
    ...slot,
    metric: metricForSlot(metrics, slot),
  }));

  return (
    <article data-overview-provider={provider} className="adv-card flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] place-items-center rounded-[9px] border border-[#E4E8F0] bg-[#F1F4F9]">
          {meta ? (
            <span
              role="img"
              aria-label={label}
              className="inline-block h-[17px] w-[17px] bg-contain bg-center bg-no-repeat"
              style={{ backgroundImage: `url(${meta.logo})` }}
            />
          ) : null}
        </span>
        <span
          className="text-[15px] font-semibold text-[var(--adv-ink)]"
          style={{ fontFamily: "var(--adv-font-display)" }}
        >
          {label}
        </span>
        <span
          className="inline-flex items-center rounded-full text-[11px] font-semibold"
          style={{ gap: 5, padding: "2px 9px", background: "#E7F6F0", color: "#0E9F6E" }}
        >
          <span className="h-[5px] w-[5px] rounded-full bg-current" />
          {syncLabel}
        </span>
        {meta ? (
          <span
            onClick={() => router.push(dashboardHrefForRouteFamily(meta.href, pathname))}
            className="ml-auto text-[12.5px] font-semibold text-[var(--adv-accent)]"
            style={{ cursor: "pointer" }}
          >
            {meta.cta} →
          </span>
        ) : null}
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(96px,1fr))]">
        {stats.map(({ key, label: statLabel, metric }) => (
          <div key={key} className="min-w-0 rounded-[10px] bg-[#F7F9FC] px-[10px] pb-2 pt-[10px]">
            <p
              className="m-0 truncate text-[9px] uppercase tracking-[0.08em] text-[#7A869E]"
              style={{ fontFamily: "var(--adv-font-mono)" }}
            >
              {statLabel}
            </p>
            <p
              className="m-0 mt-[5px] whitespace-nowrap text-[16px] font-semibold text-[#0E1526]"
              style={{
                fontFamily: "var(--adv-font-display)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {!metric || metric.status === "unavailable" || metric.value === null
                ? "—"
                : formatOverviewMetricValue(metric, metric.value, currencySymbol)}
            </p>
            <AdvSparkline
              points={metric?.status === "unavailable" ? [] : (metric?.sparklineData ?? [])}
              previousPoints={metric?.status === "unavailable" ? undefined : metric?.previousSparklineData}
              line="#2F6BFF"
              fill="rgba(47,107,255,0.08)"
              height={24}
              format={(value) =>
                metric && metric.status !== "unavailable"
                  ? formatOverviewSparklineValue(metric, value, currencySymbol)
                  : "—"
              }
              ariaLabel={`${label} ${statLabel} trend`}
              marginTop={8}
            />
          </div>
        ))}
      </div>
    </article>
  );
}
