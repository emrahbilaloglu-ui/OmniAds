"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, CheckSquare, LayoutGrid, List, Search, XSquare } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import { buildPlacementTooltip } from "@/components/creatives/CreativesTopGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel, DecisionOutput } from "@/lib/creative-decision-engine";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "active" | "closed_30d" | "recently_duplicated";
type FormatFilter = "all" | "image" | "video" | "catalog" | "carousel";
type SortKey = "spend_desc" | "roas_desc" | "recency_desc" | "name_asc";
type BadgeFilter = "below_breakeven" | "fatigue";
type CampaignFilter = "all" | string;

const LABEL_OPTIONS: DecisionLabel[] = [
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
];

const BADGE_OPTIONS: Array<{ id: BadgeFilter; label: string }> = [
  { id: "below_breakeven", label: "Below breakeven" },
  { id: "fatigue", label: "Fatigue" },
];

const FORMAT_OPTIONS: Array<{ id: FormatFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "catalog", label: "Catalog" },
  { id: "carousel", label: "Carousel" },
];

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "closed_30d", label: "Closed last 30d" },
  { id: "recently_duplicated", label: "Recently duplicated" },
];

function isClosedLast30d(row: MetaCreativeRow) {
  const status = row.effectiveStatus?.trim().toUpperCase() ?? "";
  if (!status || status === "ACTIVE") return false;
  const launchTime = Date.parse(row.launchDate);
  if (!Number.isFinite(launchTime)) return true;
  return Date.now() - launchTime <= 30 * 24 * 60 * 60 * 1000;
}

function creativeMatchesFormat(row: MetaCreativeRow, format: FormatFilter) {
  if (format === "all") return true;
  if (format === "carousel") {
    return row.creativePrimaryType === "carousel" || row.creativeVisualFormat === "carousel";
  }
  if (format === "catalog") return row.isCatalog || row.format === "catalog";
  if (format === "video") return row.format === "video" || row.creativeVisualFormat === "video";
  return row.format === "image" || row.creativeVisualFormat === "image";
}

function hasFatigueBadge(decision: DecisionOutput | null | undefined) {
  return Boolean(
    decision?.badges?.some((badge) =>
      badge.type === "fatigue_watch" || badge.type === "fatigue_fatigued",
    ),
  );
}

function campaignFilterValue(row: MetaCreativeRow) {
  const campaignId = row.campaignId?.trim();
  if (campaignId) return campaignId;
  const campaignName = row.campaignName?.trim();
  return campaignName ? `name:${campaignName}` : "__unknown";
}

function hasRecentlyDuplicatedMarker(row: MetaCreativeRow) {
  return Boolean(row.launchpadRecentAction) || /\badded\b/i.test(row.name);
}

