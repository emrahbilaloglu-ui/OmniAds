"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import {
  OVERVIEW_PROVIDER_METRIC_SPECS,
  providerMetricId,
  type OverviewProvider,
  type ProviderMetricSpec,
} from "@/lib/overview-provider-metrics";
import type { OverviewMetricCardData } from "@/src/types/models";
import { AdvSparkline, type SparklineDateDomain } from "./adv-sparkline";
import { DeltaChip } from "./metric-band";
import { formatOverviewMetricValue, formatOverviewSparklineValue } from "./metric-format";
import styles from "./platform-card.module.css";
import {
  SYNC_AGE_UNKNOWN_LABEL,
  isUnknownSyncAgeLabel,
} from "@/lib/provider-sync-vocabulary";

const PROVIDER_META: Record<OverviewProvider, { label: string; logo: string; href: string; cta: string }> = {
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

const SPARKLINE_HEIGHT = 30;

function isOverviewProvider(value: string): value is OverviewProvider {
  return value === "meta" || value === "google";
}

function isAvailable(metric: OverviewMetricCardData | undefined): metric is OverviewMetricCardData {
  return Boolean(metric && metric.status !== "unavailable" && metric.value !== null && Number.isFinite(metric.value));
}

export function formatProviderSyncLabel(
  finishedAt: string | null | undefined,
  status: string | null | undefined,
  now = Date.now()
) {
  const completed = /^(succeeded|success|completed|complete|ready)$/i.test(status?.trim() ?? "");
  const timestamp = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  if (!completed || !Number.isFinite(timestamp)) return SYNC_AGE_UNKNOWN_LABEL;
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

function ProviderStatTile({
  provider,
  providerLabel,
  spec,
  metric,
  currencySymbol,
  dateDomain,
  previousDateDomain,
}: {
  provider: OverviewProvider;
  providerLabel: string;
  spec: ProviderMetricSpec;
  metric: OverviewMetricCardData | undefined;
  currencySymbol: string;
  dateDomain?: SparklineDateDomain;
  previousDateDomain?: SparklineDateDomain;
}) {
  const id = providerMetricId(provider, spec.suffix);
  const available = isAvailable(metric);
  // The card's own identity (id/title/unit) always comes from the spec, so the
  // label, the formatter and the sparkline tooltip can never disagree.
  const identity = { id, title: spec.title, unit: spec.unit };
  const showDelta = available && metric.changePct !== null && Number.isFinite(metric.changePct);
  const reason = metric?.helperText ?? "No verified data for this window";

  return (
    <li
      className={`${styles.stat} min-w-0 rounded-[10px] bg-[#F7F9FC] px-3 pb-2.5 pt-3`}
      data-provider-metric-id={id}
      data-metric-state={available ? "available" : "unavailable"}
    >
      <div className="flex min-h-[20px] items-center justify-between gap-2">
        <p
          className="m-0 min-w-0 truncate text-[10px] uppercase tracking-[0.08em] text-[#555d6d]"
          style={{ fontFamily: "var(--adv-font-mono)" }}
        >
          {spec.title}
        </p>
        {showDelta ? (
          <span className="shrink-0" data-provider-metric-delta="">
            <DeltaChip metric={metric} />
            <span className="sr-only"> vs previous period</span>
          </span>
        ) : null}
      </div>
      <p
        className={`${styles.value} m-0 mt-1.5 whitespace-nowrap text-[18px] font-semibold text-[#0E1526]`}
        style={{
          fontFamily: "var(--adv-font-display)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {available ? formatOverviewMetricValue(identity, metric.value, currencySymbol) : "—"}
      </p>
      {available ? (
        <AdvSparkline
          points={metric.sparklineData}
          previousPoints={metric.previousSparklineData}
          dateDomain={dateDomain}
          previousDateDomain={previousDateDomain}
          line="#2a5fe2"
          fill="rgba(47,107,255,0.08)"
          height={SPARKLINE_HEIGHT}
          format={(value) => formatOverviewSparklineValue(identity, value, currencySymbol)}
          ariaLabel={`${providerLabel} ${spec.title} trend`}
          marginTop={8}
        />
      ) : (
        <p
          className={`${styles.reason} m-0 mt-2 text-[11px] leading-[15px] text-[#555d6d]`}
          style={{ minHeight: SPARKLINE_HEIGHT }}
        >
          {reason}
        </p>
      )}
    </li>
  );
}

export function PlatformMiniDashboard({
  provider,
  title,
  metrics,
  currencySymbol,
  latestSync,
  dateDomain,
  previousDateDomain,
}: {
  provider: string;
  title: string;
  metrics: OverviewMetricCardData[];
  currencySymbol: string;
  latestSync?: { finishedAt?: string | null; status?: string | null } | null;
  dateDomain?: SparklineDateDomain;
  previousDateDomain?: SparklineDateDomain;
}) {
  const pathname = usePathname();
  const knownProvider = isOverviewProvider(provider) ? provider : null;
  const meta = knownProvider ? PROVIDER_META[knownProvider] : null;
  const label = meta?.label ?? title;
  const syncLabel = formatProviderSyncLabel(latestSync?.finishedAt, latestSync?.status);
  // The pill used to be success-green for every status, so a failed, missing or
  // unparseable sync still looked like a completed one. Tone follows the label
  // the card actually renders: only a completed sync with a valid timestamp is
  // positive.
  const syncTone = isUnknownSyncAgeLabel(syncLabel) ? "neutral" : "positive";
  const specs = knownProvider ? OVERVIEW_PROVIDER_METRIC_SPECS[knownProvider] : [];
  const headingId = `overview-provider-${provider}-heading`;

  return (
    // The size container sits OUTSIDE the padded card so its breakpoints are
    // measured against the card's own rendered width, not its content box.
    <div className={styles.cardContainer} data-platform-card-container="">
      <article
        data-overview-provider={provider}
        aria-labelledby={headingId}
        className={`${styles.card} adv-card flex flex-col gap-3.5 p-4`}
      >
        <div className={`${styles.header} flex items-center gap-2.5`}>
          <span
            aria-hidden="true"
            className="grid h-[30px] w-[30px] place-items-center rounded-[9px] border border-[#E4E8F0] bg-[#F1F4F9]"
          >
            {meta ? (
              // Decorative: the adjacent h2 already names the provider.
              <span
                className="inline-block h-[17px] w-[17px] bg-contain bg-center bg-no-repeat"
                style={{ backgroundImage: `url(${meta.logo})` }}
              />
            ) : null}
          </span>
          <h2
            id={headingId}
            className="m-0 text-[15px] font-semibold text-[var(--adv-ink)]"
            style={{ fontFamily: "var(--adv-font-display)" }}
          >
            {label}
          </h2>
          <span
            className="inline-flex items-center rounded-full text-[11px] font-semibold"
            data-sync-tone={syncTone}
            style={{
              gap: 5,
              padding: "2px 9px",
              background: syncTone === "positive" ? "#E7F6F0" : "#EEF1F6",
              color: syncTone === "positive" ? "#0b7954" : "#555d6d",
            }}
          >
            <span className="h-[5px] w-[5px] rounded-full bg-current" />
            {syncLabel}
          </span>
          {meta ? (
            <Link
              href={dashboardHrefForRouteFamily(meta.href, pathname)}
              className={`${styles.cta} ml-auto text-[12.5px] font-semibold text-[var(--adv-accent)]`}
            >
              {meta.cta} <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
        <ul role="list" aria-label={`${label} metrics`} className={styles.stats}>
          {knownProvider
            ? specs.map((spec) => (
                <ProviderStatTile
                  key={spec.suffix}
                  provider={knownProvider}
                  providerLabel={label}
                  spec={spec}
                  metric={metrics.find((candidate) => candidate.id === providerMetricId(knownProvider, spec.suffix))}
                  currencySymbol={currencySymbol}
                  dateDomain={dateDomain}
                  previousDateDomain={previousDateDomain}
                />
              ))
            : null}
        </ul>
      </article>
    </div>
  );
}
