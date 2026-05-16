"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel } from "@/components/common/briefing/types";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";
import {
  CustomizeKpisModal,
  DateRangePicker,
  KpiSummaryTiles,
  PresetBar,
  ShareViewModal,
  computeRangeFromPreset,
  type AssetLibraryPreset,
  type DateRangeValue,
  type KpiCatalogEntry,
  type KpiSummaryTile,
  type ShareViewState,
} from "@/components/common/briefing";

type AssetLibraryStatusFilter = "all" | "active" | "closed_30d";
type AssetLibraryFormatFilter = "image" | "video" | "catalog" | "carousel";
type AssetLibraryBadgeFilter = "below_breakeven" | "fatigue";
type AssetLibrarySort = "spend_desc" | "roas_desc" | "roas_asc" | "name_asc" | "launch_desc";
type LabelFilterKey = "all" | "main" | "test" | "mixed";

type AssetLibraryRow = MetaCreativeRow & {
  engineLabel?: DecisionLabel | string | null;
  decisionLabel?: DecisionLabel | string | null;
  briefingLabel?: DecisionLabel | string | null;
  engineBadges?: string[] | null;
  badges?: string[] | null;
};

interface AssetLibraryFilters {
  status: AssetLibraryStatusFilter;
  formats: AssetLibraryFormatFilter[];
  labels: DecisionLabel[];
  badges: AssetLibraryBadgeFilter[];
  campaignLabel: LabelFilterKey;
  search: string;
  sort: AssetLibrarySort;
}

interface AssetLibrarySectionProps {
  rows: MetaCreativeRow[];
  emptyMessage?: string | null;
  creativeHistoryById?: Map<string, CreativeHistoricalWindows>;
  defaultCurrency: string | null;
  selectedMetricIds: string[];
  onSelectedMetricIdsChange: (next: string[]) => void;
  selectedRowIds: string[];
  highlightedRowId?: string | null;
  onToggleRow: (rowId: string) => void;
  onToggleAll: () => void;
  onOpenRow: (rowId: string) => void;
  onSortedRowsChange?: (rows: MetaCreativeRow[]) => void;
  dateRange?: DateRangeValue;
  onDateRangeChange?: (next: DateRangeValue) => void;
  isFetching?: boolean;
}

const LABEL_FILTERS: ReadonlyArray<{ key: LabelFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "main", label: "Main" },
  { key: "test", label: "Test" },
  { key: "mixed", label: "Mixed" },
];

const DEFAULT_FILTERS: AssetLibraryFilters = {
  status: "all",
  formats: [],
  labels: [],
  badges: [],
  campaignLabel: "all",
  search: "",
  sort: "spend_desc",
};

const PRESETS: ReadonlyArray<AssetLibraryPreset & { metrics: string[] }> = [
  {
    key: "facebook_ecom",
    label: "Facebook Ecommerce",
    description:
      "Buyer view — spend, ROAS, CPA, frequency. Works on existing endpoints today.",
    metricsCount: 6,
    metricChips: ["Spend", "ROAS", "CPA", "Freq", "CTR", "Purch"],
    metrics: ["spend", "roas", "cpa", "frequency", "ctr", "purchases"],
  },
  {
    key: "video",
    label: "Video",
    description: "Buyer + video efficiency framing.",
    metricsCount: 6,
    metricChips: ["Spend", "ROAS", "Thumbstop", "Hold", "VTR", "CPM"],
    metrics: ["spend", "roas", "thumbstop", "videoHold", "vtr", "cpm"],
  },
  {
    key: "saas",
    label: "SaaS",
    description: "Lead/sub efficiency framing for SaaS accounts.",
    metricsCount: 5,
    metricChips: ["Spend", "CTR", "Leads", "CPL", "CPM"],
    metrics: ["spend", "ctr", "leads", "cpl", "cpm"],
  },
  {
    key: "creative_teams",
    label: "Creative teams",
    description: "0–100 scores per concept · Hook / CTA / Offer / Click / Watch.",
    metricsCount: 6,
    metricChips: ["Hook", "CTA", "Offer", "Click", "Watch", "Gap"],
    metrics: ["hookScore", "ctaScore", "offerScore", "clickScore", "watchScore", "gap"],
    unavailable: true,
    unavailableReason:
      "Backend-dependent — Creative scoring pipeline ships separately.",
  },
];

