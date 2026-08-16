"use client";

import Image from "next/image";
import Link from "next/link";
import { EXACT_METRIC_FORMAT, formatMetricValue } from "@/lib/metric-format";
import type { SyncStatusPillState } from "@/lib/sync/sync-status-pill";
import type { OverviewMetricCardData } from "@/src/types/models";
import { AdvSparkline } from "./adv-sparkline";

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
  google_ads: {
    label: "Google Ads",
    logo: "/platform-logos/googleAds.svg",
    href: "/platforms/google",
    cta: "Open workspace",
  },
  klaviyo: {
    label: "Klaviyo",
    logo: "/platform-logos/Klaviyo.svg",
    href: "/platforms/klaviyo/flows",
    cta: "Open Klaviyo",
  },
  tiktok: {
    label: "TikTok Ads",
    logo: "/platform-logos/tiktok.svg",
    href: "/platforms/tiktok",
    cta: "Open TikTok",
  },
  ga4: {
    label: "GA4",
    logo: "/platform-logos/GA4.svg",
    href: "/insights/analytics",
    cta: "Open Analytics",
  },
};

export function PlatformMiniDashboard({
  provider,
  title,
  metrics,
  currencySymbol,
  syncPill,
}: {
  provider: string;
  title: string;
  metrics: OverviewMetricCardData[];
  currencySymbol: string;
  syncPill?: SyncStatusPillState | null;
}) {
  const meta = PROVIDER_META[provider];
  const label = meta?.label ?? title;

  return (
    <article className="adv-card flex flex-col gap-3.5 p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] place-items-center rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-fill-2)]">
          {meta ? (
            <Image
              src={meta.logo}
              alt=""
              width={17}
              height={17}
              className="h-[17px] w-[17px] object-contain"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span
          className="text-[15px] font-semibold text-[var(--adv-ink)]"
          style={{ fontFamily: "var(--adv-font-display)" }}
        >
          {label}
        </span>
        {syncPill?.visible ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={
              syncPill.tone === "success"
                ? { background: "var(--adc-pos-bg)", color: "var(--adc-pos-fg)" }
                : syncPill.tone === "warning"
                  ? { background: "var(--adc-caution-bg)", color: "var(--adc-caution-fg)" }
                  : { background: "var(--adv-accent-bg)", color: "var(--adv-accent)" }
            }
          >
            <span className="h-[5px] w-[5px] rounded-full bg-current" />
            {syncPill.label}
          </span>
        ) : null}
        {meta ? (
          <Link
            href={meta.href}
            className="ml-auto text-[12.5px] font-semibold text-[var(--adv-accent)]"
          >
            {meta.cta} →
          </Link>
        ) : null}
      </div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(96px,1fr))]">
        {metrics.map((metric) => (
          <div key={metric.id} className="adv-tile adv-tile--fill">
            <p className="adv-label truncate">{metric.title}</p>
            <p
              className="adv-num m-0 mt-1.5 whitespace-nowrap text-[16px] font-semibold"
              style={{ fontFamily: "var(--adv-font-display)" }}
            >
              {metric.value === null
                ? "—"
                : formatMetricValue(metric.value, metric.unit, currencySymbol, EXACT_METRIC_FORMAT)}
            </p>
            <div className="mt-2">
              <AdvSparkline
                points={metric.sparklineData}
                previousPoints={metric.previousSparklineData}
                line="#2F6BFF"
                fill="rgba(47,107,255,0.08)"
                height={24}
                format={(value) => formatMetricValue(value, metric.unit, currencySymbol, EXACT_METRIC_FORMAT)}
                ariaLabel={`${label} ${metric.title} trend`}
              />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