export function filterLaunchpadCreativeRows(input: {
  rows: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  search?: string;
  statusFilter?: StatusFilter;
  formatFilter?: FormatFilter;
  campaignFilter?: CampaignFilter;
  labels?: DecisionLabel[];
  badges?: BadgeFilter[];
  sort?: SortKey;
}) {
  const query = input.search?.trim().toLowerCase() ?? "";
  const statusFilter = input.statusFilter ?? "active";
  const formatFilter = input.formatFilter ?? "all";
  const campaignFilter = input.campaignFilter ?? "all";
  const labels = new Set(input.labels ?? []);
  const badges = new Set(input.badges ?? []);
  const sort = input.sort ?? "spend_desc";
  const rows = input.rows.filter((row) => {
    const decision = input.decisionByCreativeId.get(row.creativeId) ?? null;
    if (statusFilter === "active") {
      const status = row.effectiveStatus?.toUpperCase() ?? "ACTIVE";
      if (status && status !== "ACTIVE") return false;
    }
    if (statusFilter === "closed_30d" && !isClosedLast30d(row)) return false;
    if (statusFilter === "recently_duplicated" && !hasRecentlyDuplicatedMarker(row)) {
      return false;
    }
    if (!creativeMatchesFormat(row, formatFilter)) return false;
    if (campaignFilter !== "all" && campaignFilterValue(row) !== campaignFilter) {
      return false;
    }
    if (labels.size > 0 && (!decision || !labels.has(decision.label))) return false;
    if (badges.has("below_breakeven") && !hasBelowBreakeven(decision)) return false;
    if (badges.has("fatigue") && !hasFatigueBadge(decision)) return false;
    if (!query) return true;
    return [row.name, row.creativeId, row.campaignName, row.adSetName]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  return [...rows].sort((a, b) => {
    if (sort === "roas_desc") return (b.roas ?? 0) - (a.roas ?? 0);
    if (sort === "recency_desc") {
      return Date.parse(b.launchDate || "") - Date.parse(a.launchDate || "");
    }
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    return (b.spend ?? 0) - (a.spend ?? 0);
  });
}

export function buildLaunchpadSelectionSummary(input: {
  selectedCreatives: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
}) {
  let spend = 0;
  let weightedRoas = 0;
  let belowBreakeven = 0;
  const labelCounts = new Map<DecisionLabel, number>();
  input.selectedCreatives.forEach((creative) => {
    const decision = input.decisionByCreativeId.get(creative.creativeId) ?? null;
    const creativeSpend = decision?.metrics.spend ?? creative.spend ?? 0;
    const creativeRoas = decision?.metrics.roas ?? creative.roas ?? 0;
    spend += creativeSpend;
    weightedRoas += creativeSpend * creativeRoas;
    if (decision) labelCounts.set(decision.label, (labelCounts.get(decision.label) ?? 0) + 1);
    if (hasBelowBreakeven(decision)) belowBreakeven += 1;
  });
  return {
    count: input.selectedCreatives.length,
    totalSpend: spend,
    averageRoas: spend > 0 ? weightedRoas / spend : null,
    belowBreakeven,
    scale: labelCounts.get("scale") ?? 0,
    cut: labelCounts.get("cut") ?? 0,
  };
}

export function hasBelowBreakeven(decision: DecisionOutput | null | undefined) {
  return Boolean(decision?.badges?.some((badge) => badge.type === "below_breakeven"));
}

export function getCreativeAdvisoryNotes(decision: DecisionOutput | null | undefined) {
  if (!decision) return [];
  const notes: Array<{ tone: "success" | "warning" | "danger" | "muted"; text: string }> = [];
  if (decision.label === "scale") {
    notes.push({
      tone: "success",
      text: "Engine: scale candidate (consider higher budget tier)",
    });
  }
  if (decision.label === "cut") {
    notes.push({ tone: "danger", text: "Engine: cut candidate - confirm intent" });
  }
  if (decision.label === "out_of_scope") {
    notes.push({ tone: "muted", text: "Engine: out of scope (no decision)" });
  }
  if (decision.label === "refresh") {
    notes.push({ tone: "warning", text: "Engine: refresh recommended - concept tired" });
  }
  if (decision.label === "diagnose") {
    notes.push({ tone: "danger", text: "Engine: data anomaly - verify before launch" });
  }
  if (hasBelowBreakeven(decision)) {
    notes.push({ tone: "warning", text: "Below breakeven - historical loss" });
  }
  return notes;
}

function noteClass(tone: "success" | "warning" | "danger" | "muted") {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "danger") return "border-rose-200 bg-rose-50 text-rose-800";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-border bg-muted text-muted-foreground";
}

export function LaunchpadCreativeSelection({
  rows,
  selectedCreativeIds,
  decisionByCreativeId,
  loading = false,
  initialStatusFilter = "active",
  currency = null,
  getSelectionId = (row) => row.creativeId,
  onToggleCreative,
  onSetSelectedCreativeIds,
}: {
  rows: MetaCreativeRow[];
  selectedCreativeIds: string[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  loading?: boolean;
  initialStatusFilter?: StatusFilter;
  currency?: string | null;
  getSelectionId?: (row: MetaCreativeRow) => string;
  onToggleCreative: (row: MetaCreativeRow) => void;
  onSetSelectedCreativeIds?: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatusFilter);
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");
  const [campaignFilter, setCampaignFilter] = useState<CampaignFilter>("all");
  const [labels, setLabels] = useState<DecisionLabel[]>([]);
  const [badges, setBadges] = useState<BadgeFilter[]>([]);
  const [sort, setSort] = useState<SortKey>("spend_desc");
  const [view, setView] = useState<"list" | "grid">("list");
  const [visibleCount, setVisibleCount] = useState(25);

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
  }, [initialStatusFilter]);

  const selectedSet = useMemo(
    () => new Set(selectedCreativeIds),
    [selectedCreativeIds],
  );
  const filteredRows = useMemo(
    () =>
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId,
        search,
        statusFilter,
        formatFilter,
        campaignFilter,
        labels,
        badges,
        sort,
      }),
    [badges, campaignFilter, decisionByCreativeId, formatFilter, labels, rows, search, sort, statusFilter],
  );
  const campaignOptionRows = useMemo(
    () =>
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId,
        search,
        statusFilter,
        formatFilter,
        campaignFilter: "all",
        labels,
        badges,
        sort,
      }),
    [badges, decisionByCreativeId, formatFilter, labels, rows, search, sort, statusFilter],
  );
  const campaignOptions = useMemo(() => {
    const byValue = new Map<string, { value: string; label: string; count: number }>();
    campaignOptionRows.forEach((row) => {
      const value = campaignFilterValue(row);
      const existing = byValue.get(value);
      if (existing) {
        existing.count += 1;
        return;
      }
      byValue.set(value, {
        value,
        label: row.campaignName?.trim() || row.campaignId?.trim() || "Unknown campaign",
        count: 1,
      });
    });
    if (campaignFilter !== "all" && !byValue.has(campaignFilter)) {
      const selectedRow = rows.find((row) => campaignFilterValue(row) === campaignFilter);
      if (selectedRow) {
        byValue.set(campaignFilter, {
          value: campaignFilter,
          label: selectedRow.campaignName?.trim() || selectedRow.campaignId?.trim() || "Unknown campaign",
          count: 0,
        });
      }
    }
    return Array.from(byValue.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [campaignFilter, campaignOptionRows, rows]);
  const visibleRows = filteredRows.length > 50 ? filteredRows.slice(0, visibleCount) : filteredRows;
  const selectedCreatives = useMemo(
    () => rows.filter((row) => selectedSet.has(getSelectionId(row))),
    [getSelectionId, rows, selectedSet],
  );
  const summary = useMemo(
    () => buildLaunchpadSelectionSummary({ selectedCreatives, decisionByCreativeId }),
    [decisionByCreativeId, selectedCreatives],
  );

  function toggleLabel(label: DecisionLabel) {
    setLabels((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    );
  }

  function toggleBadge(badge: BadgeFilter) {
    setBadges((current) =>
      current.includes(badge) ? current.filter((item) => item !== badge) : [...current, badge],
    );
  }

  function selectAllMatching() {
    const ids = Array.from(new Set([...selectedCreativeIds, ...filteredRows.map((row) => getSelectionId(row))]));
    if (onSetSelectedCreativeIds) {
      onSetSelectedCreativeIds(ids);
      return;
    }
    filteredRows.forEach((row) => {
      if (!selectedSet.has(getSelectionId(row))) onToggleCreative(row);
    });
  }

  function clearSelection() {
    if (onSetSelectedCreativeIds) {
      onSetSelectedCreativeIds([]);
      return;
    }
    rows.forEach((row) => {
      if (selectedSet.has(getSelectionId(row))) onToggleCreative(row);
    });
  }

  return (
    <section className="space-y-4 text-slate-950" data-testid="launchpad-creative-selection">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold">Select creatives</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            From active or recently closed ads. Engine v3 advisory is shown per row.
          </p>
        </div>
        <div className="inline-flex w-fit rounded-md border border-slate-200 bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setView("list")}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm transition",
              view === "list" ? "bg-white font-medium text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-950",
            )}
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
          <button
            type="button"
            onClick={() => setView("grid")}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm transition",
              view === "grid" ? "bg-white font-medium text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-950",
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Grid
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md xl:max-w-lg">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search creative name or ID..."
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="block">
            <span className="sr-only">Filter by campaign</span>
            <select
              value={campaignFilter}
              onChange={(event) => setCampaignFilter(event.target.value)}
              className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 sm:w-[230px]"
            >
              <option value="all">All campaigns</option>
              {campaignOptions.map((campaign) => (
                <option key={campaign.value} value={campaign.value}>
                  {campaign.label} ({campaign.count})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="sr-only">Sort creatives</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 sm:w-[210px]"
            >
              <option value="spend_desc">Spend, high to low</option>
              <option value="roas_desc">ROAS, high to low</option>
              <option value="recency_desc">Recently created</option>
              <option value="name_asc">Name A to Z</option>
            </select>
          </label>
        </div>
      </div>

      <div className="space-y-2 py-1">
        <FilterGroup label="Status">
          {STATUS_OPTIONS.map((option) => (
            <FilterChip
              key={option.id}
              active={statusFilter === option.id}
              onClick={() => setStatusFilter(option.id)}
            >
              {option.label}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Format">
          {FORMAT_OPTIONS.map((option) => (
            <FilterChip
              key={option.id}
              active={formatFilter === option.id}
              onClick={() => setFormatFilter(option.id)}
            >
              {option.label}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Engine">
          <FilterChip active={labels.length === 0} onClick={() => setLabels([])}>
            All
          </FilterChip>
          {LABEL_OPTIONS.map((label) => (
            <FilterChip key={label} active={labels.includes(label)} onClick={() => toggleLabel(label)}>
              {label.replaceAll("_", " ")}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Badges">
          <FilterChip active={badges.length === 0} onClick={() => setBadges([])}>
            All
          </FilterChip>
          {BADGE_OPTIONS.map((option) => (
            <FilterChip key={option.id} active={badges.includes(option.id)} onClick={() => toggleBadge(option.id)}>
              {option.label}
            </FilterChip>
          ))}
        </FilterGroup>
      </div>

      {loading ? (
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-500">
          Loading creatives...
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
        <div className="text-xs text-slate-500">
          <span className="font-mono font-medium tabular-nums text-slate-950">{filteredRows.length}</span> match
          <span className="mx-2 text-slate-300">·</span>
          <span className="font-mono font-medium tabular-nums text-slate-950">{selectedCreativeIds.length}</span> selected
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={selectAllMatching}>
            <CheckSquare className="h-3.5 w-3.5" />
            Select all matching ({filteredRows.length})
          </Button>
          <Button type="button" variant="link" size="sm" onClick={clearSelection}>
            <XSquare className="h-3.5 w-3.5" />
            Clear ({selectedCreativeIds.length})
          </Button>
        </div>
      </div>

      {view === "list" ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="grid grid-cols-[44px_56px_1fr_220px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span />
            <span>Asset</span>
            <span>Creative</span>
            <span className="text-right">28d metrics</span>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {visibleRows.map((row) => {
              const decision = decisionByCreativeId.get(row.creativeId) ?? null;
              const selected = selectedSet.has(getSelectionId(row));
              const notes = selected ? getCreativeAdvisoryNotes(decision) : [];
              const placementTooltip = buildPlacementTooltip(row);
              const recentlyDuplicated = hasRecentlyDuplicatedMarker(row);
              return (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onToggleCreative(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onToggleCreative(row);
                  }}
                  className={cn(
                    "grid cursor-pointer grid-cols-[44px_56px_1fr_220px] gap-2 border-b border-slate-100 px-3 py-3 transition-colors last:border-b-0 hover:bg-slate-50",
                    selected ? "bg-blue-50/50" : "bg-white",
                  )}
                >
                  <div className="pt-2">
                    <span
                      className={cn(
                        "inline-flex h-4 w-4 items-center justify-center rounded border",
                        selected ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white",
                      )}
                    >
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`Select ${row.name}`}
                      onChange={() => onToggleCreative(row)}
                      onClick={(event) => event.stopPropagation()}
                      className="sr-only"
                    />
                  </div>
                  <CreativeRenderSurface
                    id={row.id}
                    name={row.name}
                    preview={row.preview}
                    size="thumb"
                    mode="asset"
                    assetFallbacks={[
                      row.tableThumbnailUrl,
                      row.thumbnailUrl,
                      row.imageUrl,
                      row.preview.image_url,
                      row.preview.poster_url,
                    ]}
                  />
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-950">{row.name}</p>
                      {decision ? <CreativeDecisionLabelBadge label={decision.label} /> : null}
                      {hasBelowBreakeven(decision) ? (
                        <Badge className="border-amber-200 bg-amber-50 text-amber-900" variant="outline">
                          Below breakeven
                        </Badge>
                      ) : null}
                      {recentlyDuplicated ? (
                        <Badge className="border-indigo-200 bg-indigo-50 text-indigo-700" variant="outline">
                          Recently duplicated
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-slate-500" title={placementTooltip}>
                      {row.campaignName ?? row.campaignId ?? "No campaign"} / {row.adSetName ?? row.adSetId ?? "No ad set"}
                    </p>
                    {notes.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {notes.map((note) => (
                          <span
                            key={note.text}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                              noteClass(note.tone),
                            )}
                          >
                            {note.tone === "danger" ? <AlertTriangle className="h-3 w-3" /> : null}
                            {note.text}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="pt-1 text-right text-sm tabular-nums">
                    <span className="font-semibold text-slate-950">{formatMoney(row.spend, currency)}</span>
                    <span className="text-slate-400"> · ROAS </span>
                    <span className={cn("font-semibold", row.roas >= 2 ? "text-emerald-700" : row.roas < 1 ? "text-rose-700" : "text-slate-950")}>{row.roas.toFixed(2)}x</span>
                    <span className="text-slate-400"> · </span>
                    <span className="font-semibold text-slate-700">{row.purchases.toLocaleString()}</span>
                    <span className="text-slate-400"> purchases</span>
                  </div>
                </div>
              );
            })}
            {filteredRows.length === 0 ? (
              <div className="p-4 text-sm text-slate-500">No creatives found.</div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleRows.map((row) => {
            const decision = decisionByCreativeId.get(row.creativeId) ?? null;
            const selected = selectedSet.has(getSelectionId(row));
            const recentlyDuplicated = hasRecentlyDuplicatedMarker(row);
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onToggleCreative(row)}
                className={cn(
                  "relative rounded-lg border bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:bg-slate-50",
                  selected ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200",
                )}
              >
                <div className="flex items-start gap-3">
                  <CreativeRenderSurface
                    id={row.id}
                    name={row.name}
                    preview={row.preview}
                    size="thumb"
                    mode="asset"
                    assetFallbacks={[
                      row.tableThumbnailUrl,
                      row.thumbnailUrl,
                      row.imageUrl,
                      row.preview.image_url,
                      row.preview.poster_url,
                    ]}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 pr-8 text-sm font-medium text-slate-950">{row.name}</p>
                      <span
                        className={cn(
                          "absolute right-3 top-3 inline-flex h-5 w-5 items-center justify-center rounded border",
                          selected ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white",
                        )}
                      >
                        {selected ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-slate-500">
                      {row.campaignName ?? row.campaignId ?? "No campaign"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {decision ? <CreativeDecisionLabelBadge label={decision.label} /> : null}
                      {hasBelowBreakeven(decision) ? (
                        <Badge className="border-amber-200 bg-amber-50 text-amber-900" variant="outline">
                          Below breakeven
                        </Badge>
                      ) : null}
                      {recentlyDuplicated ? (
                        <Badge className="border-indigo-200 bg-indigo-50 text-indigo-700" variant="outline">
                          Recently duplicated
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
                  <Metric label="Spend" value={formatMoney(row.spend, currency)} />
                  <Metric label="ROAS" value={`${row.roas.toFixed(2)}x`} tone={row.roas >= 2 ? "good" : row.roas < 1 ? "bad" : "neutral"} />
                  <Metric label="Purch." value={row.purchases.toLocaleString()} />
                </div>
              </button>
            );
          })}
          {filteredRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500 sm:col-span-2 xl:col-span-3">
              No creatives found.
            </div>
          ) : null}
        </div>
      )}

      {rows.length > 50 && visibleRows.length < filteredRows.length ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={() => setVisibleCount((current) => current + 25)}>
            Load more
          </Button>
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white/95 p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]" data-testid="launchpad-selection-summary">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span className="font-mono tabular-nums">
            <strong className="text-base text-slate-950">{summary.count}</strong>{" "}
            <span className="text-slate-500">selected</span>
          </span>
          <span className="font-mono tabular-nums text-slate-600">
            Spend <strong className="text-slate-950">{formatMoney(summary.totalSpend, currency)}</strong>
          </span>
          <span className="font-mono tabular-nums text-slate-600">
            Avg ROAS <strong className={summary.averageRoas != null && summary.averageRoas >= 2 ? "text-emerald-700" : "text-slate-950"}>
              {summary.averageRoas == null ? "n/a" : `${summary.averageRoas.toFixed(1)}x`}
            </strong>
          </span>
          <span className="text-xs text-slate-500">
            {summary.scale} scale · {summary.cut} cut · {summary.belowBreakeven} below breakeven
          </span>
        </div>
      </div>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-[0.075em] text-slate-400">
        {label}
      </span>
      {children}
    </div>
  );
}

function FilterChip({
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
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
        active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      {children}
    </button>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={cn(
          "font-mono font-semibold tabular-nums",
          tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-slate-950",
        )}
      >
        {value}
      </div>
    </div>
  );
}
