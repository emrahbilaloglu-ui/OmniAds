"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type {
  CreativeAssetMetricId,
  CreativeStudioAssetRow,
  CreativeStudioAssetsModel,
  CreativeStudioBreakdown,
  CreativeStudioCopiesModel,
  CreativeStudioDataState,
  CreativeStudioExactProps,
  CreativeStudioInboxCard,
  CreativeStudioInboxColumn,
  CreativeStudioLandingModel,
  CreativeStudioReadItem,
  CreativeStudioTabId,
  CreativeStudioTone,
} from "./creative-studio-exact-types";
import styles from "./CreativeStudioExact.module.css";

const EM_DASH = "—";
const PERSISTENCE_VERSION = 1;

type MetricSetId = "performance" | "engagement" | "funnel" | "custom";
type AssetSortId = "spend" | "roas" | "thumbstop";
type MetricCategory = "Volume" | "Efficiency" | "Engagement" | "Funnel";
type MetricDirection = -1 | 0 | 1;

interface MetricDefinition {
  id: CreativeAssetMetricId;
  label: string;
  category: MetricCategory;
  direction: MetricDirection;
}

const TABS: ReadonlyArray<{ id: CreativeStudioTabId; label: string }> = [
  { id: "assets", label: "Assets" },
  { id: "copies", label: "Copies" },
  { id: "landing-pages", label: "Landing Pages" },
  { id: "inbox", label: "Inbox" },
  { id: "audiences", label: "Audiences" },
];

const METRICS: readonly MetricDefinition[] = [
  { id: "spend", label: "Spend", category: "Volume", direction: 0 },
  { id: "impressions", label: "Impressions", category: "Volume", direction: 0 },
  { id: "clicks", label: "Clicks", category: "Volume", direction: 0 },
  { id: "purchases", label: "Purchases", category: "Volume", direction: 0 },
  { id: "roas", label: "ROAS", category: "Efficiency", direction: 1 },
  { id: "cpa", label: "CPA", category: "Efficiency", direction: -1 },
  { id: "cpm", label: "CPM", category: "Efficiency", direction: -1 },
  { id: "aov", label: "AOV", category: "Efficiency", direction: 1 },
  { id: "ctr", label: "CTR", category: "Engagement", direction: 1 },
  { id: "thumbstop", label: "Thumbstop", category: "Engagement", direction: 1 },
  { id: "hold", label: "Hold 15s", category: "Engagement", direction: 1 },
  { id: "frequency", label: "Frequency", category: "Engagement", direction: -1 },
  { id: "atcRate", label: "ATC rate", category: "Funnel", direction: 1 },
  { id: "cvr", label: "CVR", category: "Funnel", direction: 1 },
];

const METRIC_PRESETS: Record<Exclude<MetricSetId, "custom">, readonly CreativeAssetMetricId[]> = {
  performance: ["spend", "roas", "cpa", "aov", "purchases"],
  engagement: ["ctr", "thumbstop", "hold", "frequency", "cpm"],
  funnel: ["clicks", "atcRate", "cvr", "purchases"],
};

const DEFAULT_CUSTOM_METRICS: readonly CreativeAssetMetricId[] = [
  "spend",
  "roas",
  "ctr",
  "thumbstop",
  "frequency",
];

const METRIC_CATEGORIES: readonly MetricCategory[] = [
  "Volume",
  "Efficiency",
  "Engagement",
  "Funnel",
];

const TONE_CLASSES: Record<CreativeStudioTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

const INBOX_COLUMNS: ReadonlyArray<{
  id: CreativeStudioInboxColumn["id"];
  name: string;
  tone: CreativeStudioTone;
}> = [
  { id: "requested", name: "Requested", tone: "warning" },
  { id: "in-production", name: "In production", tone: "info" },
  { id: "delivered", name: "Delivered", tone: "automation" },
  { id: "live", name: "Live", tone: "positive" },
];

const AUDIENCE_BREAKDOWN_SLOTS: ReadonlyArray<{ title: string; subtitle: string }> = [
  { title: "Frequency", subtitle: "exposures / user" },
  { title: "Age", subtitle: "spend share · ROAS" },
  { title: "Gender", subtitle: "spend share · ROAS" },
  { title: "Placement", subtitle: "spend share · ROAS" },
  { title: "Platform", subtitle: "spend share · ROAS" },
];

const AUDIENCE_MATRIX_COLUMN_SLOTS = 4;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function displayText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return EM_DASH;
  return String(value);
}

function formatNumber(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}

function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
  compact = false,
  fractionDigits?: number,
): string {
  if (!isFiniteNumber(value) || !currency) return EM_DASH;
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits:
        compact && Math.abs(value) >= 1_000 ? 1 : (fractionDigits ?? 2),
      minimumFractionDigits:
        compact && Math.abs(value) >= 1_000 ? 1 : (fractionDigits ?? 0),
      notation: compact && Math.abs(value) >= 1_000 ? "compact" : "standard",
    }).format(value);
    return formatted.replace(/K\b/, "k");
  } catch {
    return EM_DASH;
  }
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return `${value.toFixed(digits)}%`;
}

function formatRatio(value: number | null | undefined): string {
  return isFiniteNumber(value) ? value.toFixed(1) : EM_DASH;
}

