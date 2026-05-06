"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import { buildPlacementTooltip } from "@/components/creatives/CreativesTopGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel, DecisionOutput } from "@/lib/creative-decision-engine";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "active" | "closed_30d";
type FormatFilter = "all" | "image" | "video" | "catalog" | "carousel";
type SortKey = "spend_desc" | "roas_desc" | "recency_desc" | "name_asc";
type BadgeFilter = "below_breakeven" | "fatigue";

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

export function filterLaunchpadCreativeRows(input: {
  rows: MetaCreativeRow[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  search?: string;
  statusFilter?: StatusFilter;
  formatFilter?: FormatFilter;
  labels?: DecisionLabel[];
  badges?: BadgeFilter[];
  sort?: SortKey;
}) {
  const query = input.search?.trim().toLowerCase() ?? "";
  const statusFilter = input.statusFilter ?? "active";
  const formatFilter = input.formatFilter ?? "all";
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
    if (!creativeMatchesFormat(row, formatFilter)) return false;
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
  onToggleCreative,
  onSetSelectedCreativeIds,
}: {
  rows: MetaCreativeRow[];
  selectedCreativeIds: string[];
  decisionByCreativeId: Map<string, DecisionOutput>;
  loading?: boolean;
  onToggleCreative: (row: MetaCreativeRow) => void;
  onSetSelectedCreativeIds?: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");
  const [labels, setLabels] = useState<DecisionLabel[]>([]);
  const [badges, setBadges] = useState<BadgeFilter[]>([]);
  const [sort, setSort] = useState<SortKey>("spend_desc");
  const [visibleCount, setVisibleCount] = useState(25);
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
        labels,
        badges,
        sort,
      }),
    [badges, decisionByCreativeId, formatFilter, labels, rows, search, sort, statusFilter],
  );
  const visibleRows = rows.length > 50 ? filteredRows.slice(0, visibleCount) : filteredRows;
  const selectedCreatives = useMemo(
    () => rows.filter((row) => selectedSet.has(row.creativeId)),
    [rows, selectedSet],
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
    const ids = Array.from(new Set([...selectedCreativeIds, ...filteredRows.map((row) => row.creativeId)]));
    if (onSetSelectedCreativeIds) {
      onSetSelectedCreativeIds(ids);
      return;
    }
    filteredRows.forEach((row) => {
      if (!selectedSet.has(row.creativeId)) onToggleCreative(row);
    });
  }

  function clearSelection() {
    if (onSetSelectedCreativeIds) {
      onSetSelectedCreativeIds([]);
      return;
    }
    rows.forEach((row) => {
      if (selectedSet.has(row.creativeId)) onToggleCreative(row);
    });
  }

  return (
    <section className="space-y-4" data-testid="launchpad-creative-selection">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Creative selection</h2>
          <p className="text-sm text-muted-foreground">
            {selectedCreativeIds.length} selected / {filteredRows.length} matching
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="block">
            <span className="sr-only">Sort creatives</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            >
              <option value="spend_desc">Spend desc</option>
              <option value="roas_desc">ROAS desc</option>
              <option value="recency_desc">Recency desc</option>
              <option value="name_asc">Name asc</option>
            </select>
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search creatives"
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary sm:w-64"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-3">
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
        <FilterGroup label="Engine v3 label">
          <FilterChip active={labels.length === 0} onClick={() => setLabels([])}>
            All
          </FilterChip>
          {LABEL_OPTIONS.map((label) => (
            <FilterChip key={label} active={labels.includes(label)} onClick={() => toggleLabel(label)}>
              {label.replaceAll("_", " ")}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Engine v3 badge">
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
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          Loading creatives...
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={selectAllMatching}>
            Select all matching filter
          </Button>
          <Button type="button" variant="link" size="sm" onClick={clearSelection}>
            Clear selection
          </Button>
        </div>
        {rows.length > 50 ? (
          <Badge variant="outline">Load more pagination active</Badge>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-[44px_56px_1fr_220px] border-b bg-muted/50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span />
          <span>Asset</span>
          <span>Creative</span>
          <span>28d metrics</span>
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {visibleRows.map((row) => {
            const decision = decisionByCreativeId.get(row.creativeId) ?? null;
            const selected = selectedSet.has(row.creativeId);
            const notes = selected ? getCreativeAdvisoryNotes(decision) : [];
            const placementTooltip = buildPlacementTooltip(row);
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
                  "grid cursor-pointer grid-cols-[44px_56px_1fr_220px] gap-2 border-b px-3 py-3 transition-colors last:border-b-0 hover:bg-accent/40",
                  selected ? "bg-primary/5" : "bg-background",
                )}
              >
                <div className="pt-1">
                  <input
                    type="checkbox"
                    checked={selected}
                    aria-label={`Select ${row.name}`}
                    onChange={() => onToggleCreative(row)}
                    onClick={(event) => event.stopPropagation()}
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
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    {decision ? <CreativeDecisionLabelBadge label={decision.label} /> : null}
                    {hasBelowBreakeven(decision) ? (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-900" variant="outline">
                        Below breakeven
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground" title={placementTooltip}>
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
                <div className="pt-1 text-sm tabular-nums">
                  <span className="font-medium">${row.spend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  <span className="text-muted-foreground"> · ROAS </span>
                  <span className="font-medium">{row.roas.toFixed(2)}x</span>
                  <span className="text-muted-foreground"> · </span>
                  <span className="font-medium">{row.purchases.toLocaleString()}</span>
                  <span className="text-muted-foreground"> purchases</span>
                </div>
              </div>
            );
          })}
          {filteredRows.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No creatives found.</div>
          ) : null}
        </div>
      </div>

      {rows.length > 50 && visibleRows.length < filteredRows.length ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={() => setVisibleCount((current) => current + 25)}>
            Load more
          </Button>
        </div>
      ) : null}

      <div className="sticky bottom-0 rounded-md border bg-background/95 p-3 shadow-sm" data-testid="launchpad-selection-summary">
        <p className="text-sm font-medium">
          {summary.count} creatives selected · Avg ROAS{" "}
          {summary.averageRoas == null ? "n/a" : `${summary.averageRoas.toFixed(1)}x`} · Total 28d spend{" "}
          ${summary.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })} ·{" "}
          {summary.belowBreakeven} below_breakeven · {summary.scale} scale · {summary.cut} cut
        </p>
      </div>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
        active ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
