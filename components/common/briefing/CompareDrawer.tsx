import type { ReactNode } from "react";
import { CreativeRenderSurface, type CreativeRenderPayload } from "@/components/creatives/CreativeRenderSurface";
import type { DecisionLabel } from "@/components/common/briefing/types";
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

export interface CompareDrawerItem {
  id: string;
  name: string;
  brand?: string;
  label: DecisionLabel;
  spend?: number;
  roas?: number;
  ctr?: number;
  cpa?: number;
  purchases?: number;
  frequency?: number;
  sparkline?: number[];
  mediaPreviewUrl?: string | null;
  thumbnailUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cardPreviewUrl?: string | null;
  previewUrl?: string | null;
  imageUrl?: string | null;
  cachedThumbnailUrl?: string | null;
  preview?: CreativeRenderPayload | null;
  format?: string | null;
  creativeVisualFormat?: string | null;
  creativePrimaryType?: string | null;
  creativePrimaryLabel?: string | null;
  creativeSecondaryType?: string | null;
  creativeSecondaryLabel?: string | null;
  creativeDeliveryType?: string | null;
  isCatalog?: boolean | null;
  overflowCount?: number;
}

export interface CompareDrawerMetric {
  key: string;
  label: string;
  format: (value: number) => string;
  getValue: (item: CompareDrawerItem) => number;
}

interface CompareDrawerProps {
  open: boolean;
  items: CompareDrawerItem[];
  metrics?: CompareDrawerMetric[];
  entityLabel?: string;
  trendLabel?: string;
  actionBar?: ReactNode;
  onClose?: () => void;
}

const DEFAULT_METRICS: CompareDrawerMetric[] = [
  { key: "spend", label: "Spend", getValue: (item) => item.spend ?? 0, format: formatCurrency },
  { key: "roas", label: "ROAS", getValue: (item) => item.roas ?? 0, format: formatRoas },
  { key: "ctr", label: "CTR", getValue: (item) => item.ctr ?? 0, format: (value) => `${value.toFixed(2)}%` },
  { key: "frequency", label: "Freq", getValue: (item) => item.frequency ?? 0, format: (value) => value.toFixed(1) },
];

export function CompareDrawer({
  open,
  items,
  metrics = DEFAULT_METRICS,
  entityLabel = "creatives",
  trendLabel = "Performance comparison",
  actionBar,
  onClose,
}: CompareDrawerProps) {
  if (!open) return null;

  const cards = items.slice(0, 4);
  const hiddenCount = Math.max(0, items.length - cards.length);
  const displayMetrics = (metrics.length > 0 ? metrics : DEFAULT_METRICS).slice(0, 4);

  return (
    <div className="compare-drawer-shell" data-drawer="compare" data-testid="compare-drawer">
      <section className="compare-drawer-panel" aria-label={`Compare ${cards.length} ${entityLabel}`}>
        <header className="compare-drawer-header">
          <div className="compare-drawer-titleblock">
            <span className="compare-drawer-eyebrow">Compare</span>
            <h2>{cards.length} {entityLabel}</h2>
            <p>
              {trendLabel} · aligned metrics and media previews
              {hiddenCount > 0 ? ` · showing first 4 of ${items.length}` : ""}
            </p>
          </div>
          <div className="compare-drawer-header-actions">
            <span className="compare-drawer-count">{cards.length} selected</span>
            {onClose ? (
              <button
                type="button"
                className="compare-drawer-close"
                aria-label="Close compare drawer"
                data-drawer-close
                onClick={onClose}
              >
                Close
              </button>
            ) : null}
          </div>
        </header>

        <div className="compare-drawer-body">
          <div
            className="compare-drawer-grid"
            style={{ gridTemplateColumns: `repeat(${Math.max(cards.length, 1)}, minmax(0, 1fr))` }}
          >
            {cards.map((card, index) => (
              <CompareCard
                key={card.id}
                item={card}
                metrics={displayMetrics}
                highlighted={index === bestCardIndex(cards)}
              />
            ))}
          </div>
        </div>

        <footer className="compare-drawer-footer">
          <span className="compare-drawer-note">
            Highest ROAS is highlighted
            {hiddenCount > 0 ? ` · ${hiddenCount} more not shown` : ""}
          </span>
          <div className="compare-drawer-actions">
            {actionBar}
          </div>
        </footer>
      </section>
    </div>
  );
}