function formatMetric(row: CreativeStudioAssetRow, metricId: CreativeAssetMetricId): string {
  const value = row.metrics[metricId];
  switch (metricId) {
    case "spend":
      return formatMoney(value, row.currency, true);
    case "cpa":
    case "cpm":
      return formatMoney(value, row.currency, false, 1);
    case "aov":
      return formatMoney(value, row.currency, false, 0);
    case "impressions":
    case "clicks":
      return formatNumber(value);
    case "purchases":
      return isFiniteNumber(value) ? value.toLocaleString("en-US") : EM_DASH;
    case "roas":
      return formatRatio(value);
    case "ctr":
      return formatPercent(value, 2);
    case "frequency":
      return isFiniteNumber(value) ? value.toFixed(1) : EM_DASH;
    case "thumbstop":
    case "hold":
    case "atcRate":
    case "cvr":
      return formatPercent(value, 1);
  }
}

function modelMessage(model: { state: CreativeStudioDataState; message: string | null } | undefined) {
  return displayText(model?.message);
}

function metricDirectionLabel(direction: MetricDirection): string {
  if (direction > 0) return "↑";
  if (direction < 0) return "↓";
  return "";
}

function metricHeader(metric: MetricDefinition): string {
  const direction = metricDirectionLabel(metric.direction);
  return direction ? `${metric.label} ${direction}` : metric.label;
}

function metricHeatClass(
  row: CreativeStudioAssetRow,
  metric: MetricDefinition,
  allRows: readonly CreativeStudioAssetRow[],
): string {
  const value = row.metrics[metric.id];
  if (!isFiniteNumber(value)) return styles.heatMissing;
  if (metric.direction === 0) return styles.heatNeutral;

  const values = allRows
    .map((candidate) => candidate.metrics[metric.id])
    .filter(isFiniteNumber);
  if (values.length === 0) return styles.heatMissing;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  let rank = minimum === maximum ? 0.5 : (value - minimum) / (maximum - minimum);
  if (metric.direction < 0) rank = 1 - rank;
  if (rank <= 0.2) return styles.heatLag;
  if (rank <= 0.4) return styles.heatLow;
  if (rank <= 0.6) return styles.heatMiddle;
  if (rank <= 0.8) return styles.heatGood;
  return styles.heatLead;
}

function roasTone(value: number | null | undefined): CreativeStudioTone {
  if (!isFiniteNumber(value)) return "neutral";
  if (value >= 3.8) return "positive";
  if (value < 2.5) return "negative";
  if (value < 3) return "warning";
  return "neutral";
}

function safeCustomMetrics(value: unknown): CreativeAssetMetricId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_METRICS];
  const selected = new Set(
    value.filter(
      (candidate): candidate is CreativeAssetMetricId =>
        typeof candidate === "string" && METRICS.some((metric) => metric.id === candidate),
    ),
  );
  return METRICS.map((metric) => metric.id).filter((id) => selected.has(id));
}

function safePinnedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((candidate): candidate is string => typeof candidate === "string")),
  );
}

function handleKeyboardActivation(event: KeyboardEvent<HTMLElement>, callback: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  callback();
}

function AssetVisual({
  row,
  compact = false,
}: {
  row: CreativeStudioAssetRow;
  compact?: boolean;
}) {
  const className = compact ? styles.assetThumb : styles.boardPreview;
  if (row.imageUrl) {
    return <img alt="" className={className} draggable={false} src={row.imageUrl} />;
  }
  return <span aria-hidden="true" className={`${className} ${styles.assetPlaceholder}`} />;
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td className={styles.emptyTableCell} colSpan={colSpan}>
        {message}
      </td>
    </tr>
  );
}

function TabCount({
  active,
  count,
}: {
  active: boolean;
  count: number | null | undefined;
}) {
  if (count === 0 || count === undefined) return null;
  return (
    <span className={active ? styles.tabCountActive : styles.tabCount}>
      {count === null ? EM_DASH : count}
    </span>
  );
}

function CreativeStudioTabs({
  activeTab,
  counts,
  tabHrefs,
}: Pick<CreativeStudioExactProps, "activeTab" | "counts" | "tabHrefs">) {
  return (
    <nav aria-label="Creative Studio views" className={styles.tabs}>
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <a
            aria-current={active ? "page" : undefined}
            className={active ? styles.tabActive : styles.tab}
            data-creative-studio-tab={tab.id}
            href={tabHrefs[tab.id]}
            key={tab.id}
          >
            {tab.label}
            <TabCount active={active} count={counts[tab.id]} />
          </a>
        );
      })}
    </nav>
  );
}