const KPI_CATALOG: ReadonlyArray<KpiCatalogEntry> = [
  { key: "spend", label: "Spend", group: "Performance", description: "Total spend for the selected window." },
  { key: "roas", label: "ROAS", group: "Performance", description: "Return on ad spend. Compared against account anchor." },
  { key: "cpa", label: "CPA", group: "Performance", description: "Cost per acquisition." },
  { key: "purchases", label: "Purchases", group: "Performance", description: "Total purchases in the window." },
  { key: "frequency", label: "Frequency", group: "Delivery", description: "Average impressions per reached user." },
  { key: "ctr", label: "CTR", group: "Engagement", description: "Click-through rate." },
  { key: "cpm", label: "CPM", group: "Delivery", description: "Cost per thousand impressions." },
  { key: "leads", label: "Leads", group: "Performance", description: "Lead conversions for SaaS accounts." },
  { key: "cpl", label: "CPL", group: "Performance", description: "Cost per lead." },
  { key: "thumbstop", label: "Thumbstop", group: "Video", description: "3s view rate — does the creative stop the scroll?" },
  { key: "videoHold", label: "Video hold", group: "Video", description: "% of viewers who watch past 15s." },
  { key: "vtr", label: "VTR", group: "Video", description: "View-through rate." },
  {
    key: "hookScore",
    label: "Hook score",
    group: "Creative scores",
    description: "0–100 score derived from thumbstop + retention vs account baseline.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "ctaScore",
    label: "CTA score",
    group: "Creative scores",
    description: "0–100 score for call-to-action clarity.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "offerScore",
    label: "Offer score",
    group: "Creative scores",
    description: "0–100 score for offer relevance.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "clickScore",
    label: "Click score",
    group: "Creative scores",
    description: "0–100 score for click momentum.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "watchScore",
    label: "Watch score",
    group: "Creative scores",
    description: "0–100 score for video watch behavior.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "aiTag_hook",
    label: "AI tag · hook style",
    group: "AI tags",
    description: "Tagged hook style: UGC / Demo / Promise.",
    unavailable: true,
    unavailableReason: "Requires AI tag generation backend.",
  },
];

export const ASSET_LIBRARY_VIEW_STORAGE_KEY = "creatives-briefing-asset-library-view";

export function toggleArrayFilter<T extends string>(current: T[], value: T) {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
}

export function isAssetLibraryFilterActive(filters: AssetLibraryFilters) {
  return (
    filters.status !== "all" ||
    filters.formats.length > 0 ||
    filters.labels.length > 0 ||
    filters.badges.length > 0 ||
    filters.campaignLabel !== "all" ||
    filters.search.trim().length > 0
  );
}

export function assetLibraryCountSummary(filteredCount: number, originalCount: number) {
  return `Showing ${filteredCount} of ${originalCount}`;
}

export function filterAssetLibraryRows(
  rows: MetaCreativeRow[],
  filters: AssetLibraryFilters,
) {
  const search = filters.search.trim().toLowerCase();
  return safeRows(rows).filter((row) => {
    const extended = row as AssetLibraryRow;
    if (filters.status === "active" && extended.effectiveStatus !== "ACTIVE") return false;
    if (filters.status === "closed_30d" && extended.effectiveStatus === "ACTIVE") return false;
    if (filters.formats.length > 0 && !filters.formats.some((format) => rowMatchesFormat(extended, format))) return false;
    if (filters.labels.length > 0 && !filters.labels.includes(rowEngineLabel(extended) as DecisionLabel)) return false;
    if (filters.badges.length > 0 && !filters.badges.every((badge) => rowMatchesBadge(extended, badge))) return false;
    if (filters.campaignLabel !== "all" && rowCampaignLabel(extended) !== filters.campaignLabel) return false;
    if (search && !rowMatchesSearch(extended, search)) return false;
    return true;
  });
}

export function sortAssetLibraryRows(
  rows: MetaCreativeRow[],
  sort: AssetLibrarySort,
) {
  const sorted = [...safeRows(rows)];
  sorted.sort((a, b) => {
    if (sort === "roas_desc") return safeNumber(b.roas) - safeNumber(a.roas);
    if (sort === "roas_asc") return safeNumber(a.roas) - safeNumber(b.roas);
    if (sort === "name_asc") return safeText(a.name).localeCompare(safeText(b.name));
    if (sort === "launch_desc") return safeTime(b.launchDate) - safeTime(a.launchDate);
    return safeNumber(b.spend) - safeNumber(a.spend);
  });
  return sorted;
}

