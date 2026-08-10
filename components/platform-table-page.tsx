"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { useAppStore } from "@/store/app-store";
import { getPlatformTable } from "@/src/services";
import { MetricsRow, Platform, PlatformLevel, PlatformTableRow } from "@/src/types";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductPageShell, ProductSection, StateBanner } from "@/components/ui/product-surface";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";

interface PlatformTablePageProps {
  platform: Platform;
  title: string;
  description: string;
}

type TabValue = "campaigns" | "adSets" | "ads";
type SortDirection = "asc" | "desc";
type StatusFilter = "all" | "active" | "paused";
type MetricColumn = keyof Pick<
  MetricsRow,
  "spend" | "purchases" | "revenue" | "roas" | "cpa" | "ctr" | "cpm"
>;
type SortColumn = "name" | "status" | MetricColumn;

const DATE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-03-01",
};

const TAB_TO_LEVEL: Record<TabValue, PlatformLevel> = {
  campaigns: PlatformLevel.CAMPAIGN,
  adSets: PlatformLevel.AD_SET,
  ads: PlatformLevel.AD,
};

const DEFAULT_COLUMNS: MetricColumn[] = [
  "spend",
  "purchases",
  "revenue",
  "roas",
  "cpa",
  "ctr",
  "cpm",
];

const ALL_METRIC_OPTIONS: Array<{ key: MetricColumn; label: string }> = [
  { key: "spend", label: "Spend" },
  { key: "purchases", label: "Purchases" },
  { key: "revenue", label: "Revenue" },
  { key: "roas", label: "ROAS" },
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "cpm", label: "CPM" },
];

