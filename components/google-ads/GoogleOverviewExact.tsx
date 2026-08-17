"use client";

import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import styles from "@/components/google-ads/GoogleOverviewExact.module.css";
import type {
  GoogleOverviewCampaignModel,
  GoogleOverviewChartModel,
  GoogleOverviewChartValueKind,
  GoogleOverviewExactModel,
  GoogleOverviewFreshnessState,
  GoogleOverviewLookCardModel,
  GoogleOverviewRouteTarget,
} from "@/components/google-ads/google-overview-exact-model";

export type {
  GoogleOverviewExactModel,
  GoogleOverviewFreshnessState,
  GoogleOverviewRouteTarget,
} from "@/components/google-ads/google-overview-exact-model";

const DASH = "—";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatCurrency(
  value: number,
  currencyCode: string,
  digits: 0 | 2,
): string {
  if (currencyCode === DASH) return DASH;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return DASH;
  }
}

function formatChartValue(
  value: number | null,
  kind: GoogleOverviewChartValueKind,
  currencyCode: string,
): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  switch (kind) {
    case "currency-0":
      return formatCurrency(value, currencyCode, 0);
    case "currency-2":
      return formatCurrency(value, currencyCode, 2);
    case "decimal-2":
      return value.toFixed(2);
    case "percent-1":
      return `${value.toFixed(1)}%`;
    case "compact": {
      const abs = Math.abs(value);
      if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
      if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
      return String(Math.round(value));
    }
    default:
      return String(Math.round(value));
  }
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value || DASH;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDelta(current: number | null, previous: number | null): string {
  if (current === null || previous === null || previous === 0) return DASH;
  const value = ((current - previous) / previous) * 100;
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

interface ChartGeometry {
  count: number;
  x: (index: number) => number;
  y: (value: number) => number;
  currentPoints: string;
  previousPoints: string;
  areaPoints: string;
  average: number | null;
  minimumIndex: number | null;
  maximumIndex: number | null;
}

function buildChartGeometry(chart: GoogleOverviewChartModel): ChartGeometry | null {
  const currentValues = chart.points
    .map((point) => point.current)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const previousValues = chart.points
    .map((point) => point.previous)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (currentValues.length === 0) return null;

  const allValues = [...currentValues, ...previousValues];
  let low = Math.min(...allValues);
  let high = Math.max(...allValues);
  if (low === high) {
    const expansion = Math.max(Math.abs(low) * 0.08, 1);
    low -= expansion;
    high += expansion;
  }
  const padding = (high - low) * 0.08;
  const paddedLow = low - padding;
  const paddedHigh = high + padding;
  const count = chart.points.length;
  const x = (index: number) => (count <= 1 ? 50 : (index / (count - 1)) * 100);
  const y = (value: number) =>
    8 + (1 - (value - paddedLow) / (paddedHigh - paddedLow)) * 84;
  const pointString = (which: "current" | "previous") =>
    chart.points
      .map((point, index) => {
        const value = point[which];
        return value === null || !Number.isFinite(value)
          ? null
          : `${x(index).toFixed(2)},${y(value).toFixed(2)}`;
      })
      .filter((value): value is string => value !== null)
      .join(" ");

  let minimumIndex: number | null = null;
  let maximumIndex: number | null = null;
  chart.points.forEach((point, index) => {
    if (point.current === null || !Number.isFinite(point.current)) return;
    if (
      minimumIndex === null ||
      point.current < (chart.points[minimumIndex]?.current ?? Number.POSITIVE_INFINITY)
    ) {
      minimumIndex = index;
    }
    if (
      maximumIndex === null ||
      point.current > (chart.points[maximumIndex]?.current ?? Number.NEGATIVE_INFINITY)
    ) {
      maximumIndex = index;
    }
  });

  const currentPoints = pointString("current");
  return {
    count,
    x,
    y,
    currentPoints,
    previousPoints: pointString("previous"),
    areaPoints: currentPoints
      ? `0,100 ${currentPoints} 100,100`
      : "",
    average:
      currentValues.reduce((sum, value) => sum + value, 0) / currentValues.length,
    minimumIndex,
    maximumIndex,
  };
}

function markerStyle(
  geometry: ChartGeometry,
  chart: GoogleOverviewChartModel,
  index: number,
  radius: number,
): CSSProperties {
  const value = chart.points[index]?.current;
  return {
    left: `calc(${geometry.x(index).toFixed(2)}% - ${radius}px)`,
    top:
      value === null || value === undefined
        ? "0"
        : `calc(${geometry.y(value).toFixed(2)}% - ${radius}px)`,
  };
}

function GoogleOverviewChart({
  chart,
  height,
  currencyCode,
}: {
  chart: GoogleOverviewChartModel;
  height: 56 | 32;
  currencyCode: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const geometry = useMemo(() => buildChartGeometry(chart), [chart]);
  if (!geometry) {
    return (
      <div
        className={styles.chartEmpty}
        style={{ height }}
        data-testid="overview-chart-empty"
        aria-label="Trend unavailable"
      />
    );
  }

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
    const index = Math.max(
      0,
      Math.min(geometry.count - 1, Math.round(ratio * (geometry.count - 1))),
    );
    setHoveredIndex(index);
  };
  const hovered = hoveredIndex === null ? null : chart.points[hoveredIndex] ?? null;
  const hoveredTop =
    hovered?.current === null || hovered?.current === undefined
      ? 50
      : geometry.y(hovered.current);

  return (
    <div
      className={styles.chart}
      style={{ height }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredIndex(null)}
      data-testid={`overview-chart-${chart.id}`}
      role="img"
      aria-label={`${chart.id} trend`}
    >
      <svg
        className={styles.chartSvg}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon className={styles.chartArea} points={geometry.areaPoints} />
        {geometry.previousPoints ? (
          <polyline
            className={styles.chartPrevious}
            points={geometry.previousPoints}
            vectorEffect="non-scaling-stroke"
            data-testid="overview-chart-previous"
          />
        ) : null}
        <polyline
          className={styles.chartCurrent}
          points={geometry.currentPoints}
          vectorEffect="non-scaling-stroke"
          data-testid="overview-chart-current"
        />
      </svg>

      {geometry.average !== null ? (
        <>
          <div
            className={styles.chartAverageLine}
            style={{ top: `${geometry.y(geometry.average).toFixed(2)}%` }}
            data-testid="overview-chart-average"
          />
          <span
            className={styles.chartAverageLabel}
            style={{ top: `calc(${geometry.y(geometry.average).toFixed(2)}% - 13px)` }}
          >
            avg {formatChartValue(geometry.average, chart.valueKind, currencyCode)}
          </span>
        </>
      ) : null}

      {geometry.maximumIndex !== null ? (
        <span
          className={classNames(styles.chartMarker, styles.chartMarkerMaximum)}
          style={markerStyle(geometry, chart, geometry.maximumIndex, 3)}
          data-testid="overview-chart-maximum"
        />
      ) : null}
      {geometry.minimumIndex !== null ? (
        <span
          className={classNames(styles.chartMarker, styles.chartMarkerMinimum)}
          style={markerStyle(geometry, chart, geometry.minimumIndex, 3)}
          data-testid="overview-chart-minimum"
        />
      ) : null}

      {hoveredIndex !== null && hovered ? (
        <>
          <div
            className={styles.chartGuide}
            style={{ left: `${geometry.x(hoveredIndex).toFixed(2)}%` }}
            data-testid="overview-chart-guide"
          />
          {hovered.current !== null ? (
            <span
              className={styles.chartHoverDot}
              style={markerStyle(geometry, chart, hoveredIndex, 3.5)}
            />
          ) : null}
          <div
            className={styles.chartTooltip}
            style={{
              left: `${Math.max(14, Math.min(86, geometry.x(hoveredIndex)))}%`,
              top:
                hoveredTop < 34
                  ? `calc(${hoveredTop.toFixed(2)}% + 10px)`
                  : `calc(${hoveredTop.toFixed(2)}% - 26px)`,
            }}
            data-testid="overview-chart-tooltip"
          >
            <div>
              {formatDate(hovered.date)} · {formatChartValue(hovered.current, chart.valueKind, currencyCode)}
            </div>
            {hovered.previous !== null ? (
              <div className={styles.chartTooltipPrevious}>
                prev {formatChartValue(hovered.previous, chart.valueKind, currencyCode)} ·{" "}
                {formatDelta(hovered.current, hovered.previous)}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function freshnessClass(state: GoogleOverviewFreshnessState) {
  switch (state) {
    case "fresh":
      return styles.freshnessFresh;
    case "stale":
      return styles.freshnessStale;
    case "syncing":
      return styles.freshnessSyncing;
    default:
      return styles.freshnessUnavailable;
  }
}

function severityClass(tone: GoogleOverviewLookCardModel["tone"]) {
  switch (tone) {
    case "critical":
      return styles.severityCritical;
    case "waste":
      return styles.severityWaste;
    case "opportunity":
      return styles.severityOpportunity;
    case "positive":
      return styles.severityPositive;
    default:
      return styles.severityNeutral;
  }
}

function toneClass(tone: GoogleOverviewCampaignModel["roasTone"]) {
  switch (tone) {
    case "positive":
      return styles.tonePositive;
    case "warning":
      return styles.toneWarning;
    case "negative":
      return styles.toneNegative;
    default:
      return styles.toneNeutral;
  }
}

function campaignTypeClass(tone: GoogleOverviewCampaignModel["typeTone"]) {
  switch (tone) {
    case "info":
      return styles.campaignTypeInfo;
    case "auto":
      return styles.campaignTypeAuto;
    default:
      return styles.campaignTypeNeutral;
  }
}

function DesktopOverview({
  model,
  onNavigate,
}: {
  model: GoogleOverviewExactModel;
  onNavigate?: (target: GoogleOverviewRouteTarget) => void;
}) {
  return (
    <section
      className={styles.desktopSurface}
      data-screen-label="Google Ads · Overview"
      data-layout="desktop"
    >
      <div className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>
            Google Ads · {model.identity.providerAccountId} · {model.identity.currencyCode} ·{" "}
            {model.identity.windowLabel} window
          </p>
          <h1 className={styles.pageTitle}>Overview</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>writes guarded · receipt on every change</span>
          <span
            className={classNames(styles.freshnessPill, freshnessClass(model.freshness.state))}
            data-testid="google-overview-freshness"
          >
            <span className={styles.freshnessDot} />
            {model.freshness.label}
          </span>
        </div>
      </div>

      <div className={styles.heroGrid} data-testid="google-overview-hero-grid">
        {model.hero.map((metric) => (
          <article
            key={metric.key}
            className={styles.heroCard}
            data-testid="google-overview-hero-card"
          >
            <p className={styles.metricLabel}>{metric.label}</p>
            <p className={styles.metricValue}>{metric.value}</p>
            <div className={styles.metricMeta}>
              <span
                className={classNames(
                  styles.metricDelta,
                  metric.deltaTone === "positive"
                    ? styles.metricDeltaPositive
                    : metric.deltaTone === "negative"
                      ? styles.metricDeltaNegative
                      : styles.metricDeltaNeutral,
                )}
              >
                {metric.delta ?? DASH}
              </span>
              <span className={styles.metricDetail}>{metric.detail ?? DASH}</span>
            </div>
            <GoogleOverviewChart
              chart={metric.chart}
              height={56}
              currencyCode={model.identity.currencyCode}
            />
          </article>
        ))}
      </div>

      <article className={styles.secondaryStrip} data-testid="google-overview-secondary-strip">
        {model.secondary.map((metric) => (
          <div
            key={metric.key}
            className={styles.secondaryMetric}
            data-testid="google-overview-secondary-metric"
          >
            <p className={styles.secondaryLabel}>{metric.label}</p>
            <p className={styles.secondaryValue}>{metric.value}</p>
            <GoogleOverviewChart
              chart={metric.chart}
              height={32}
              currencyCode={model.identity.currencyCode}
            />
          </div>
        ))}
      </article>

      <div className={styles.lookGrid} data-testid="google-overview-look-grid">
        {model.lookCards.map((card) => (
          <article
            key={card.id}
            className={styles.lookCard}
            data-testid="google-overview-look-card"
          >
            <div>
              <span className={classNames(styles.severity, severityClass(card.tone))}>
                {card.severity}
              </span>
            </div>
            <p className={styles.lookTitle}>{card.title}</p>
            <p className={styles.lookDescription}>{card.description}</p>
            <div className={styles.lookFooter}>
              <span className={styles.lookEvidence}>{card.evidence}</span>
              {card.target && onNavigate ? (
                <button
                  type="button"
                  className={styles.lookAction}
                  onClick={() => onNavigate(card.target as GoogleOverviewRouteTarget)}
                >
                  {card.actionLabel} →
                </button>
              ) : (
                <span className={styles.lookActionUnavailable}>{card.actionLabel}</span>
              )}
            </div>
          </article>
        ))}
      </div>

      <article className={styles.tableCard} data-testid="google-overview-campaigns">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Campaigns</h2>
          <span className={styles.sectionNote}>{model.campaignSummary}</span>
        </div>
        <table className={styles.campaignTable}>
          <thead>
            <tr>
              <th className={styles.alignLeft}>Campaign</th>
              <th className={styles.alignRight}>Daily budget</th>
              <th className={styles.alignRight}>Spend · {model.identity.windowLabel}</th>
              <th className={styles.alignLeft}>Share</th>
              <th className={styles.alignRight}>Revenue</th>
              <th className={styles.alignRight}>ROAS</th>
              <th className={styles.alignRight}>Conv</th>
              <th className={styles.alignRight}>IS</th>
              <th className={styles.alignRight}>Lost IS · budget</th>
              <th className={styles.alignLeft}>Pulse</th>
            </tr>
          </thead>
          <tbody>
            {model.campaigns.length > 0 ? (
              model.campaigns.map((campaign) => (
                <tr key={campaign.id} className={styles.campaignRow}>
                  <td>
                    <span className={styles.campaignName}>{campaign.name}</span>
                    <span
                      className={classNames(
                        styles.campaignType,
                        campaignTypeClass(campaign.typeTone),
                      )}
                    >
                      {campaign.type}
                    </span>
                  </td>
                  <td className={classNames(styles.alignRight, styles.campaignMuted)}>
                    {campaign.dailyBudget}
                  </td>
                  <td className={classNames(styles.alignRight, styles.campaignStrong)}>
                    {campaign.spend}
                  </td>
                  <td className={styles.shareCell}>
                    <div className={styles.shareWrap}>
                      <div className={styles.shareTrack}>
                        <div
                          className={styles.shareFill}
                          style={{ width: `${campaign.spendShareWidth.toFixed(1)}%` }}
                          data-testid="google-overview-share-fill"
                        />
                      </div>
                      <span className={styles.shareValue}>{campaign.spendShare}</span>
                    </div>
                  </td>
                  <td className={classNames(styles.alignRight, styles.campaignMuted)}>
                    {campaign.revenue}
                  </td>
                  <td className={styles.alignRight}>
                    <span className={classNames(styles.roasPill, toneClass(campaign.roasTone))}>
                      {campaign.roas}
                    </span>
                  </td>
                  <td className={classNames(styles.alignRight, styles.campaignMuted)}>
                    {campaign.conversions}
                  </td>
                  <td className={classNames(styles.alignRight, styles.isValue)}>
                    {campaign.impressionShare}
                  </td>
                  <td
                    className={classNames(
                      styles.alignRight,
                      campaign.lostImpressionShareTone === "warning"
                        ? styles.lostWarning
                        : styles.lostNeutral,
                    )}
                  >
                    {campaign.lostImpressionShareBudget}
                  </td>
                  <td>
                    <span className={classNames(styles.pulsePill, toneClass(campaign.pulseTone))}>
                      {campaign.pulse}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr className={styles.emptyRow}>
                <td colSpan={10}>{DASH}</td>
              </tr>
            )}
          </tbody>
        </table>
      </article>

      <article className={styles.budgetCard} data-testid="google-overview-budget">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Budget &amp; scaling</h2>
          <span className={styles.sectionNote}>{model.budgetNote}</span>
        </div>
        <div className={styles.budgetKpiGrid}>
          {model.budgetKpis.map((kpi) => (
            <div key={kpi.key} className={styles.budgetKpi} data-testid="google-overview-budget-kpi">
              <p className={styles.budgetKpiLabel}>{kpi.label}</p>
              <p className={styles.budgetKpiValue}>{kpi.value}</p>
              <p className={styles.budgetKpiDetail}>{kpi.detail}</p>
            </div>
          ))}
        </div>
        <div className={styles.budgetRecommendations}>
          {model.budgetRecommendations.map((recommendation) => (
            <div
              key={recommendation.id}
              className={styles.budgetRecommendation}
              data-testid="google-overview-budget-recommendation"
            >
              <div className={styles.budgetRecommendationHeader}>
                <span className={styles.budgetCampaign}>{recommendation.campaign}</span>
                <span
                  className={classNames(
                    styles.budgetAmount,
                    recommendation.direction === "increase"
                      ? styles.budgetAmountIncrease
                      : recommendation.direction === "decrease"
                        ? styles.budgetAmountDecrease
                        : styles.budgetAmountNeutral,
                  )}
                >
                  {recommendation.amount}
                </span>
              </div>
              <p className={styles.budgetReason}>{recommendation.reason}</p>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function MobileReadOnlyOverview({ model }: { model: GoogleOverviewExactModel }) {
  return (
    <section
      className={styles.mobileSurface}
      data-screen-label="Google Ads · Overview · Mobile read-only"
      data-layout="mobile-read-only"
    >
      <div className={styles.mobileHeader}>
        <div>
          <p className={styles.pageEyebrow}>
            Google Ads · {model.identity.providerAccountId} · {model.identity.currencyCode}
          </p>
          <h1 className={styles.pageTitle}>Overview</h1>
        </div>
        <span className={styles.mobileReadOnly}>Read-only</span>
      </div>

      <div className={styles.mobileFreshness}>
        <span>{model.identity.windowLabel} window</span>
        <span>{model.freshness.label}</span>
      </div>

      <div className={styles.mobileKpiGrid}>
        {model.hero.map((metric) => (
          <article key={metric.key} className={styles.mobileKpi}>
            <p className={styles.mobileKpiLabel}>{metric.label}</p>
            <p className={styles.mobileKpiValue}>{metric.value}</p>
          </article>
        ))}
      </div>

      <article className={styles.mobileCard}>
        <h2 className={styles.mobileCardTitle}>Campaigns</h2>
        {model.campaigns.length > 0 ? (
          model.campaigns.map((campaign) => (
            <div key={campaign.id} className={styles.mobileCampaignRow}>
              <span className={styles.mobileCampaignName}>{campaign.name}</span>
              <span className={styles.mobileValue}>{campaign.spend}</span>
              <span className={styles.mobileValue}>{campaign.roas}</span>
            </div>
          ))
        ) : (
          <p className={styles.mobileEmpty}>{DASH}</p>
        )}
      </article>

      <article className={styles.mobileCard}>
        <h2 className={styles.mobileCardTitle}>Budget &amp; scaling</h2>
        {model.budgetKpis.map((kpi) => (
          <div key={kpi.key} className={styles.mobileBudgetRow}>
            <span className={styles.mobileBudgetLabel}>{kpi.label}</span>
            <span className={styles.mobileValue}>{kpi.value}</span>
          </div>
        ))}
      </article>
    </section>
  );
}

export function GoogleOverviewExact({
  model,
  onNavigate,
}: {
  model: GoogleOverviewExactModel;
  onNavigate?: (target: GoogleOverviewRouteTarget) => void;
}) {
  return (
    <div className={styles.root} data-business-id={model.identity.businessId}>
      <DesktopOverview model={model} onNavigate={onNavigate} />
      <MobileReadOnlyOverview model={model} />
    </div>
  );
}
