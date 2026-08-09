"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import {
  applyCreativeFilters,
  DEFAULT_COPY_TOP_METRIC_IDS,
  CreativeDateRangeValue,
  CreativeFilterRule,
  CreativeGroupBy,
  CreativesTopSection,
  resolveCreativeDateRange,
} from "@/components/creatives/CreativesTopSection";
import { formatMoney } from "@/components/creatives/money";
import { usePersistentCreativeDateRange } from "@/hooks/use-persistent-date-range";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useAppStore } from "@/store/app-store";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import {
  mapApiRowToCopyRow,
  type CopyMotionRow,
} from "@/app/(dashboard)/platforms/meta/copies/page-support";

interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
    generatedAt?: string;
    provider_account_id?: string;
  };
}

const COPY_GROUP_OPTIONS: Array<{ value: CreativeGroupBy; label: string }> = [
  { value: "copy", label: "Copy" },
  { value: "adName", label: "Ad Name" },
  { value: "campaign", label: "Campaign" },
  { value: "adSet", label: "Ad Set" },
];

function hasMessage(payload: unknown): payload is { message: string } {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

async function fetchCopyRows(params: {
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
  groupBy: "copy" | "adName" | "campaign" | "adSet";
}): Promise<MetaCopiesResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    providerAccountId: params.providerAccountId,
    start: params.start,
    end: params.end,
    groupBy: params.groupBy,
    format: "all",
    sort: "spend",
  });

  const response = await fetch(`/api/meta/copies?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = hasMessage(payload)
      ? payload.message
      : `Could not load copies (${response.status}).`;
    throw new Error(message);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as MetaCopiesResponse).rows)
  ) {
    throw new Error("Invalid copies response received from backend.");
  }

  return payload as MetaCopiesResponse;
}

function modeTabStyle(active: boolean): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${active ? "var(--ink)" : "transparent"}`,
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    color: active ? "var(--ink)" : "var(--muted)",
    cursor: "pointer",
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
  };
}

function formatGeneratedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function toCsvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function exportCopiesCsv(rows: CopyMotionRow[], defaultCurrency: string | null) {
  if (typeof document === "undefined" || rows.length === 0) return;
  const header = [
    "Copy",
    "Campaign",
    "Ad Set",
    "Spend",
    "Purchase Value",
    "ROAS",
    "CPA",
    "Link CTR %",
    "Click to Purchase %",
  ];
  const body = rows.map((row) => [
    row.copyText,
    row.campaignName ?? "",
    row.adSetName ?? "",
    formatMoney(row.spend, row.currency, defaultCurrency),
    formatMoney(row.purchaseValue, row.currency, defaultCurrency),
    Number.isFinite(row.roas) ? `${row.roas.toFixed(2)}x` : "",
    formatMoney(row.cpa, row.currency, defaultCurrency),
    Number.isFinite(row.linkCtr) ? row.linkCtr.toFixed(2) : "",
    Number.isFinite(row.clickToPurchase) ? row.clickToPurchase.toFixed(2) : "",
  ]);
  const csv = [header, ...body]
    .map((line) => line.map(toCsvCell).join(","))
    .join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `copies-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function CopiesPage() {
  const searchParams = useSearchParams();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const requestedProviderAccountId =
    searchParams?.get("providerAccountId")?.trim() ?? "";
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );

  const [dateRangeValue, setDateRangeValue] = usePersistentCreativeDateRange();
  const [groupBy, setGroupBy] = useState<CreativeGroupBy>("copy");
  const [topFilters, setTopFilters] = useState<CreativeFilterRule[]>([]);
  const [topMetricIds, setTopMetricIds] = useState<string[]>(
    DEFAULT_COPY_TOP_METRIC_IDS,
  );
  const [selectionState, setSelectionState] = useState<{ selectedRowIds: string[] }>({
    selectedRowIds: [],
  });
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const hasInitializedDefaultSelectionRef = useRef(false);
  const hasUserInteractedSelectionRef = useRef(false);

  const { start: drStart, end: drEnd } = resolveCreativeDateRange(dateRangeValue);
  const copyApiGroupBy: "copy" | "adName" | "campaign" | "adSet" =
    groupBy === "copy" || groupBy === "adName" || groupBy === "campaign" || groupBy === "adSet"
      ? groupBy
      : "copy";

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const providerAccountId =
    (selectedProviderAccountId &&
    providerAccounts.some((account) => account.id === selectedProviderAccountId)
      ? selectedProviderAccountId
      : "") ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");

  useEffect(() => {
    setSelectedProviderAccountId((current) => {
      if (current && providerAccounts.some((account) => account.id === current)) {
        return current;
      }
      if (
        requestedProviderAccountId &&
        providerAccounts.some((account) => account.id === requestedProviderAccountId)
      ) {
        return requestedProviderAccountId;
      }
      return "";
    });
  }, [businessId, providerAccounts, requestedProviderAccountId]);

  const selectedProviderAccount = useMemo<MetaHistoryAccount | null>(
    () =>
      providerAccounts.find((account) => account.id === providerAccountId) ?? null,
    [providerAccountId, providerAccounts],
  );
  const accountCurrency = selectedProviderAccount?.currency ?? null;
  const hasExplicitAccountScope = Boolean(selectedBusinessId && providerAccountId);
  const routeScope = { businessId, providerAccountId };
  const libraryHref = buildMetaScopedHref(
    "/platforms/meta/creatives?tab=library",
    routeScope,
  );
  const decisionsHref = buildMetaScopedHref("/platforms/meta", routeScope);

  const copiesQuery = useQuery({
    queryKey: [
      "copies-creatives",
      businessId,
      providerAccountId,
      drStart,
      drEnd,
      copyApiGroupBy,
    ],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchCopyRows({
        businessId,
        providerAccountId,
        start: drStart,
        end: drEnd,
        groupBy: copyApiGroupBy,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  const allRows = useMemo(() => {
    return (copiesQuery.data?.rows ?? [])
      .map(mapApiRowToCopyRow)
      .filter((row) => row.accountId === providerAccountId);
  }, [copiesQuery.data?.rows, providerAccountId]);

  const filteredRows = useMemo(
    () => applyCreativeFilters(allRows, topFilters),
    [allRows, topFilters],
  );

  useEffect(() => {
    setSelectionState((prev) => {
      const filteredIds = new Set(filteredRows.map((row) => row.id));
      const kept = prev.selectedRowIds.filter((id) => filteredIds.has(id));

      if (
        !hasInitializedDefaultSelectionRef.current &&
        !hasUserInteractedSelectionRef.current &&
        kept.length === 0 &&
        filteredRows.length > 0
      ) {
        hasInitializedDefaultSelectionRef.current = true;
        return { selectedRowIds: filteredRows.slice(0, 5).map((row) => row.id) };
      }

      if (kept.length !== prev.selectedRowIds.length) {
        return { selectedRowIds: kept };
      }

      return prev;
    });
  }, [filteredRows]);

  const selectedRows = useMemo(
    () =>
      filteredRows
        .filter((row) => selectionState.selectedRowIds.includes(row.id)),
    [filteredRows, selectionState.selectedRowIds],
  );

  const topPanelRows = useMemo(
    () => (selectedRows.length > 0 ? selectedRows : filteredRows),
    [filteredRows, selectedRows],
  );

  const activeDetailRow = useMemo(
    () => filteredRows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, filteredRows],
  );

  const generatedAt = copiesQuery.data?.meta?.generatedAt ?? null;
  const generatedAtLabel = formatGeneratedAt(generatedAt);
  const unresolvedFilteredCount = copiesQuery.data?.meta?.unresolved_filtered_count ?? 0;

  const compareRows = useMemo(
    () => selectedRows.slice(0, 4) as CopyMotionRow[],
    [selectedRows],
  );
  const canCompare = compareRows.length >= 2;

  const toggleRowSelection = (rowId: string) => {
    hasUserInteractedSelectionRef.current = true;
    setSelectionState((prev) => ({
      selectedRowIds: prev.selectedRowIds.includes(rowId)
        ? prev.selectedRowIds.filter((id) => id !== rowId)
        : [...prev.selectedRowIds, rowId],
    }));
  };

  const toggleAllRows = () => {
    hasUserInteractedSelectionRef.current = true;
    const allIds = filteredRows.map((row) => row.id);
    setSelectionState((prev) => ({
      selectedRowIds: allIds.every((id) => prev.selectedRowIds.includes(id))
        ? []
        : allIds,
    }));
  };

  const handleCsvExport = () =>
    exportCopiesCsv(filteredRows as CopyMotionRow[], accountCurrency);

  const hasData =
    hasExplicitAccountScope &&
    !copiesQuery.isLoading &&
    !copiesQuery.isError &&
    filteredRows.length > 0;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div
        className="ad-final"
        data-testid="copies-studio-page"
        data-copies-query-status={copiesQuery.status}
        data-copies-fetch-status={copiesQuery.fetchStatus}
      >
        {/* ===== Creative Studio header — two-layer chrome (context + mode switch) ===== */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-lg)",
            overflow: "hidden",
          }}
        >
          {/* Layer 1 — context bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="crumbs">
                Platforms · Meta · <b>Copies</b>
              </div>
              <h1 className="page-title">Creative Studio</h1>
            </div>
            <span
              className="chip"
              style={{
                height: "auto",
                padding: "3px 10px",
                border: "1px solid var(--border)",
                color: "var(--muted)",
              }}
            >
              Analysis only — decisions live in{" "}
              <Link href={decisionsHref} style={{ color: "var(--brand)", fontWeight: 600 }}>
                Decisions
              </Link>
            </span>
            <div style={{ flex: 1 }} />
            <label className="chip" style={{ height: 32, gap: 7 }}>
              Ad account
              <select
                aria-label="Meta ad account for Copy analysis"
                value={providerAccountId}
                disabled={providerAccountsQuery.isLoading}
                onChange={(event) => {
                  const nextProviderAccountId = event.currentTarget.value;
                  if (typeof window !== "undefined") {
                    const url = new URL(window.location.href);
                    if (nextProviderAccountId) {
                      url.searchParams.set("providerAccountId", nextProviderAccountId);
                    } else {
                      url.searchParams.delete("providerAccountId");
                    }
                    window.history.replaceState(null, "", url);
                  }
                  setSelectedProviderAccountId(nextProviderAccountId);
                }}
                style={{
                  maxWidth: 220,
                  border: 0,
                  background: "transparent",
                  color: "var(--ink)",
                  outline: "none",
                }}
              >
                <option value="">
                  {providerAccountsQuery.isLoading
                    ? "Loading accounts"
                    : providerAccounts.length === 0
                      ? "No assigned account"
                      : "Select account"}
                </option>
                {providerAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name ?? account.id}
                    {account.currency ? ` · ${account.currency}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ textAlign: "right", lineHeight: 1.5 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                window {drStart} → {drEnd}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--muted-2)" }}>
                {generatedAtLabel ? `data as of ${generatedAtLabel}` : "as-of —"}
              </div>
            </div>
          </div>

          {/* Layer 2 — mode switch + affordances */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 12px",
              flexWrap: "wrap",
            }}
          >
            <Link href={libraryHref} style={modeTabStyle(false)}>
              Assets
            </Link>
            <span aria-current="page" style={modeTabStyle(true)}>
              Copy
            </span>
            <Link href={buildMetaScopedHref("/platforms/meta/landing-pages", routeScope)} style={modeTabStyle(false)}>
              Landing pages
            </Link>
            <Link href={buildMetaScopedHref("/platforms/meta/creative-inbox", routeScope)} style={modeTabStyle(false)}>
              Inbox
            </Link>
            <Link href={buildMetaScopedHref("/platforms/meta/audiences", routeScope)} style={modeTabStyle(false)}>
              Audiences
            </Link>
            <button
              type="button"
              onClick={() => setCompareOpen(true)}
              disabled={!canCompare}
              title={canCompare ? undefined : "Select 2 or more copies to compare"}
              style={{
                ...modeTabStyle(false),
                opacity: canCompare ? 1 : 0.5,
                cursor: canCompare ? "pointer" : "not-allowed",
              }}
            >
              Compare
              <span
                className="tabular-nums"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  minWidth: 18,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "var(--surface-3)",
                  color: "var(--ink-3)",
                  textAlign: "center",
                }}
              >
                {compareRows.length}
              </span>
            </button>
            <span
              title="Angle pivots need ai_tags in the copies payload"
              style={{ ...modeTabStyle(false), cursor: "default" }}
            >
              Angles
              <span className="chip chip--auto" style={{ height: 16, padding: "0 6px", fontSize: 12 }}>
                needs server contract
              </span>
            </span>
            <span
              title="The copies payload holds a single context today"
              style={{ ...modeTabStyle(false), cursor: "default" }}
            >
              Usage Map
              <span className="chip chip--auto" style={{ height: 16, padding: "0 6px", fontSize: 12 }}>
                needs server contract
              </span>
            </span>
            <div style={{ flex: 1 }} />
            {unresolvedFilteredCount > 0 ? (
              <span
                style={{ fontSize: 11, color: "var(--warn)" }}
                data-testid="copies-data-meta"
              >
                {unresolvedFilteredCount} ad{unresolvedFilteredCount === 1 ? "" : "s"} hidden (copy
                text could not be resolved)
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleCsvExport}
              disabled={filteredRows.length === 0}
            >
              CSV
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled
              title="Frozen copy-snapshot sharing needs a server contract"
            >
              Share
            </button>
          </div>

        </div>

        {/* ===== Group-by + selected-copy cards (real briefing controls) ===== */}
        {hasExplicitAccountScope ? <div style={{ marginTop: 14 }}>
          <CreativesTopSection
            showHeader={false}
            title="Copy performance"
            description="Compare measured ad-text outcomes by the selected scope. Copy rows do not receive winner or action labels without a server decision contract."
            dateRange={dateRangeValue}
            onDateRangeChange={setDateRangeValue}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            groupByOptions={COPY_GROUP_OPTIONS}
            filters={topFilters}
            onFiltersChange={setTopFilters}
            selectedMetricIds={topMetricIds}
            onSelectedMetricIdsChange={setTopMetricIds}
            selectedRows={topPanelRows}
            allRowsForHeatmap={filteredRows}
            defaultCurrency={accountCurrency}
            previewMode="copy"
            getPreviewCopyText={(row) => (row as CopyMotionRow).copyText}
            onOpenRow={(rowId) => setDetailRowId(rowId)}
            onShareExport={() => undefined}
            onCsvExport={handleCsvExport}
          />
        </div> : null}

        {providerAccountsQuery.isError ? (
          <div style={{ marginTop: 14 }}>
            <ErrorState
              title="Could not load Meta accounts"
              description={
                providerAccountsQuery.error instanceof Error
                  ? providerAccountsQuery.error.message
                  : "Assigned Meta accounts could not load."
              }
              onRetry={() => providerAccountsQuery.refetch()}
            />
          </div>
        ) : !providerAccountsQuery.isLoading && !providerAccountId ? (
          <div
            className="rounded-[var(--r)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-4 text-sm text-[var(--warn)]"
            data-testid="copies-account-required"
          >
            Select one assigned Meta ad account. Copy metrics and currency remain withheld until the provider scope is explicit.
          </div>
        ) : copiesQuery.isLoading && (
          <div style={{ marginTop: 14 }}>
            <LoadingSkeleton rows={5} />
          </div>
        )}

        {copiesQuery.isError && (
          <div style={{ marginTop: 14 }}>
            <ErrorState
              title="Could not load copies"
              description={
                copiesQuery.error instanceof Error
                  ? copiesQuery.error.message
                  : "Could not load copy performance data."
              }
              onRetry={() => copiesQuery.refetch()}
            />
          </div>
        )}

        {hasExplicitAccountScope && !copiesQuery.isLoading && !copiesQuery.isError && filteredRows.length === 0 && (
          <div style={{ marginTop: 14 }}>
            <EmptyState
              title="No copy performance data found for the selected range"
              description="Try a wider date range or adjust filters to inspect copy performance."
            />
          </div>
        )}

        {hasData && (
          <>
            <div style={{ marginTop: 14 }}>
              <CreativesTableSection
                rows={filteredRows}
                initialPresetName="Meta Copy Performance"
                selectedMetricIds={topMetricIds}
                onSelectedMetricIdsChange={setTopMetricIds}
                selectedRowIds={selectionState.selectedRowIds}
                defaultCurrency={accountCurrency}
                onToggleRow={toggleRowSelection}
                onToggleAll={toggleAllRows}
                onOpenRow={(rowId) => setDetailRowId(rowId)}
              />
            </div>
            <HeatLegendFooter
              visibleCount={filteredRows.length}
              selectedCount={selectedRows.length}
            />
          </>
        )}

        {activeDetailRow ? (
          <CopyDetailDrawer
            row={activeDetailRow as CopyMotionRow}
            defaultCurrency={accountCurrency}
            onClose={() => setDetailRowId(null)}
          />
        ) : null}

        {compareOpen && canCompare ? (
          <CopyCompareOverlay
            rows={compareRows}
            defaultCurrency={accountCurrency}
            onClose={() => setCompareOpen(false)}
          />
        ) : null}
      </div>
    </PlanGate>
  );
}