function AssetsView({ model }: { model: CreativeStudioAssetsModel | undefined }) {
  const rows = model?.rows ?? [];
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [metricSet, setMetricSet] = useState<MetricSetId>("performance");
  const [customMetrics, setCustomMetrics] = useState<CreativeAssetMetricId[]>([
    ...DEFAULT_CUSTOM_METRICS,
  ]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortKey, setSortKey] = useState<AssetSortId>("spend");
  const [query, setQuery] = useState("");
  const [hydratedPersistenceKey, setHydratedPersistenceKey] = useState<string | null>(null);
  const persistenceKey = model?.persistenceKey?.trim() || null;

  useEffect(() => {
    if (!persistenceKey || typeof window === "undefined") {
      setPinnedIds([]);
      setCustomMetrics([...DEFAULT_CUSTOM_METRICS]);
      setHydratedPersistenceKey(null);
      return;
    }

    let nextPinnedIds: string[] = [];
    let nextCustomMetrics = [...DEFAULT_CUSTOM_METRICS];
    try {
      const raw = window.localStorage.getItem(persistenceKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          version?: unknown;
          pinnedIds?: unknown;
          customMetrics?: unknown;
        };
        if (parsed.version === PERSISTENCE_VERSION) {
          nextPinnedIds = safePinnedIds(parsed.pinnedIds);
          nextCustomMetrics = safeCustomMetrics(parsed.customMetrics);
        }
      }
    } catch {
      nextPinnedIds = [];
      nextCustomMetrics = [...DEFAULT_CUSTOM_METRICS];
    }
    setPinnedIds(nextPinnedIds);
    setCustomMetrics(nextCustomMetrics);
    setHydratedPersistenceKey(persistenceKey);
  }, [persistenceKey]);

  useEffect(() => {
    model?.onPinnedIdsChange?.([...pinnedIds]);
  }, [model?.onPinnedIdsChange, pinnedIds]);

  useEffect(() => {
    if (
      !persistenceKey ||
      hydratedPersistenceKey !== persistenceKey ||
      typeof window === "undefined"
    ) {
      return;
    }
    try {
      window.localStorage.setItem(
        persistenceKey,
        JSON.stringify({
          version: PERSISTENCE_VERSION,
          pinnedIds,
          customMetrics,
        }),
      );
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. The
      // Studio remains usable for the current session and never fabricates a save.
    }
  }, [customMetrics, hydratedPersistenceKey, persistenceKey, pinnedIds]);

  const selectedMetricIds =
    metricSet === "custom" ? customMetrics : METRIC_PRESETS[metricSet];
  const selectedMetricSet = new Set<CreativeAssetMetricId>(selectedMetricIds);
  const visibleMetrics = METRICS.filter((metric) => selectedMetricSet.has(metric.id));

  const tableRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter((row) => !normalizedQuery || row.name.toLowerCase().includes(normalizedQuery))
      .slice()
      .sort((left, right) => {
        const leftValue = left.metrics[sortKey];
        const rightValue = right.metrics[sortKey];
        const leftSort = isFiniteNumber(leftValue) ? leftValue : Number.NEGATIVE_INFINITY;
        const rightSort = isFiniteNumber(rightValue) ? rightValue : Number.NEGATIVE_INFINITY;
        return rightSort - leftSort;
      });
  }, [query, rows, sortKey]);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const pinnedRows = pinnedIds
    .map((id) => rowById.get(id))
    .filter((row): row is CreativeStudioAssetRow => Boolean(row));

  const togglePin = (rowId: string) => {
    setPinnedIds((current) =>
      current.includes(rowId)
        ? current.filter((candidate) => candidate !== rowId)
        : [...current, rowId],
    );
  };

  const toggleMetric = (metricId: CreativeAssetMetricId) => {
    const nextSet = new Set(selectedMetricIds);
    if (nextSet.has(metricId)) nextSet.delete(metricId);
    else nextSet.add(metricId);
    setCustomMetrics(METRICS.map((metric) => metric.id).filter((id) => nextSet.has(id)));
    setMetricSet("custom");
  };

  return (
    <>
      <div className={styles.assetsToolbar} data-creative-studio-exact-section="assets">
        <span className={styles.mutedMono}>visual assets · heat table + comparison board</span>
        <span className={styles.flexSpacer} />
        <select
          aria-label="Sort creatives"
          className={styles.compactSelect}
          onChange={(event) => setSortKey(event.target.value as AssetSortId)}
          value={sortKey}
        >
          <option value="spend">Sort: Spend</option>
          <option value="roas">Sort: ROAS</option>
          <option value="thumbstop">Sort: Thumbstop</option>
        </select>
        <input
          aria-label="Search creatives"
          className={styles.searchInput}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search creatives…"
          type="search"
          value={query}
        />
      </div>

      <section className={styles.comparisonBoard}>
        <div className={styles.sectionHeadingRow}>
          <h2>Comparison board</h2>
          <span className={styles.mutedMono}>
            {pinnedRows.length} pinned · your working set, never auto-fills
          </span>
          <span className={styles.flexSpacer} />
          {pinnedRows.length > 0 ? (
            <button className={styles.clearButton} onClick={() => setPinnedIds([])} type="button">
              Clear board
            </button>
          ) : null}
        </div>

        {pinnedRows.length === 0 ? (
          <div className={styles.boardEmpty}>
            <div>
              <p className={styles.boardEmptyTitle}>Board is empty</p>
              <p className={styles.boardEmptyCopy}>
                Tick creatives in the table below to pin them here as cards for side-by-side review.
              </p>
            </div>
          </div>
        ) : (
          <div className={styles.boardGrid}>
            {pinnedRows.map((row) => (
              <article className={styles.boardCard} data-pinned-asset={row.id} key={row.id}>
                <button
                  aria-label={`Unpin ${row.name}`}
                  className={styles.unpinButton}
                  onClick={() => togglePin(row.id)}
                  type="button"
                >
                  ✕
                </button>
                <div className={styles.boardVisual}>
                  <AssetVisual row={row} />
                  <span className={styles.kindBadge}>{displayText(row.kind)}</span>
                  <span className={`${styles.statusBadge} ${TONE_CLASSES[row.statusTone]}`}>
                    {displayText(row.status)}
                  </span>
                </div>
                <div className={styles.boardCardBody}>
                  <p className={styles.boardCardName}>{displayText(row.name)}</p>
                  <div className={styles.boardMetrics}>
                    <BoardMetric label="Spend" value={formatMetric(row, "spend")} />
                    <BoardMetric
                      label="ROAS"
                      tone={roasTone(row.metrics.roas)}
                      value={formatMetric(row, "roas")}
                    />
                    <BoardMetric label="Thumbstop" value={formatMetric(row, "thumbstop")} />
                    <BoardMetric label="Hold" value={formatMetric(row, "hold")} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <article className={styles.creativesTableArticle}>
        <div className={styles.tableControlRow}>
          <h2>All creatives</h2>
          <span className={styles.mutedMono}>
            {model?.syncedCount === null || model?.syncedCount === undefined
              ? EM_DASH
              : model.syncedCount} synced · Meta
          </span>
          <span className={styles.flexSpacer} />
          <span className={styles.columnsLabel}>Columns</span>
          {(
            [
              ["performance", "Performance"],
              ["engagement", "Engagement"],
              ["funnel", "Funnel"],
              ["custom", metricSet === "custom" ? `Custom · ${customMetrics.length}` : "Custom"],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-pressed={metricSet === id}
              className={metricSet === id ? styles.metricSetActive : styles.metricSet}
              key={id}
              onClick={() => setMetricSet(id)}
              type="button"
            >
              {label}
            </button>
          ))}
          <button
            aria-expanded={pickerOpen}
            className={pickerOpen ? styles.metricPickerButtonOpen : styles.metricPickerButton}
            onClick={() => setPickerOpen((open) => !open)}
            type="button"
          >
            + Edit metrics
          </button>

          {pickerOpen ? (
            <div className={styles.metricPicker} data-creative-studio-metric-picker>
              <div className={styles.metricPickerHeader}>
                <p>Table metrics</p>
                <span>edits save as the Custom set</span>
                <button
                  aria-label="Close metric picker"
                  className={styles.metricPickerClose}
                  onClick={() => setPickerOpen(false)}
                  type="button"
                >
                  ✕
                </button>
              </div>
              <div className={styles.metricPickerGrid}>
                {METRIC_CATEGORIES.map((category) => (
                  <div key={category}>
                    <p className={styles.metricCategory}>{category}</p>
                    {METRICS.filter((metric) => metric.category === category).map((metric) => {
                      const selected = selectedMetricSet.has(metric.id);
                      return (
                        <button
                          aria-pressed={selected}
                          className={styles.metricPickerOption}
                          key={metric.id}
                          onClick={() => toggleMetric(metric.id)}
                          type="button"
                        >
                          <span
                            aria-hidden="true"
                            className={selected ? styles.metricCheckboxSelected : styles.metricCheckbox}
                          >
                            ✓
                          </span>
                          <span>{metric.label}</span>
                          <span className={styles.metricDirection}>
                            {metricDirectionLabel(metric.direction)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.heatLegend}>
          <span>cell color = rank across these creatives on that metric</span>
          <span aria-hidden="true" className={styles.heatRamp} />
          <span>lags → leads · ↓ = lower is better · volume columns stay neutral</span>
        </div>

        <div className={styles.tableScroller}>
          <table className={styles.assetTable}>
            <thead>
              <tr>
                <th className={styles.selectionColumn} />
                <th>Creative</th>
                <th>Status</th>
                <th>Marketing angle</th>
                {visibleMetrics.map((metric) => (
                  <th className={styles.numericHeader} key={metric.id}>
                    {metricHeader(metric)}
                  </th>
                ))}
                <th className={styles.tableTail} />
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 ? (
                <EmptyRow colSpan={visibleMetrics.length + 5} message={modelMessage(model)} />
              ) : (
                tableRows.map((row) => {
                  const pinned = pinnedIds.includes(row.id);
                  return (
                    <tr
                      aria-checked={pinned}
                      className={pinned ? styles.assetRowPinned : styles.assetRow}
                      data-creative-studio-asset-row={row.id}
                      key={row.id}
                      onClick={() => togglePin(row.id)}
                      onKeyDown={(event) => handleKeyboardActivation(event, () => togglePin(row.id))}
                      role="checkbox"
                      tabIndex={0}
                    >
                      <td className={styles.selectionCell}>
                        <span
                          aria-hidden="true"
                          className={pinned ? styles.rowCheckboxSelected : styles.rowCheckbox}
                        >
                          ✓
                        </span>
                      </td>
                      <td>
                        <div className={styles.creativeIdentity}>
                          <AssetVisual compact row={row} />
                          <span className={styles.creativeIdentityText}>
                            <span>{displayText(row.name)}</span>
                            <span>{displayText(row.kind)}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`${styles.tableStatus} ${TONE_CLASSES[row.statusTone]}`}>
                          {displayText(row.status)}
                        </span>
                      </td>
                      <td className={styles.angleCell}>{displayText(row.marketingAngle)}</td>
                      {visibleMetrics.map((metric) => (
                        <td className={styles.metricCell} key={metric.id}>
                          <span className={metricHeatClass(row, metric, rows)}>
                            {formatMetric(row, metric.id)}
                          </span>
                        </td>
                      ))}
                      <td className={styles.tableTail} />
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </article>

      <p className={styles.closingNote}>
        Thumbnails render from synced ad assets — drop real creative exports to replace placeholders.
        Board picks and the Custom column set persist per operator.
      </p>
    </>
  );
}

function BoardMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: CreativeStudioTone;
  value: string;
}) {
  return (
    <span className={styles.boardMetric}>
      <span>{label}</span>
      <span className={TONE_CLASSES[tone]}>{value}</span>
    </span>
  );
}

function CopiesView({ model }: { model: CreativeStudioCopiesModel | undefined }) {
  const angles = model?.angles ?? [];
  const rows = model?.rows ?? [];
  const angleSlots = Array.from({ length: 4 }, (_, index) => angles[index] ?? null);
  return (
    <>
      <div className={styles.angleGrid} data-creative-studio-exact-section="copies">
        {angleSlots.map((angle, index) =>
          angle ? (
            <article
              className={`${styles.angleCard} ${TONE_CLASSES[angle.tone]}`}
              data-copy-angle={angle.id}
              key={angle.id}
            >
              <div className={styles.angleCardHeader}>
                <p>{displayText(angle.name)}</p>
                <span>{isFiniteNumber(angle.lines) ? angle.lines : EM_DASH} lines</span>
              </div>
              <div className={styles.angleMetrics}>
                <SummaryMetric label="Spend share" value={formatPercent(angle.spendShare, 0)} />
                <SummaryMetric label="ROAS" tone={roasTone(angle.roas)} value={formatRatio(angle.roas)} />
                <SummaryMetric label="CTR" value={formatPercent(angle.ctr, 2)} />
              </div>
              <p className={styles.angleBestLine}>
                Best line: <strong>“{displayText(angle.bestLine)}”</strong>
              </p>
              <p className={styles.angleUsage}>{displayText(angle.usage)}</p>
            </article>
          ) : (
            <article
              className={`${styles.angleCard} ${TONE_CLASSES.neutral}`}
              data-copy-angle={`empty-${index + 1}`}
              key={`empty-${index + 1}`}
            >
              <div className={styles.angleCardHeader}>
                <p>{EM_DASH}</p>
                <span>{EM_DASH} lines</span>
              </div>
              <div className={styles.angleMetrics}>
                <SummaryMetric label="Spend share" value={EM_DASH} />
                <SummaryMetric label="ROAS" value={EM_DASH} />
                <SummaryMetric label="CTR" value={EM_DASH} />
              </div>
              <p className={styles.angleBestLine}>
                Best line: <strong>“{EM_DASH}”</strong>
              </p>
              <p className={styles.angleUsage}>{EM_DASH}</p>
            </article>
          ),
        )}
      </div>

      <div className={styles.angleCoverage}>
        <span>Angle coverage</span>
        <p>{displayText(model?.angleCoverage)}</p>
        {(model?.angleGaps ?? []).map((gap) => (
          <span className={styles.angleGap} key={gap}>
            {gap}
          </span>
        ))}
      </div>

      <article className={styles.borderedTableArticle}>
        <div className={styles.articleHeader}>
          <h2>Copy performance</h2>
          <span>aggregated per exact string · 28d · click a line for alternates</span>
          <span className={styles.insightPill}>{displayText(model?.insight)}</span>
        </div>
        <div className={styles.tableScroller}>
          <table className={styles.copyTable}>
            <thead>
              <tr>
                <th>Copy</th>
                <th>Angle</th>
                <th className={styles.numericHeader}>Ads</th>
                <th className={styles.numericHeader}>Spend</th>
                <th className={styles.numericHeader}>See more</th>
                <th className={styles.numericHeader}>CTR</th>
                <th className={styles.numericHeader}>Engage</th>
                <th className={styles.numericHeader}>CVR</th>
                <th className={styles.numericHeader}>ROAS</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={9} message={modelMessage(model)} />
              ) : (
                rows.map((row) => {
                  const open = model?.onOpenRow ? () => model.onOpenRow?.(row.id) : undefined;
                  return (
                    <tr
                      className={open ? styles.clickableTableRow : undefined}
                      data-copy-row={row.id}
                      key={row.id}
                      onClick={open}
                      onKeyDown={open ? (event) => handleKeyboardActivation(event, open) : undefined}
                      tabIndex={open ? 0 : undefined}
                    >
                      <td className={styles.copyCell}>
                        <span>“{displayText(row.text)}”</span>
                        <span>{displayText(row.kind)} · {displayText(row.chars)} chars</span>
                      </td>
                      <td>
                        <span className={`${styles.anglePill} ${TONE_CLASSES[row.tone]}`}>
                          {displayText(row.angle)}
                        </span>
                      </td>
                      <td className={styles.numericCell}>{displayText(row.ads)}</td>
                      <td className={styles.numericCell}>{formatMoney(row.spend, row.currency, true)}</td>
                      <td className={styles.numericStrong}>{formatPercent(row.seeMore, 1)}</td>
                      <td className={styles.numericCell}>{formatPercent(row.ctr, 2)}</td>
                      <td className={styles.numericCell}>{formatPercent(row.engagement, 1)}</td>
                      <td className={styles.numericCell}>{formatPercent(row.cvr, 1)}</td>
                      <td className={styles.numericCell}>
                        <span className={`${styles.roasPill} ${TONE_CLASSES[roasTone(row.roas)]}`}>
                          {formatRatio(row.roas)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </article>

      <p className={styles.closingNote}>
        See more = expansions of truncated primaries · Engage = reactions + comments + shares per
        impression. Angles are auto-tagged and editable per line; click any line for angle-shifted
        alternates.
      </p>
    </>
  );
}

function SummaryMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: CreativeStudioTone;
  value: string;
}) {
  return (
    <span className={styles.summaryMetric}>
      <span>{label}</span>
      <span className={TONE_CLASSES[tone]}>{value}</span>
    </span>
  );
}

function ReadItems({
  items,
  message,
  showEstimate,
}: {
  items: readonly CreativeStudioReadItem[];
  message: string;
  showEstimate?: boolean;
}) {
  if (items.length === 0) return <div className={styles.readEmpty}>{message}</div>;
  return (
    <div className={styles.readItems}>
      {items.map((item) => (
        <div className={styles.readItem} key={item.id}>
          {showEstimate ? null : (
            <span className={`${styles.readKind} ${TONE_CLASSES[item.tone]}`}>
              {displayText(item.kind)}
            </span>
          )}
          <p>{displayText(item.text)}</p>
          {showEstimate ? (
            <span className={styles.testEstimate}>{displayText(item.estimate)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function LandingPagesView({ model }: { model: CreativeStudioLandingModel | undefined }) {
  const rows = model?.rows ?? [];
  const message = modelMessage(model);
  return (
    <>
      <div className={styles.landingGrid} data-creative-studio-exact-section="landing-pages">
        <article className={styles.borderedTableArticle}>
          <div className={styles.articleHeader}>
            <h2>Destinations behind ads</h2>
            <span>Meta-reported only — link clicks + pixel LP views · no analytics join · 28d</span>
          </div>
          <div className={styles.tableScroller}>
            <table className={styles.landingTable}>
              <thead>
                <tr>
                  <th>Destination</th>
                  <th className={styles.numericHeader}>Ads</th>
                  <th className={styles.numericHeader}>Spend</th>
                  <th className={styles.numericHeader}>Link clicks</th>
                  <th className={styles.numericHeader}>LP view rate</th>
                  <th className={styles.numericHeader}>CVR</th>
                  <th className={styles.numericHeader}>CPA</th>
                  <th className={styles.numericHeader}>ROAS</th>
                  <th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <EmptyRow colSpan={9} message={message} />
                ) : (
                  rows.map((row) => (
                    <tr data-landing-row={row.id} key={row.id}>
                      <td className={styles.destinationCell}>{displayText(row.destination)}</td>
                      <td className={styles.numericCell}>{displayText(row.ads)}</td>
                      <td className={styles.numericCell}>{formatMoney(row.spend, row.currency, true)}</td>
                      <td className={styles.numericCell}>{formatNumber(row.linkClicks)}</td>
                      <td className={styles.numericStrong}>{formatPercent(row.landingPageViewRate, 0)}</td>
                      <td className={styles.numericStrong}>{formatPercent(row.cvr, 1)}</td>
                      <td className={styles.numericCell}>{formatMoney(row.cpa, row.currency, false, 2)}</td>
                      <td className={styles.numericCell}>
                        <span className={`${styles.roasPill} ${TONE_CLASSES[roasTone(row.roas)]}`}>
                          {formatRatio(row.roas)}
                        </span>
                      </td>
                      <td>
                        <span className={`${styles.signalPill} ${TONE_CLASSES[row.signalTone]}`}>
                          {displayText(row.signal)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>

        <div className={styles.landingReads}>
          <article className={styles.readCard}>
            <h2>What’s missing</h2>
            <p className={styles.readSubtitle}>Gaps the engine sees in the current link map.</p>
            <ReadItems items={model?.gaps ?? []} message={message} />
          </article>
          <article className={styles.readCard}>
            <h2>What to try</h2>
            <p className={styles.readSubtitle}>
              Test ideas from the reads below — each starts as a Launchpad draft.
            </p>
            <ReadItems items={model?.tests ?? []} message={message} showEstimate />
          </article>
        </div>
      </div>

      <article className={styles.historyCard}>
        <div className={styles.historyHeader}>
          <h2>Destination history</h2>
          <span>what changed, what it did — these reads feed the test ideas</span>
        </div>
        <div className={styles.historyRows}>
          {(model?.history ?? []).length === 0 ? (
            <div className={styles.historyEmpty}>{message}</div>
          ) : (
            model?.history.map((item) => (
              <div className={styles.historyRow} key={item.id}>
                <span>{displayText(item.date)}</span>
                <span>{displayText(item.text)}</span>
                <span className={TONE_CLASSES[item.tone]}>{displayText(item.result)}</span>
              </div>
            ))
          )}
        </div>
      </article>
    </>
  );
}

function InboxCard({ card }: { card: CreativeStudioInboxCard }) {
  return (
    <article className={styles.inboxCard} data-inbox-card={card.id}>
      <span className={`${styles.inboxSource} ${TONE_CLASSES[card.sourceTone]}`}>
        {displayText(card.source)}
      </span>
      <p className={styles.inboxCardName}>{displayText(card.name)}</p>
      <p className={styles.inboxCardNote}>{displayText(card.note)}</p>
      <div className={styles.inboxCardFooter}>
        <span className={`${styles.avatar} ${TONE_CLASSES[card.ownerTone]}`}>
          {displayText(card.ownerInitials)}
        </span>
        <span className={styles.inboxDue}>{displayText(card.due)}</span>
        {card.actionLabel ? (
          <button
            className={styles.inboxAction}
            disabled={!card.onAction}
            onClick={card.onAction}
            type="button"
          >
            {card.actionLabel}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function InboxView({ model }: { model: CreativeStudioExactProps["inbox"] }) {
  const sourceColumns = new Map((model?.columns ?? []).map((column) => [column.id, column]));
  const columns = INBOX_COLUMNS.map((definition) => ({
    ...definition,
    cards: sourceColumns.get(definition.id)?.cards ?? [],
  }));
  const allEmpty = columns.every((column) => column.cards.length === 0);

  return (
    <>
      <div className={styles.routingStrip} data-creative-studio-exact-section="inbox">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
        <p>
          Requests route here from <b>Decisions</b> with evidence attached. Delivered files are
          versioned, linked back to the request, and approved assets hand off to Launchpad.
        </p>
      </div>

      <div className={styles.inboxBoard}>
        {columns.map((column, index) => (
          <div className={styles.inboxColumn} data-inbox-column={column.id} key={column.id}>
            <div className={styles.inboxColumnHeader}>
              <span className={`${styles.columnDot} ${TONE_CLASSES[column.tone]}`} />
              <span>{column.name}</span>
              <span>{column.cards.length}</span>
            </div>
            {column.cards.map((card) => (
              <InboxCard card={card} key={card.id} />
            ))}
            {allEmpty && index === 0 ? (
              <p className={styles.inboxEmpty}>{modelMessage(model)}</p>
            ) : null}
          </div>
        ))}
      </div>

      <div className={styles.dropZone}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
        </svg>
        <div>
          <p>Drop new exports here</p>
          <p>Files auto-match to open requests by name · MP4, MOV, PNG, JPG up to 500MB · versions kept</p>
        </div>
        <button disabled={!model?.onBrowseFiles} onClick={model?.onBrowseFiles} type="button">
          Browse files
        </button>
      </div>
    </>
  );
}

function BreakdownCard({ breakdown }: { breakdown: CreativeStudioBreakdown }) {
  return (
    <article className={styles.breakdownCard} data-audience-breakdown={breakdown.id}>
      <div className={styles.breakdownHeader}>
        <p>{displayText(breakdown.title)}</p>
        <span>{displayText(breakdown.subtitle)}</span>
      </div>
      <div className={styles.breakdownRows}>
        {breakdown.rows.length === 0 ? (
          <div className={styles.breakdownEmpty}>{EM_DASH}</div>
        ) : (
          breakdown.rows.map((row) => (
            <div className={styles.breakdownRow} key={row.id}>
              <span>{displayText(row.label)}</span>
              <span className={styles.breakdownTrack}>
                <span
                  className={`${styles.breakdownFill} ${TONE_CLASSES[row.tone]}`}
                  style={
                    {
                      "--share": isFiniteNumber(row.spendShare)
                        ? `${Math.max(0, Math.min(100, row.spendShare))}%`
                        : "0%",
                    } as CSSProperties
                  }
                />
              </span>
              <span>{formatPercent(row.spendShare, 0)}</span>
              <span className={TONE_CLASSES[row.tone]}>{formatRatio(row.roas)}</span>
            </div>
          ))
        )}
      </div>
      <p className={styles.breakdownNote}>{displayText(breakdown.note)}</p>
    </article>
  );
}

function matrixHeatClass(value: number | null): string {
  if (!isFiniteNumber(value)) return styles.heatMissing;
  if (value >= 4.5) return styles.heatLead;
  if (value >= 3.8) return styles.heatGood;
  if (value >= 3) return styles.heatMiddle;
  if (value >= 2.5) return styles.heatLow;
  return styles.heatLag;
}

function AudiencesView({ model }: { model: CreativeStudioExactProps["audiences"] }) {
  const summaries = model?.summaries ?? [];
  const breakdowns = model?.breakdowns ?? [];
  const matrixRows = model?.matrixRows ?? [];
  const servedMatrixColumns = model?.matrixColumns ?? [];
  const matrixColumns =
    servedMatrixColumns.length > 0
      ? servedMatrixColumns
      : Array.from({ length: AUDIENCE_MATRIX_COLUMN_SLOTS }, () => EM_DASH);
  const message = modelMessage(model);
  const summarySlots = Array.from({ length: 4 }, (_, index) => summaries[index] ?? null);
  const breakdownSlots = AUDIENCE_BREAKDOWN_SLOTS.map((slot, index) => {
    const served = breakdowns[index];
    return {
      id: served?.id ?? `empty-${slot.title.toLowerCase()}`,
      title: slot.title,
      subtitle: served?.subtitle || slot.subtitle,
      note: served?.note ?? null,
      rows: served?.rows ?? [],
    } satisfies CreativeStudioBreakdown;
  });

  return (
    <>
      <div className={styles.audienceSummaryGrid} data-creative-studio-exact-section="audiences">
        {summarySlots.map((summary, index) =>
          summary ? (
            <article className={styles.audienceSummary} data-audience-summary={summary.id} key={summary.id}>
              <div className={styles.audienceSummaryHeader}>
                <p>{displayText(summary.name)}</p>
                <span className={`${styles.tableStatus} ${TONE_CLASSES[summary.tone]}`}>
                  {displayText(summary.status)}
                </span>
              </div>
              <div className={styles.audienceMetrics}>
                <SummaryMetric label="Spend · 28d" value={formatMoney(summary.spend, summary.currency, true)} />
                <SummaryMetric label="ROAS" tone={roasTone(summary.roas)} value={formatRatio(summary.roas)} />
                <SummaryMetric label="Freq" value={formatRatio(summary.frequency)} />
              </div>
              <p className={styles.audienceNote}>{displayText(summary.note)}</p>
            </article>
          ) : (
            <article
              className={styles.audienceSummary}
              data-audience-summary={`empty-${index + 1}`}
              key={`empty-${index + 1}`}
            >
              <div className={styles.audienceSummaryHeader}>
                <p>{EM_DASH}</p>
                <span className={`${styles.tableStatus} ${TONE_CLASSES.neutral}`}>{EM_DASH}</span>
              </div>
              <div className={styles.audienceMetrics}>
                <SummaryMetric label="Spend · 28d" value={EM_DASH} />
                <SummaryMetric label="ROAS" value={EM_DASH} />
                <SummaryMetric label="Freq" value={EM_DASH} />
              </div>
              <p className={styles.audienceNote}>{EM_DASH}</p>
            </article>
          ),
        )}
      </div>

      <div className={styles.audienceSectionHeading}>
        <h2>Breakdowns &amp; frequency</h2>
        <span>account-wide · 28d · bar = spend share · right value = ROAS</span>
      </div>
      <div className={styles.breakdownGrid}>
        {breakdownSlots.map((breakdown) => (
          <BreakdownCard breakdown={breakdown} key={breakdown.id} />
        ))}
      </div>

      <article className={styles.borderedTableArticle}>
        <div className={styles.articleHeader}>
          <h2>Creative × audience matrix</h2>
          <span>cell = ROAS in that pairing · 28d · blank = not running</span>
          <span aria-hidden="true" className={`${styles.heatRamp} ${styles.matrixRamp}`} />
        </div>
        <div className={styles.tableScroller}>
          <table className={styles.matrixTable}>
            <thead>
              <tr>
                <th>Creative</th>
                {matrixColumns.map((column) => (
                  <th className={styles.numericHeader} key={column}>
                    {displayText(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrixRows.length === 0 ? (
                <EmptyRow colSpan={Math.max(1, matrixColumns.length + 1)} message={message} />
              ) : (
                matrixRows.map((row) => (
                  <tr data-audience-matrix-row={row.id} key={row.id}>
                    <td>
                      <div className={styles.matrixIdentity}>
                        {row.imageUrl ? (
                          <img alt="" draggable={false} src={row.imageUrl} />
                        ) : (
                          <span aria-hidden="true" className={styles.matrixPlaceholder} />
                        )}
                        <span>{displayText(row.name)}</span>
                      </div>
                    </td>
                    {matrixColumns.map((column, index) => {
                      const value = row.values[index] ?? null;
                      return (
                        <td className={styles.metricCell} key={`${row.id}:${column}`}>
                          <span className={matrixHeatClass(value)}>{formatRatio(value)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
      <p className={styles.closingNote}>{message}</p>
    </>
  );
}

export function CreativeStudioExact({
  activeTab,
  tabHrefs,
  counts,
  onExport,
  onShare,
  assets,
  copies,
  landingPages,
  inbox,
  audiences,
}: CreativeStudioExactProps) {
  return (
    <section
      className={styles.root}
      data-creative-studio-exact="true"
      data-screen-label="Creative Studio"
    >
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>Meta · Analysis-first — writes stay in Launchpad</p>
          <h1>Creative Studio</h1>
        </div>
        <div className={styles.headerActions}>
          <button disabled={!onExport} onClick={onExport} type="button">
            Export CSV
          </button>
          <button disabled={!onShare} onClick={onShare} type="button">
            Share with client
          </button>
        </div>
      </header>

      <CreativeStudioTabs activeTab={activeTab} counts={counts} tabHrefs={tabHrefs} />

      {activeTab === "assets" ? <AssetsView model={assets} /> : null}
      {activeTab === "copies" ? <CopiesView model={copies} /> : null}
      {activeTab === "landing-pages" ? <LandingPagesView model={landingPages} /> : null}
      {activeTab === "inbox" ? <InboxView model={inbox} /> : null}
      {activeTab === "audiences" ? <AudiencesView model={audiences} /> : null}
    </section>
  );
}

export default CreativeStudioExact;