function CompareCard({
  item,
  metrics,
  highlighted,
}: {
  item: CompareDrawerItem;
  metrics: CompareDrawerMetric[];
  highlighted: boolean;
}) {
  const fallbacks = compareMediaFallbacks(item);
  const preview = previewForCompareItem(item, fallbacks);
  const format = getCreativeFormatPresentation({ ...item, preview });
  const hasMedia = fallbacks.length > 0 || Boolean(preview.image_url || preview.poster_url || preview.video_url);
  const mediaShape = format.shape;

  return (
    <article className={["compare-drawer-card", highlighted ? "compare-drawer-card--winner" : ""].filter(Boolean).join(" ")}>
      <div className="compare-drawer-card-head">
        <span className={["compare-drawer-chip", `compare-drawer-chip--${chipTone(item.label)}`].join(" ")}>
          <span className="compare-drawer-chip-dot" aria-hidden="true" />
          {decisionLabelText(item.label)}
        </span>
        <span className="compare-drawer-format" title={format.detailLabel}>{format.tag}</span>
        {highlighted ? <span className="compare-drawer-winner">Best ROAS</span> : null}
      </div>
      <div className="compare-drawer-media">
        <div className={["compare-drawer-media-frame", `compare-drawer-media-frame--${mediaShape}`].join(" ")} data-media-shape={mediaShape}>
          {hasMedia ? (
            <CreativeRenderSurface
              id={item.id}
              name={item.name}
              preview={preview}
              mode="asset"
              size="card"
              assetFallbacks={fallbacks}
              className="compare-drawer-render-surface"
            />
          ) : (
            <span className="compare-drawer-media-glyph" aria-hidden="true">{format.icon}</span>
          )}
          <span className="compare-drawer-ratio">{format.ratio}</span>
        </div>
      </div>
      <div className="compare-drawer-card-body">
        <h3 title={item.name}>{item.name}</h3>
        <div className="compare-drawer-card-meta" title={compareMetaLine(item)}>
          {compareMetaLine(item)}
        </div>
        <div
          className="compare-drawer-metric-strip"
          style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}
        >
          {metrics.map((metric) => {
            const value = metric.getValue(item);
            return (
              <div className="compare-drawer-metric" key={metric.key}>
                <span className="compare-drawer-metric-key">{metric.label}</span>
                <span className={["compare-drawer-metric-value", metricTone(metric.key, value)].filter(Boolean).join(" ")}>
                  {metric.format(value)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function previewForCompareItem(item: CompareDrawerItem, fallbacks: string[]): CreativeRenderPayload {
  if (item.preview) {
    return {
      ...item.preview,
      image_url: item.preview.image_url ?? fallbacks[0] ?? null,
      poster_url: item.preview.poster_url ?? fallbacks[1] ?? fallbacks[0] ?? null,
    };
  }

  return {
    render_mode: fallbacks.length > 0 ? "image" : "unavailable",
    image_url: fallbacks[0] ?? null,
    video_url: null,
    poster_url: fallbacks[1] ?? fallbacks[0] ?? null,
    source: fallbacks.length > 0 ? "compare_media" : null,
    is_catalog: false,
  };
}

function compareMetaLine(item: CompareDrawerItem) {
  return [item.name, item.brand].filter(Boolean).join(" · ");
}

function compareMediaFallbacks(item: CompareDrawerItem) {
  return [
    item.cardPreviewUrl,
    item.mediaPreviewUrl,
    item.imageUrl,
    item.preview?.image_url,
    item.preview?.poster_url,
    item.previewUrl,
    item.cachedThumbnailUrl,
    item.thumbnailUrl,
    item.tableThumbnailUrl,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function decisionLabelText(label: DecisionLabel) {
  const textByLabel: Partial<Record<DecisionLabel, string>> = {
    scale: "Scale",
    cut: "Cut",
    refresh: "Fresh test",
    keep: "Keep",
    test_more: "Test more",
    diagnose: "Diagnose",
    below_breakeven: "Below breakeven",
    fatigue: "Fatigue",
    rebuild: "Rebuild",
    switch: "Switch",
    tune: "Tune",
    swap: "Swap",
    review_placements: "Review placements",
    review_adsets: "Review ad sets",
    out_of_scope: "Out of scope",
  };
  return textByLabel[label] ?? label.replace(/_/g, " ");
}

function chipTone(label: DecisionLabel) {
  if (label === "cut" || label === "below_breakeven" || label === "fatigue") return "danger";
  if (label === "scale" || label === "keep") return "action";
  if (label === "refresh" || label === "test_more") return "test";
  return "neutral";
}

function metricTone(key: string, value: number) {
  if (key === "roas") return value >= 1.5 ? "good" : value > 0 && value < 1 ? "warn" : "";
  if (key === "frequency") return value >= 4 ? "warn" : "";
  if (key === "ctr") return value >= 1.5 ? "good" : value > 0 && value < 0.75 ? "warn" : "";
  if (key === "cpa") return value > 0 && value >= 45 ? "warn" : "";
  return "";
}

function bestCardIndex(cards: CompareDrawerItem[]) {
  if (cards.length === 0) return -1;
  let bestIndex = 0;
  let bestRoas = Number.NEGATIVE_INFINITY;
  cards.forEach((card, index) => {
    const roas = card.roas ?? Number.NEGATIVE_INFINITY;
    if (roas > bestRoas) {
      bestRoas = roas;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function calculateOutliers(
  cards: CompareDrawerItem[],
  metrics: CompareDrawerMetric[],
): Record<string, boolean[]> {
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = cards.map((card) => metric.getValue(card));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min || 1;
      const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      return [metric.key, values.map((value) => Math.abs(value - median) / range > 0.5)];
    }),
  );
}