export function AssetLibrarySection({
  rows,
  emptyMessage,
  creativeHistoryById,
  defaultCurrency,
  selectedMetricIds,
  onSelectedMetricIdsChange,
  selectedRowIds,
  highlightedRowId = null,
  onToggleRow,
  onToggleAll,
  onOpenRow,
  onSortedRowsChange,
  dateRange: controlledDateRange,
  onDateRangeChange,
  isFetching = false,
}: AssetLibrarySectionProps) {
  const [filters, setFilters] = useState<AssetLibraryFilters>(DEFAULT_FILTERS);
  const [activePreset, setActivePreset] = useState<string>("facebook_ecom");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [uncontrolledDateRange, setUncontrolledDateRange] = useState<DateRangeValue>(
    () => ({ preset: "14d", ...computeRangeFromPreset("14d") }),
  );
  const dateRange = controlledDateRange ?? uncontrolledDateRange;
  const setDateRange = (next: DateRangeValue) => {
    if (onDateRangeChange) {
      onDateRangeChange(next);
    } else {
      setUncontrolledDateRange(next);
    }
  };

  const filteredRows = useMemo(
    () => sortAssetLibraryRows(filterAssetLibraryRows(rows, filters), filters.sort),
    [filters, rows],
  );
  const filtersActive = isAssetLibraryFilterActive(filters);

  const presetEntry = PRESETS.find((preset) => preset.key === activePreset) ?? PRESETS[0];

  const summaryTiles: KpiSummaryTile[] = useMemo(() => {
    const totalSpend = filteredRows.reduce((sum, row) => sum + safeNumber(row.spend), 0);
    const totalPurchases = filteredRows.reduce(
      (sum, row) => sum + safeNumber(row.purchases),
      0,
    );
    const roasValues = filteredRows
      .map((row) => safeNumber(row.roas))
      .filter((value) => value > 0);
    const medianRoas =
      roasValues.length === 0
        ? 0
        : roasValues.sort((a, b) => a - b)[Math.floor(roasValues.length / 2)];
    const cpaValues = filteredRows
      .map((row) => safeNumber(row.cpa))
      .filter((value) => value > 0);
    const medianCpa =
      cpaValues.length === 0
        ? 0
        : cpaValues.sort((a, b) => a - b)[Math.floor(cpaValues.length / 2)];

    return [
      {
        key: "total-spend",
        title: "Total spend",
        scope: `· ${filteredRows.length} creatives`,
        value: formatCurrency(totalSpend, defaultCurrency),
        micro: <span>Window · {dateRange.startDate} → {dateRange.endDate}</span>,
      },
      {
        key: "median-roas",
        title: "Median ROAS",
        value: medianRoas > 0 ? medianRoas.toFixed(2) : "—",
        unit: medianRoas > 0 ? "×" : undefined,
        highlight: medianRoas >= 2 ? "good" : medianRoas > 0 && medianRoas < 1.4 ? "warn" : "neutral",
      },
      {
        key: "median-cpa",
        title: "Median CPA",
        value: medianCpa > 0 ? formatCurrency(medianCpa, defaultCurrency) : "—",
      },
      {
        key: "purchases",
        title: "Purchases",
        value: String(totalPurchases),
        micro: presetEntry.unavailable ? (
          <span className="text-amber-700">
            Scoring preset is backend-dependent — buyer KPIs shown above.
          </span>
        ) : (
          <span>Across the current selection.</span>
        ),
      },
    ];
  }, [filteredRows, dateRange, presetEntry, defaultCurrency]);

  function handleApplyKpis(nextSelected: string[]) {
    onSelectedMetricIdsChange(nextSelected);
  }

  function buildShareUrl(state: ShareViewState) {
    const params = new URLSearchParams({
      preset: activePreset,
      audience: state.audience,
      expires: String(state.expiresInDays),
      snapshot: state.freezeSnapshot ? "1" : "0",
    });
    return `/share/creative/[token]?${params.toString()}`;
  }

  return (
    <section className="mt-6 space-y-4" data-asset-library>
      <PresetBar
        testId="asset-library-preset-bar"
        presets={[...PRESETS]}
        activePresetKey={activePreset}
        onPresetChange={setActivePreset}
        dateChip={
          <DateRangePicker
            testId="asset-library-date-picker"
            label="Asset library date range"
            value={dateRange}
            onChange={setDateRange}
          />
        }
        labelFilter={
          <div
            className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5"
            role="group"
            aria-label="Campaign label filter"
          >
            {LABEL_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() =>
                  setFilters((current) => ({ ...current, campaignLabel: filter.key }))
                }
                aria-pressed={filters.campaignLabel === filter.key}
                className={
                  "rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors " +
                  (filters.campaignLabel === filter.key
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-800")
                }
              >
                {filter.label}
              </button>
            ))}
          </div>
        }
        countLabel={`${filteredRows.length} · ${rows.length} total`}
        selectedCount={selectedRowIds.length}
        onCustomize={() => setCustomizeOpen(true)}
        onShareView={() => setShareOpen(true)}
      />

      {presetEntry.unavailable ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-900">
          <b>{presetEntry.label}</b> — {presetEntry.unavailableReason} Falling
          back to the buyer summary below until the scoring pipeline ships.
        </div>
      ) : null}

      <KpiSummaryTiles tiles={summaryTiles} testId="asset-library-kpi-summary" />

      {isFetching ? (
        <div
          className="text-[11.5px] text-slate-500"
          aria-live="polite"
          data-asset-library-fetching
        >
          Refreshing for {dateRange.startDate} → {dateRange.endDate}…
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
          <label className="relative flex-1 min-w-[220px]">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 inline-block shrink-0 text-slate-400"
              size={14}
              aria-hidden="true"
            />
            <input
              type="search"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.currentTarget.value }))
              }
              placeholder="Search creatives, campaigns, tags"
              className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </label>
          <select
            value={filters.sort}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                sort: event.currentTarget.value as AssetLibrarySort,
              }))
            }
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] text-slate-700"
            aria-label="Sort asset library"
          >
            <option value="spend_desc">Sort: spend</option>
            <option value="roas_desc">Sort: ROAS high</option>
            <option value="roas_asc">Sort: ROAS low</option>
            <option value="name_asc">Sort: name</option>
            <option value="launch_desc">Sort: newest</option>
          </select>
        </div>

        <div data-asset-library-body data-preset={activePreset}>
          {filteredRows.length === 0 ? (
            <div className="px-4 py-6 text-[12.5px] text-slate-500">
              {rows.length === 0
                ? emptyMessage ??
                  "No Meta creative rows were found for the selected window."
                : "No creatives match the current Asset Library filters."}
            </div>
          ) : (
            <CreativesTableSection
              rows={filteredRows}
              creativeHistoryById={creativeHistoryById}
              defaultCurrency={defaultCurrency}
              selectedMetricIds={selectedMetricIds}
              onSelectedMetricIdsChange={onSelectedMetricIdsChange}
              selectedRowIds={selectedRowIds}
              highlightedRowId={highlightedRowId}
              onToggleRow={onToggleRow}
              onToggleAll={onToggleAll}
              onOpenRow={onOpenRow}
              onSortedRowsChange={onSortedRowsChange}
            />
          )}
        </div>

        {filtersActive ? (
          <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-[11.5px] text-slate-500">
            {assetLibraryCountSummary(filteredRows.length, rows.length)}
          </div>
        ) : null}
      </div>

      <CustomizeKpisModal
        open={customizeOpen}
        catalog={[...KPI_CATALOG]}
        selectedKeys={selectedMetricIds}
        presetLabel={presetEntry.label}
        onClose={() => setCustomizeOpen(false)}
        onApply={handleApplyKpis}
      />
      <ShareViewModal
        open={shareOpen}
        presetLabel={presetEntry.label}
        itemCount={selectedRowIds.length || filteredRows.length}
        buildShareUrl={buildShareUrl}
        onClose={() => setShareOpen(false)}
      />
    </section>
  );
}