function HeatLegendFooter({
  visibleCount,
  selectedCount,
}: {
  visibleCount: number;
  selectedCount: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        marginTop: 10,
        fontSize: 11,
        color: "var(--muted)",
      }}
    >
      <span>Heat vs table baseline:</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: "var(--ok-bg)", border: "1px solid var(--ok-bd)" }} />
        above
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: "var(--surface-3)", border: "1px solid var(--border-2)" }} />
        near
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: "var(--danger-bg)", border: "1px solid var(--danger-bd)" }} />
        below
      </span>
      <div style={{ flex: 1 }} />
      <span>
        {visibleCount} visible · {selectedCount} selected · copy rows carry no decision labels by
        contract
      </span>
    </div>
  );
}

function DrawerField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, letterSpacing: "0.03em" }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{children}</div>
    </div>
  );
}

function CopyDetailDrawer({
  row,
  defaultCurrency,
  onClose,
}: {
  row: CopyMotionRow;
  defaultCurrency: string | null;
  onClose: () => void;
}) {
  const money = (value: number) => formatMoney(value, row.currency, defaultCurrency);
  const roas = Number.isFinite(row.roas) ? `${row.roas.toFixed(2)}x` : "—";
  const dash = (value: string | null | undefined) =>
    value && value.trim().length > 0 ? value : "—";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        className="absolute inset-0"
        style={{ background: "rgba(16,18,22,0.4)" }}
        onClick={onClose}
        aria-label="Close drawer overlay"
      />
      <aside
        className="ad-final"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          height: "100%",
          width: "min(380px, 92vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border-2)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
        }}
        data-testid="copy-detail-drawer"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Copy detail</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <pre
            style={{
              margin: 0,
              fontFamily: "inherit",
              fontSize: 12.5,
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r)",
              padding: "11px 13px",
            }}
          >
            {row.copyText}
          </pre>

          <DrawerField label="VARIANTS">
            headline: “{dash(row.copyHeadline)}” · description: “{dash(row.copyDescription)}”
          </DrawerField>

          <DrawerField label="PROVENANCE">
            copy_asset_type: {dash(row.copyAssetType)} · copy_source: {dash(row.copySource)}
          </DrawerField>

          <DrawerField label="USED IN">
            <span className="tabular-nums">
              {dash(row.campaignName)} · {dash(row.adSetName)}
            </span>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
              {row.copyVariants?.length ?? 0} copy variant
              {(row.copyVariants?.length ?? 0) === 1 ? "" : "s"} · {row.headlineVariants?.length ?? 0}{" "}
              headline · {row.descriptionVariants?.length ?? 0} description
            </div>
          </DrawerField>

          <DrawerField label="MEASURED METRICS">
            <div className="tabular-nums" style={{ display: "grid", gap: 3 }}>
              <span>spend {money(row.spend)} · purchase value {money(row.purchaseValue)}</span>
              <span>
                ROAS {roas} · CPA {money(row.cpa)} · link CTR{" "}
                {Number.isFinite(row.linkCtr) ? `${row.linkCtr.toFixed(2)}%` : "—"}
              </span>
              <span>
                click→purchase{" "}
                {Number.isFinite(row.clickToPurchase) ? `${row.clickToPurchase.toFixed(2)}%` : "—"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              per-context (prospecting / retargeting) breakdown ships when the copies payload carries
              it — never faked.
            </div>
          </DrawerField>

          {(row.tags ?? []).length > 0 ? (
            <DrawerField label="TAGS">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(row.tags ?? []).map((tag) => (
                  <span key={tag} className="chip chip--ghost" style={{ textTransform: "capitalize" }}>
                    {tag}
                  </span>
                ))}
              </div>
            </DrawerField>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function CopyCompareOverlay({
  rows,
  defaultCurrency,
  onClose,
}: {
  rows: CopyMotionRow[];
  defaultCurrency: string | null;
  onClose: () => void;
}) {
  const baseline = rows[0];
  const money = (row: CopyMotionRow, value: number) =>
    formatMoney(value, row.currency, defaultCurrency);

  const roasDelta = (row: CopyMotionRow) => {
    if (row === baseline) return { text: "baseline", tone: "muted" as const };
    if (!Number.isFinite(row.roas) || !Number.isFinite(baseline.roas)) {
      return { text: "", tone: "muted" as const };
    }
    const diff = row.roas - baseline.roas;
    return {
      text: `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)}x`,
      tone: diff >= 0 ? ("pos" as const) : ("neg" as const),
    };
  };

  const cpaDelta = (row: CopyMotionRow) => {
    if (row === baseline) return { text: "baseline", tone: "muted" as const };
    if (!Number.isFinite(row.cpa) || !Number.isFinite(baseline.cpa) || baseline.cpa === 0) {
      return { text: "", tone: "muted" as const };
    }
    const diff = row.cpa - baseline.cpa;
    // Higher CPA is worse.
    return {
      text: `${diff >= 0 ? "+" : "−"}${money(row, Math.abs(diff))}`,
      tone: diff > 0 ? ("neg" as const) : diff < 0 ? ("pos" as const) : ("muted" as const),
    };
  };

  const spendDelta = (row: CopyMotionRow) => {
    if (row === baseline) return { text: "baseline", tone: "muted" as const };
    if (!Number.isFinite(row.spend) || !Number.isFinite(baseline.spend) || baseline.spend === 0) {
      return { text: "", tone: "muted" as const };
    }
    const pct = Math.round(((row.spend - baseline.spend) / baseline.spend) * 100);
    return { text: `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`, tone: "muted" as const };
  };

  const pctDelta = (row: CopyMotionRow, key: "linkCtr" | "clickToPurchase") => {
    if (row === baseline) return { text: "baseline", tone: "muted" as const };
    const value = row[key];
    const base = baseline[key];
    if (!Number.isFinite(value) || !Number.isFinite(base)) {
      return { text: "", tone: "muted" as const };
    }
    const diff = value - base;
    return {
      text: `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(2)}pt`,
      tone: diff >= 0 ? ("pos" as const) : ("neg" as const),
    };
  };

  const toneColor = (tone: "pos" | "neg" | "muted") =>
    tone === "pos" ? "var(--ok)" : tone === "neg" ? "var(--danger)" : "var(--muted)";

  const metricRows: Array<{
    key: string;
    label: string;
    value: (row: CopyMotionRow) => string;
    delta: (row: CopyMotionRow) => { text: string; tone: "pos" | "neg" | "muted" };
  }> = [
    {
      key: "spend",
      label: "Spend",
      value: (row) => money(row, row.spend),
      delta: spendDelta,
    },
    {
      key: "pv",
      label: "Purchase value",
      value: (row) => money(row, row.purchaseValue),
      delta: (row) => ({ text: row === baseline ? "baseline" : "", tone: "muted" }),
    },
    {
      key: "roas",
      label: "ROAS",
      value: (row) => (Number.isFinite(row.roas) ? `${row.roas.toFixed(2)}x` : "—"),
      delta: roasDelta,
    },
    {
      key: "cpa",
      label: "CPA",
      value: (row) => money(row, row.cpa),
      delta: cpaDelta,
    },
    {
      key: "linkCtr",
      label: "Link CTR",
      value: (row) => (Number.isFinite(row.linkCtr) ? `${row.linkCtr.toFixed(2)}%` : "—"),
      delta: (row) => pctDelta(row, "linkCtr"),
    },
    {
      key: "c2p",
      label: "Click → purchase",
      value: (row) =>
        Number.isFinite(row.clickToPurchase) ? `${row.clickToPurchase.toFixed(2)}%` : "—",
      delta: (row) => pctDelta(row, "clickToPurchase"),
    },
  ];

  const gridColumns = `140px repeat(${rows.length}, minmax(0, 1fr))`;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(16,18,22,0.4)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="ad-final"
        onClick={(event) => event.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-lg)",
          width: 900,
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflowY: "auto",
          padding: 20,
        }}
        data-testid="copy-compare-overlay"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div>
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              Compare · {rows.length} {rows.length === 1 ? "copy" : "copies"}
            </span>{" "}
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              · review-only — deltas vs the first column · account currency per column
            </span>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close compare">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: gridColumns, gap: 10, alignItems: "start" }}>
          <div />
          {rows.map((row) => (
            <div key={`head-${row.id}`} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {row.copyText}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
                {row.campaignName ?? "—"}
              </div>
            </div>
          ))}

          {metricRows.map((metric) => (
            <div key={metric.key} style={{ display: "contents" }}>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--muted)",
                  padding: "8px 0",
                  borderTop: "1px solid var(--border)",
                }}
              >
                {metric.label}
              </div>
              {rows.map((row) => {
                const delta = metric.delta(row);
                return (
                  <div
                    key={`${metric.key}-${row.id}`}
                    className="tabular-nums"
                    style={{
                      fontSize: 12.5,
                      padding: "8px 0",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <b style={{ fontWeight: 600 }}>{metric.value(row)}</b>{" "}
                    {delta.text ? (
                      <span style={{ fontSize: 12, color: toneColor(delta.tone) }}>{delta.text}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
          Deltas vs the first column (baseline). Ranking omitted — not server-supplied for this set.
        </div>
      </div>
    </div>
  );
}