export function PlatformTablePage({
  platform,
  title,
  description,
}: PlatformTablePageProps) {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";

  const [activeTab, setActiveTab] = useState<TabValue>("campaigns");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortColumn, setSortColumn] = useState<SortColumn>("spend");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [visibleColumns, setVisibleColumns] = useState<MetricColumn[]>(DEFAULT_COLUMNS);
  const [draftColumns, setDraftColumns] = useState<MetricColumn[]>(DEFAULT_COLUMNS);
  const [isMetricsModalOpen, setIsMetricsModalOpen] = useState(false);

  const accountQuery = useQuery({
    queryKey: ["platform-accounts", platform, businessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: () =>
      getPlatformTable(
        platform,
        PlatformLevel.ACCOUNT,
        businessId,
        null,
        DATE_RANGE,
        ["spend", "purchases", "revenue", "roas", "cpa", "ctr", "cpm"]
      ),
  });

  const level = TAB_TO_LEVEL[activeTab];
  const tableQuery = useQuery({
    queryKey: [
      "platform-table",
      platform,
      level,
      businessId,
      selectedAccountId,
      visibleColumns.join(","),
    ],
    enabled: Boolean(selectedBusinessId),
    queryFn: () =>
      getPlatformTable(
        platform,
        level,
        businessId,
        selectedAccountId === "all" ? null : selectedAccountId,
        DATE_RANGE,
        visibleColumns
      ),
  });

  const enabledAccounts = useMemo(() => {
    const rows = accountQuery.data ?? [];
    const activeRows = rows.filter((row) => row.status === "active");
    return activeRows.length > 0 ? activeRows : rows;
  }, [accountQuery.data]);

  useEffect(() => {
    if (enabledAccounts.length === 0) return;
    if (
      selectedAccountId !== "all" &&
      !enabledAccounts.some((account) => account.accountId === selectedAccountId)
    ) {
      setSelectedAccountId(enabledAccounts[0].accountId);
    }
  }, [enabledAccounts, selectedAccountId]);

  const filteredRows = useMemo(() => {
    const rows = tableQuery.data ?? [];
    const byStatus =
      statusFilter === "all" ? rows : rows.filter((row) => row.status === statusFilter);

    const sorted = [...byStatus].sort((a, b) => {
      return comparePlatformTableRows(a, b, sortColumn, sortDirection);
    });

    return sorted;
  }, [tableQuery.data, sortColumn, sortDirection, statusFilter]);

  const openMetricsModal = () => {
    setDraftColumns(visibleColumns);
    setIsMetricsModalOpen(true);
  };

  const toggleDraftColumn = (column: MetricColumn) => {
    setDraftColumns((prev) =>
      prev.includes(column) ? prev.filter((item) => item !== column) : [...prev, column]
    );
  };

  const applyMetricsSelection = () => {
    if (draftColumns.length === 0) return;
    const ordered = ALL_METRIC_OPTIONS.map((item) => item.key).filter((key) =>
      draftColumns.includes(key)
    );
    setVisibleColumns(ordered);
    setIsMetricsModalOpen(false);
  };

  const tabs: Array<{ key: TabValue; label: string }> = [
    { key: "campaigns", label: "Campaigns" },
    { key: "adSets", label: platform === Platform.GOOGLE ? "Ad Groups" : "Ad Sets" },
    { key: "ads", label: "Ads" },
  ];

  const isLoading = tableQuery.isLoading || accountQuery.isLoading;
  const isError = tableQuery.isError || accountQuery.isError;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <ProductPageShell
      eyebrow="Platform workspace"
      title={title}
      description={description}
      className="ad-platform-table"
      actions={
        <div className="ad-platform-table-status">
          <span aria-hidden="true" />
          Server-backed table · currency not inferred
        </div>
      }
    >

      <div className="flex gap-1 overflow-x-auto border-b border-neutral-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
              activeTab === tab.key
                ? "border-neutral-950 text-neutral-950"
                : "border-transparent text-neutral-500 hover:text-neutral-900"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ProductSection
        title="Table controls"
        description="Filtering stays client-side over server-returned rows; unavailable metric cells stay blank."
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
            <span className="uppercase tracking-[0.12em]">Account</span>
            <select
              value={selectedAccountId}
              onChange={(event) => setSelectedAccountId(event.target.value)}
              className="h-8 rounded-md border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-400"
            >
              <option value="all">All enabled accounts</option>
              {enabledAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
            <span className="uppercase tracking-[0.12em]">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="h-8 rounded-md border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-400"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
            <span className="uppercase tracking-[0.12em]">Sort</span>
            <select
              value={sortColumn}
              onChange={(event) => setSortColumn(event.target.value as SortColumn)}
              className="h-8 rounded-md border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none focus:border-neutral-400"
            >
              <option value="name">Name</option>
              <option value="status">Status</option>
              {ALL_METRIC_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-md border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
            onClick={() =>
              setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"))
            }
          >
            {sortDirection === "asc" ? "Asc" : "Desc"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-md border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
            onClick={openMetricsModal}
          >
            <Plus className="h-4 w-4" />
            Add metrics
          </Button>
        </div>
      </ProductSection>

      {isLoading && (
        <ProductSection>
          <LoadingSkeleton rows={3} />
        </ProductSection>
      )}
      {isError && (
        <ProductSection>
          <ErrorState onRetry={() => tableQuery.refetch()} />
        </ProductSection>
      )}
      {!isLoading && !isError && filteredRows.length === 0 && (
        <ProductSection>
          <EmptyState
            title="No rows found"
            description="No rows match the selected account, level, or filters."
          />
        </ProductSection>
      )}

      {!isLoading && !isError && filteredRows.length > 0 && (
        <ProductSection
          title={`${tabs.find((tab) => tab.key === activeTab)?.label ?? "Rows"} table`}
          description="Money columns are rendered at row grain; no cross-currency aggregation is performed here."
          actions={
            <StateBanner tone="neutral" title={`${filteredRows.length} rows`} className="px-2 py-1.5" />
          }
        >
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left text-[12px] uppercase tracking-[0.12em] text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {visibleColumns.map((column) => (
                  <th key={column} className="px-4 py-3 text-right font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <td className="px-4 py-3 font-medium text-neutral-950">{row.name}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="secondary"
                      className={cn(
                        "rounded-md border px-2 py-0 text-[12px] font-medium capitalize",
                        row.status === "active"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-neutral-200 bg-neutral-100 text-neutral-600"
                      )}
                    >
                      {row.status}
                    </Badge>
                  </td>
                  {visibleColumns.map((column) => (
                    <td key={column} className="px-4 py-3 text-right font-medium tabular-nums text-neutral-700">
                      {formatPlatformMetricCell(column, row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </ProductSection>
      )}

      {isMetricsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/35 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold tracking-tight text-neutral-950">Manage metric columns</h3>
              <button
                type="button"
                className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                onClick={() => setIsMetricsModalOpen(false)}
                aria-label="Close metrics modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              {ALL_METRIC_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800"
                >
                  <span>{option.label}</span>
                  <input
                    type="checkbox"
                    checked={draftColumns.includes(option.key)}
                    onChange={() => toggleDraftColumn(option.key)}
                  />
                </label>
              ))}
            </div>

            <p className="mt-3 text-xs text-neutral-500">
              At least one metric column must remain selected.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsMetricsModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={applyMetricsSelection} disabled={draftColumns.length === 0}>
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </ProductPageShell>
  );
}

export function formatPlatformMetricCell(column: MetricColumn, row: PlatformTableRow) {
  const value = row.metrics[column];
  if (typeof value !== "number") return "—";
  if (column === "spend" || column === "revenue" || column === "cpa" || column === "cpm") {
    return `${value.toLocaleString()} · currency —`;
  }
  if (column === "roas") return value.toFixed(2);
  if (column === "ctr") return `${value.toFixed(2)}%`;
  return value.toLocaleString();
}

export function comparePlatformTableRows(
  a: PlatformTableRow,
  b: PlatformTableRow,
  sortColumn: SortColumn,
  sortDirection: SortDirection,
) {
  const multiplier = sortDirection === "asc" ? 1 : -1;
  if (sortColumn === "name" || sortColumn === "status") {
    return a[sortColumn].localeCompare(b[sortColumn]) * multiplier;
  }
  const aValue = a.metrics[sortColumn];
  const bValue = b.metrics[sortColumn];
  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return 1;
  if (bValue == null) return -1;
  return (aValue - bValue) * multiplier;
}