function rowEngineLabel(row: AssetLibraryRow) {
  return row.engineLabel ?? row.decisionLabel ?? row.briefingLabel ?? null;
}

function rowCampaignLabel(row: AssetLibraryRow): LabelFilterKey {
  const value = String((row as { campaignKind?: string | null }).campaignKind ?? "").toLowerCase();
  if (value === "main") return "main";
  if (value === "test") return "test";
  if (value === "mixed") return "mixed";
  return "all";
}

function safeRows(rows: unknown): MetaCreativeRow[] {
  return Array.isArray(rows)
    ? rows.filter((row): row is MetaCreativeRow => Boolean(row && typeof row === "object"))
    : [];
}

function safeText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function safeNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function safeTime(value: unknown) {
  const parsed = Date.parse(safeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean);
  const text = safeText(value);
  return text ? [text] : [];
}

function rowMatchesFormat(row: AssetLibraryRow, format: AssetLibraryFormatFilter) {
  if (format === "catalog") return row.isCatalog;
  if (format === "carousel") return row.creativeVisualFormat === "carousel";
  return row.format === format || row.creativeVisualFormat === format;
}

function rowMatchesBadge(row: AssetLibraryRow, badge: AssetLibraryBadgeFilter) {
  const badges = [
    ...safeStringArray(row.engineBadges),
    ...safeStringArray(row.badges),
    ...safeStringArray(row.tags),
  ].map((item) => item.toLowerCase().replace(/\s+/g, "_"));
  return badges.includes(badge);
}

function rowMatchesSearch(row: AssetLibraryRow, search: string) {
  return [
    row.name,
    row.campaignName,
    row.adSetName,
    row.accountName,
    ...safeStringArray(row.tags),
  ].some((value) => safeText(value).toLowerCase().includes(search));
}

function formatCurrency(value: number, currency: string | null): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const isoCurrency = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: isoCurrency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString()}`;
  }
}
