"use client";

/**
 * Client Home (H03/H04/H08).
 *
 * A new composition, not the legacy dashboard body: it renders the metric
 * contract, which is the only thing allowed to say what a number means.
 *
 * Refresh keeps the last truthful content on screen. Blanking to skeletons
 * while a refresh is in flight replaces known-good numbers with nothing, and if
 * the refresh then fails the operator is left worse off than before they asked.
 * The stale content stays, labelled stale, until something better arrives.
 */
import { MetricCard } from "@/components/zero-base/home/metric-card";
import { SourceHealthPanel } from "@/components/zero-base/home/source-health";
import { EconomicsContext } from "@/components/zero-base/home/economics-context";
import { HomeDateRangeControl } from "@/components/zero-base/home/home-date-range-control";
import { TrendPanel, type TrendPoint } from "@/components/zero-base/home/trend-panel";
import { Button } from "@/components/zero-base/primitives/button";
import type { DateRangeValue } from "@/components/date-range/DateRangePicker";
import type { HomeContract } from "@/lib/zero-base/home/metric-contract";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export type HomeRefreshState = "idle" | "refreshing" | "failed";

export function HomeView({
  contract,
  businessId = null,
  connectHref = null,
  triageHref = null,
  trend,
  economics,
  dateRange,
  referenceDate,
  timeZone,
  refreshState = "idle",
  onRefresh,
}: {
  contract: HomeContract;
  businessId?: string | null;
  /** Where an unconfigured source is connected. */
  connectHref?: string | null;
  /** Mobile entry into Tier-0 triage. Absent at desktop widths. */
  triageHref?: string | null;
  /** Daily spend and ROAS. Absent when the trend genuinely has no points. */
  trend?: { points: readonly TrendPoint[]; currency: string | null } | null;
  /** Absent when no economics source has been configured for this business. */
  economics?: EconomicsContextModel | null;
  /** The legacy Overview picker value, now URL-backed on canonical Home. */
  dateRange?: DateRangeValue;
  referenceDate?: string;
  timeZone?: string;
  refreshState?: HomeRefreshState;
  onRefresh?: () => void;
}) {
  const copy = useCopy();
  return (
    <div data-home-surface="" data-refresh-state={refreshState}>
      <header
        style={{
          marginBottom: 16,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.home}</h1>
        {dateRange && referenceDate && timeZone ? (
          <HomeDateRangeControl value={dateRange} referenceDate={referenceDate} timeZone={timeZone} />
        ) : null}
        {triageHref ? (
          // The mobile entry into Tier-0 triage: on a phone the operator is
          // usually here to act on the worst thing first, not to browse.
          <p style={{ margin: "8px 0 0", fontSize: 13 }}>
            <a
              href={triageHref}
              data-ctl="live:MOBILE-01"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 44,
                color: "var(--ledger-accent-action)",
              }}
            >
              {copy.startTriage}
            </a>
          </p>
        ) : null}
      </header>

      {/* Refresh never blanks the surface. While it runs, and if it fails, the
          previous numbers stay visible and are labelled for what they are. */}
      {refreshState !== "idle" ? (
        <p
          role="status"
          aria-live="polite"
          data-refresh-notice={refreshState}
          style={{
            margin: "0 0 16px",
            padding: "10px 14px",
            borderRadius: "var(--ledger-radius-card)",
            border: "1px dashed var(--ledger-border-control)",
            fontSize: 12,
            lineHeight: "18px",
            color: "var(--ledger-ink-secondary)",
          }}
        >
          {refreshState === "refreshing"
            ? "Refreshing. The figures below are the last ones we served."
            : "Refresh failed. The figures below are the last ones we served, unchanged."}
        </p>
      ) : null}

      <section
        aria-label={copy.keyMetrics}
        data-metric-grid=""
        data-el="home-kpis"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(170px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        {contract.metrics.map((metric) => (
          <MetricCard key={metric.key} metric={metric} />
        ))}
      </section>

      <div
        data-home-detail-grid=""
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(300px, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div>
          {trend ? (
            <TrendPanel
              title={copy.spendRoasTrend}
              points={trend.points}
              currency={trend.currency}
              targetRoas={economics?.targetRoas ?? null}
              surface="home"
            />
          ) : (
            <section
              style={{
                minHeight: 220,
                padding: 16,
                border: "1px solid var(--ledger-border-subtle)",
                borderRadius: "var(--ledger-radius-card)",
                background: "var(--ledger-bg-surface)",
              }}
            >
              <h2 style={{ margin: 0, fontSize: 16 }}>{copy.spendRoasTrend}</h2>
              <p style={{ color: "var(--ledger-ink-tertiary)", fontSize: 13 }}>{copy.noDailyTrendServed}</p>
            </section>
          )}
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div data-el="source-readiness">
            <SourceHealthPanel sources={contract.sources} connectHref={connectHref} compact />
          </div>
          {economics ? <EconomicsContext model={economics} businessId={businessId} /> : null}
        </div>
      </div>

      <style>{`
        @media (max-width: 1040px) {
          [data-home-surface] [data-metric-grid] { grid-template-columns: repeat(2, minmax(170px, 1fr)) !important; }
          [data-home-detail-grid] { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 540px) {
          [data-home-surface] [data-metric-grid] { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {onRefresh ? (
        <Button
          variant="secondary"
          onClick={onRefresh}
          state={refreshState === "refreshing" ? { kind: "busy", label: "Refreshing…" } : { kind: "enabled" }}
          style={{ marginTop: 16 }}
        >
          {copy.refresh}
        </Button>
      ) : null}
    </div>
  );
}
