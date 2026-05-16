"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Grid3X3, List, Search } from "lucide-react";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel } from "@/components/common/briefing/types";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";

type AssetLibraryStatusFilter = "all" | "active" | "closed_30d";
type AssetLibraryFormatFilter = "image" | "video" | "catalog" | "carousel";
type AssetLibraryBadgeFilter = "below_breakeven" | "fatigue";
type AssetLibrarySort = "spend_desc" | "roas_desc" | "roas_asc" | "name_asc" | "launch_desc";
type AssetLibraryViewMode = "grid" | "list";

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
}

const STATUS_FILTERS: Array<{ key: AssetLibraryStatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "closed_30d", label: "Closed 30d" },
];

const FORMAT_FILTERS: Array<{ key: AssetLibraryFormatFilter; label: string }> = [
  { key: "image", label: "image" },
  { key: "video", label: "video" },
  { key: "catalog", label: "catalog" },
  { key: "carousel", label: "carousel" },
];

const LABEL_FILTERS: DecisionLabel[] = [
  "scale",
  "cut",
  "refresh",
  "keep",
  "test_more",
  "diagnose",
];

const BADGE_FILTERS: Array<{ key: AssetLibraryBadgeFilter; label: string }> = [
  { key: "below_breakeven", label: "Below breakeven" },
  { key: "fatigue", label: "Fatigue" },
];

const DEFAULT_FILTERS: AssetLibraryFilters = {
  status: "all",
  formats: [],
  labels: [],
  badges: [],
  search: "",
  sort: "spend_desc",
};

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
}: AssetLibrarySectionProps) {
  const [filters, setFilters] = useState<AssetLibraryFilters>(DEFAULT_FILTERS);
  const [viewMode, setViewMode] = useState<AssetLibraryViewMode>("list");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ASSET_LIBRARY_VIEW_STORAGE_KEY);
    if (stored === "grid" || stored === "list") setViewMode(stored);
  }, []);

  const updateViewMode = (next: AssetLibraryViewMode) => {
    setViewMode(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ASSET_LIBRARY_VIEW_STORAGE_KEY, next);
    }
  };

  const filteredRows = useMemo(
    () => sortAssetLibraryRows(filterAssetLibraryRows(rows, filters), filters.sort),
    [filters, rows],
  );
  const filtersActive = isAssetLibraryFilterActive(filters);

  return (
    <section className="mt-8" data-asset-library>
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="text-[15px] font-semibold text-slate-900">Asset Library</h2>
        <span className="text-[12px] text-slate-500">All creatives with Engine v3 context</span>
        <span className="ml-auto text-[11.5px] text-slate-500">
          {filteredRows.length} visible · {rows.length} total
        </span>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Status</span>
            {STATUS_FILTERS.map((filter) => (
              <ChipButton
                key={filter.key}
                active={filters.status === filter.key}
                onClick={() => setFilters((current) => ({ ...current, status: filter.key }))}
              >
                {filter.label}
              </ChipButton>
            ))}
            <span className="h-4 w-px bg-slate-200" />
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Format</span>
            {FORMAT_FILTERS.map((filter) => (
              <ChipButton
                key={filter.key}
                active={filters.formats.includes(filter.key)}
                onClick={() => setFilters((current) => ({ ...current, formats: toggleArrayFilter(current.formats, filter.key) }))}
              >
                {filter.label}
              </ChipButton>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Engine v3 label</span>
            {LABEL_FILTERS.map((label) => (
              <ChipButton
                key={label}
                active={filters.labels.includes(label)}
                onClick={() => setFilters((current) => ({ ...current, labels: toggleArrayFilter(current.labels, label) }))}
              >
                {label.replace(/_/g, " ")}
              </ChipButton>
            ))}
            <span className="h-4 w-px bg-slate-200" />
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Badge</span>
            {BADGE_FILTERS.map((filter) => (
              <ChipButton
                key={filter.key}
                active={filters.badges.includes(filter.key)}
                onClick={() => setFilters((current) => ({ ...current, badges: toggleArrayFilter(current.badges, filter.key) }))}
              >
                {filter.label}
              </ChipButton>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 inline-block shrink-0" size={14} aria-hidden="true" />
              <input
                type="search"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.currentTarget.value }))}
                placeholder="Search creatives, campaigns, tags"
                className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
            <select
              value={filters.sort}
              onChange={(event) => setFilters((current) => ({ ...current, sort: event.currentTarget.value as AssetLibrarySort }))}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] text-slate-700"
              aria-label="Sort asset library"
            >
              <option value="spend_desc">Sort: spend</option>
              <option value="roas_desc">Sort: ROAS high</option>
              <option value="roas_asc">Sort: ROAS low</option>
              <option value="name_asc">Sort: name</option>
              <option value="launch_desc">Sort: newest</option>
            </select>
            <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5" data-view-mode={viewMode}>
              <button
                type="button"
                aria-label="Grid view"
                className={`p-1.5 rounded ${viewMode === "grid" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-900"}`}
                onClick={() => updateViewMode("grid")}
              >
                <Grid3X3 className="inline-block shrink-0" size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="List view"
                className={`p-1.5 rounded ${viewMode === "list" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-900"}`}
                onClick={() => updateViewMode("list")}
              >
                <List className="inline-block shrink-0" size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div data-asset-library-body data-view={viewMode}>
          {filteredRows.length === 0 ? (
            <div className="px-4 py-6 text-[12.5px] text-slate-500">
              {rows.length === 0
                ? emptyMessage ?? "No Meta creative rows were found for the selected window."
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
    </section>
  );
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11.5px] ${
        active
          ? "border-blue-300 bg-blue-50 text-blue-700 font-medium"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function rowEngineLabel(row: AssetLibraryRow) {
  return row.engineLabel ?? row.decisionLabel ?? row.briefingLabel ?? null;
}

function safeRows(rows: unknown): MetaCreativeRow[] {
  return Array.isArray(rows) ? rows.filter((row): row is MetaCreativeRow => Boolean(row && typeof row === "object")) : [];
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
  ]
    .map((item) => item.toLowerCase().replace(/\s+/g, "_"));
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
