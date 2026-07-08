"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, ImageIcon, Info, X } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import {
  applyCreativeFilters,
  DEFAULT_TOP_METRIC_IDS,
  type CreativeFilterRule,
  type CreativeGroupBy,
  CreativesTopSection,
  getCreativeMetricDefinition,
  resolveCreativeDateRange,
} from "@/components/creatives/CreativesTopSection";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import { hasCreativeVideoEvidence } from "@/components/creatives/creative-truth";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { PlanGate } from "@/components/pricing/PlanGate";
import { usePersistentCreativeDateRange } from "@/hooks/use-persistent-date-range";
import { useAppStore } from "@/store/app-store";
import type { ShareMetricKey } from "@/components/creatives/shareCreativeTypes";
import {
  SHARE_METRIC_IDS,
  fetchCreativeDecisionEngineV3,
  fetchMetaCreatives,
  hasRenderablePreview,
  mapApiRowToUiRow,
  toCsv,
  toSharedCreative,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";

const DECISIONS_HREF = "/platforms/meta";
const COPY_HREF = "/platforms/meta/copies";
const LANDING_PAGES_HREF = "/platforms/meta/landing-pages";
const INBOX_HREF = "/platforms/meta/creative-inbox";
const AUDIENCES_HREF = "/platforms/meta/audiences";

function creativeGroupByToApi(value: CreativeGroupBy): "adName" | "ad" | "creative" | "adSet" {
  if (value === "adName" || value === "creative" || value === "adSet") return value;
  return "creative";
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number | null | undefined, digits = 0) {
  const numeric = finite(value);
  return numeric === null ? "--" : numeric.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatRoas(value: number | null | undefined) {
  const numeric = finite(value);
  return numeric === null ? "--" : `${numeric.toFixed(2)}x`;
}

function supportedShareMetrics(ids: string[]): ShareMetricKey[] {
  const next = ids.filter((id): id is ShareMetricKey => SHARE_METRIC_IDS.has(id as ShareMetricKey));
  return next.length > 0 ? next : ["spend", "roas", "purchases"];
}

function currencySet(rows: MetaCreativeRow[], defaultCurrency: string | null) {
  return Array.from(
    new Set(
      rows
        .map((row) => resolveCreativeCurrency(row.currency ?? null, defaultCurrency))
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();
}

function spendSummary(rows: MetaCreativeRow[], defaultCurrency: string | null) {
  const currencies = currencySet(rows, defaultCurrency);
  if (rows.length === 0) return "--";
  if (currencies.length !== 1) return "Mixed currencies";
  const total = rows.reduce((sum, row) => sum + row.spend, 0);
  return formatMoney(total, currencies[0], defaultCurrency);
}

export default function MetaCreativeStudioPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const businessId = selectedBusinessId ?? "";
  const selectedBusinessCurrency =
    businesses.find((business) => business.id === selectedBusinessId)?.currency ?? null;

  const [dateRangeValue, setDateRangeValue] = usePersistentCreativeDateRange();
  const [groupBy, setGroupBy] = useState<CreativeGroupBy>("creative");
  const [topFilters, setTopFilters] = useState<CreativeFilterRule[]>([]);
  const [topMetricIds, setTopMetricIds] = useState<string[]>(DEFAULT_TOP_METRIC_IDS);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [detailNotes, setDetailNotes] = useState("");
  const [sortedRows, setSortedRows] = useState<MetaCreativeRow[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareAudience, setShareAudience] = useState<"buyer" | "creative_team" | "external">("buyer");
  const [anonymize, setAnonymize] = useState(true);
  const [allowCsv, setAllowCsv] = useState(true);
  const hasInitializedDefaultSelectionRef = useRef(false);
  const hasUserInteractedSelectionRef = useRef(false);

  const { start: drStart, end: drEnd } = resolveCreativeDateRange(dateRangeValue);
  const apiGroupBy = creativeGroupByToApi(groupBy);

  const creativesQuery = useQuery({
    queryKey: ["meta-creative-studio", businessId, drStart, drEnd, apiGroupBy],
    enabled: Boolean(selectedBusinessId),
    queryFn: () =>
      fetchMetaCreatives({
        businessId,
        start: drStart,
        end: drEnd,
        groupBy: apiGroupBy,
        format: "all",
        sort: "spend",
        mediaMode: "full",
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  // Real server-truth creative decisions (Engine v3). Creative Studio stays "analysis
  // only" — these labels are context, not execution — but they were previously never
  // fetched, so the decision surface rendered empty. Wire the live source; honesty gates
  // (missing → no badge, engine-disabled → null) are enforced downstream.
  const decisionsQuery = useQuery({
    queryKey: ["meta-creative-decisions-v3", businessId, drEnd],
    enabled: Boolean(selectedBusinessId),
    queryFn: () => fetchCreativeDecisionEngineV3({ businessId, asOf: drEnd }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const decisionResponse = decisionsQuery.data ?? null;
  const v3Decisions =
    decisionResponse && decisionResponse.status !== "disabled"
      ? decisionResponse.decisions
      : null;
  const v3Flags = decisionResponse?.flags ?? null;
  // Buyer-decision-language overlay (reference "02 Creative Studio"): off by default —
  // Creative Studio stays analysis-only; toggling reveals the server DECISION column.
  const [buyerDecisionLanguage, setBuyerDecisionLanguage] = useState(false);

  const allRows = useMemo(
    () => (creativesQuery.data?.rows ?? []).map(mapApiRowToUiRow),
    [creativesQuery.data?.rows],
  );

  const filteredRows = useMemo(
    () => applyCreativeFilters(allRows, topFilters),
    [allRows, topFilters],
  );

  useEffect(() => {
    setSelectedRowIds((previous) => {
      const visibleIds = new Set(filteredRows.map((row) => row.id));
      const kept = previous.filter((id) => visibleIds.has(id));
      if (
        !hasInitializedDefaultSelectionRef.current &&
        !hasUserInteractedSelectionRef.current &&
        kept.length === 0 &&
        filteredRows.length > 0
      ) {
        hasInitializedDefaultSelectionRef.current = true;
        return filteredRows.slice(0, 5).map((row) => row.id);
      }
      return kept.length === previous.length ? previous : kept;
    });
  }, [filteredRows]);

  const selectedRows = useMemo(
    () => filteredRows.filter((row) => selectedRowIds.includes(row.id)),
    [filteredRows, selectedRowIds],
  );

  const topPanelRows = selectedRows.length > 0 ? selectedRows : filteredRows.slice(0, 8);
  const activeDetailRow = useMemo(
    () => filteredRows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, filteredRows],
  );
  const tableRows = sortedRows.length > 0 ? sortedRows : filteredRows;
  const previewReadyCount = filteredRows.filter(hasRenderablePreview).length;
  const previewSummary = creativesQuery.data?.preview_coverage
    ? {
        total: creativesQuery.data.preview_coverage.totalCreatives,
        ready: creativesQuery.data.preview_coverage.previewReadyCount,
        pending: creativesQuery.data.preview_coverage.previewWaitingCount,
        missing: creativesQuery.data.preview_coverage.previewMissingCount,
        minimumReady: 1,
      }
    : {
        total: filteredRows.length,
        ready: previewReadyCount,
        pending: 0,
        missing: Math.max(0, filteredRows.length - previewReadyCount),
        minimumReady: 1,
      };
  const previewStripState =
    creativesQuery.isLoading || creativesQuery.isFetching
      ? "data_loading"
      : previewSummary.ready > 0
        ? "ready"
        : "missing";
  const visibleCurrencies = currencySet(filteredRows, selectedBusinessCurrency);
  const meanRoas = useMemo(() => {
    const values = filteredRows
      .map((row) => finite(row.roas))
      .filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [filteredRows]);
  const compareTotals = useMemo(
    () => ({
      totalSpend: filteredRows.reduce((sum, row) => sum + row.spend, 0),
      totalPurchaseValue: filteredRows.reduce((sum, row) => sum + row.purchaseValue, 0),
    }),
    [filteredRows],
  );
  const compareRows = useMemo(() => selectedRows.slice(0, 3), [selectedRows]);

  const toggleRowSelection = (rowId: string) => {
    hasUserInteractedSelectionRef.current = true;
    setSelectedRowIds((previous) =>
      previous.includes(rowId) ? previous.filter((id) => id !== rowId) : [...previous, rowId],
    );
  };

  const toggleAllRows = () => {
    hasUserInteractedSelectionRef.current = true;
    const allIds = filteredRows.map((row) => row.id);
    setSelectedRowIds((previous) =>
      allIds.every((id) => previous.includes(id)) ? [] : allIds,
    );
  };

  const handleCsvExport = () => {
    if (typeof document === "undefined") return;
    setCsvError(null);
    setCsvLoading(true);
    try {
      const csv = toCsv(tableRows);
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `creative-studio-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (error) {
      setCsvError(error instanceof Error ? error.message : "CSV export failed.");
    } finally {
      setCsvLoading(false);
    }
  };

  // Creative Studio share is now audience-aware: the toolbar Share action opens a
  // preset modal instead of firing a hardcoded creative_team POST. The real POST
  // still carries backend-supported ShareLinkConfig fields (audience, campaign-name
  // anonymization, CSV permission, decision language) — no fabricated config.
  const openShareModal = () => {
    setShareError(null);
    setShareModalOpen(true);
  };

  const submitShare = async (): Promise<string | null> => {
    setShareError(null);
    setShareLoading(true);
    try {
      const rows = selectedRows.length > 0 ? selectedRows : tableRows.slice(0, 12);
      if (rows.length === 0) throw new Error("Select at least one creative or load visible rows first.");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      // Creative-team / external presets structurally remove decision language at
      // create-time; only the buyer preset may carry it, and only when the buyer
      // decision-language toggle is already on. Never invent decision state.
      const includeDecisionLanguage = shareAudience === "buyer" && buyerDecisionLanguage;
      const response = await fetch("/api/creatives/share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title: "Creative Studio snapshot",
          businessId,
          dateRange: `${drStart} - ${drEnd}`,
          expiresAt,
          metrics: supportedShareMetrics(topMetricIds),
          includeNotes: false,
          audience: shareAudience,
          presetId: "creative-studio",
          presetLabel: "Creative Studio",
          includeCampaignNames: !anonymize,
          includeDecisionLanguage,
          allowCsv,
          snapshotOnly: true,
          filters: ["Creative Studio", selectedRows.length > 0 ? "selected rows" : "visible rows"],
          selectedRowIds: rows.map((row) => row.id),
          totalRows: filteredRows.length,
          creatives: rows.map((row) => toSharedCreative(row)),
        }),
      });
      const payload = (await response.json().catch(() => null)) as { url?: string; message?: string } | null;
      if (!response.ok || !payload?.url) {
        throw new Error(payload?.message ?? "Share link could not be created.");
      }
      setShareUrl(payload.url);
      return payload.url;
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Share link could not be created.");
      return null;
    } finally {
      setShareLoading(false);
    }
  };

  const handleShareCopyLink = async () => {
    const url = await submitShare();
    if (url && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url).catch(() => {});
    }
  };

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div className="ad-final ad-studio-console px-4 py-4" data-testid="creative-studio-page">
        {/*
          Scoped reference-token migration for the Creative Studio surface.
          CreativesTopSection / CreativesTableSection are shared (copies,
          CreativeDetailExperience) and use raw neutral-* Tailwind, so instead of
          blind-editing 4600 lines we remap their palette/radius/font to the
          reference (--adc / IBM Plex) ONLY within this page's scope. Unlayered
          rules outrank Tailwind's @layer utilities, so no !important is needed.
          Interim: the structural table grammar / DECISION column / drawer /
          compare / share still need real component work.
        */}
        <style>{`
          .ad-studio-console { font-family: var(--font-ibm-plex-sans), system-ui, sans-serif; }
          .ad-studio-console .mono, .ad-studio-console .font-mono, .ad-studio-console .tabular-nums {
            font-family: var(--font-ibm-plex-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
          }
          .ad-studio-console .bg-white { background-color: #ffffff; }
          .ad-studio-console .bg-neutral-50 { background-color: #f5f5f3; }
          .ad-studio-console .bg-neutral-100 { background-color: #ededea; }
          .ad-studio-console .border-neutral-100 { border-color: #ededea; }
          .ad-studio-console .border-neutral-200 { border-color: #e4e4e0; }
          .ad-studio-console .border-neutral-300 { border-color: #cdcdc7; }
          .ad-studio-console .text-neutral-400 { color: #7d838c; }
          .ad-studio-console .text-neutral-500 { color: #7d838c; }
          .ad-studio-console .text-neutral-600 { color: #4a4f56; }
          .ad-studio-console .text-neutral-700 { color: #4a4f56; }
          .ad-studio-console .text-neutral-800 { color: #1a1c1f; }
          .ad-studio-console .text-neutral-900 { color: #1a1c1f; }
          .ad-studio-console .rounded-xl { border-radius: 8px; }
          .ad-studio-console .rounded-lg { border-radius: 8px; }
          .ad-studio-console .rounded-md { border-radius: 6px; }
        `}</style>
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
          <header className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="crumbs">
                  Platforms · <b>Meta</b>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <h1 className="page-title">Creative Studio</h1>
                  <span className="chip chip--info">
                    <Info className="h-3.5 w-3.5" />
                    Analysis only - decisions live in <Link href={DECISIONS_HREF}>Decisions</Link>
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                <span className="mono">window {drStart} to {drEnd}</span>
                <span className="chip chip--ghost">
                  currency {visibleCurrencies.length === 0 ? "--" : visibleCurrencies.join(", ")}
                </span>
                <label
                  className="chip chip--ghost cursor-pointer select-none"
                  title="Reveal the server decision label per creative in the table. Analysis only — execution stays in Decisions."
                >
                  <input
                    type="checkbox"
                    checked={buyerDecisionLanguage}
                    onChange={(event) => setBuyerDecisionLanguage(event.target.checked)}
                    className="mr-1.5 align-middle accent-[var(--adc-ink,#1a1c1f)]"
                  />
                  buyer decision language
                </label>
                <Link className="btn btn--sm" href={DECISIONS_HREF}>
                  Decisions
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
            <nav className="flex flex-wrap items-center gap-1 border-t border-[var(--adc-b1,#e4e4e0)] px-3 [font-family:var(--font-ibm-plex-sans)]">
              <span
                className="border-b-2 border-[var(--adc-ink,#1a1c1f)] px-3 py-2 text-[12.5px] font-semibold text-[var(--adc-ink,#1a1c1f)]"
                aria-current="page"
              >
                Library
              </span>
              <Link className="border-b-2 border-transparent px-3 py-2 text-[12.5px] text-[var(--adc-ink2,#4a4f56)] hover:text-[var(--adc-ink,#1a1c1f)]" href={COPY_HREF}>Copy</Link>
              <Link className="border-b-2 border-transparent px-3 py-2 text-[12.5px] text-[var(--adc-ink2,#4a4f56)] hover:text-[var(--adc-ink,#1a1c1f)]" href={LANDING_PAGES_HREF}>Landing pages</Link>
              <Link className="border-b-2 border-transparent px-3 py-2 text-[12.5px] text-[var(--adc-ink2,#4a4f56)] hover:text-[var(--adc-ink,#1a1c1f)]" href={INBOX_HREF}>Inbox</Link>
              <Link className="border-b-2 border-transparent px-3 py-2 text-[12.5px] text-[var(--adc-ink2,#4a4f56)] hover:text-[var(--adc-ink,#1a1c1f)]" href={AUDIENCES_HREF}>Audiences</Link>
              <span className="ml-2 inline-flex items-center gap-1.5 self-center rounded-[4px] border border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--adc-auto-fg,#6c41be)]" title="Angles need the ai_tags pivot contract before they become executable.">
                Angles · needs server contract
              </span>
              <span className="inline-flex items-center gap-1.5 self-center rounded-[4px] border border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--adc-auto-fg,#6c41be)]" title="Usage Map needs multi-context payloads before it can be shown honestly.">
                Usage Map · needs server contract
              </span>
            </nav>
          </header>

          <section
            className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#fff)] px-4 py-2.5 text-[12.5px] text-[var(--adc-ink2,#4a4f56)] [font-family:var(--font-ibm-plex-sans)]"
            data-testid="studio-metric-strip"
          >
            <span>
              Creatives{" "}
              <b className="font-semibold tabular-nums text-[var(--adc-ink,#1a1c1f)] [font-family:var(--font-ibm-plex-mono)]">
                {formatNumber(filteredRows.length)}
              </b>
            </span>
            <span className="h-3.5 w-px bg-[var(--adc-b1,#e4e4e0)]" aria-hidden="true" />
            <span>
              Spend{" "}
              <b className="font-semibold tabular-nums text-[var(--adc-ink,#1a1c1f)] [font-family:var(--font-ibm-plex-mono)]">
                {spendSummary(filteredRows, selectedBusinessCurrency)}
              </b>
            </span>
            <span className="h-3.5 w-px bg-[var(--adc-b1,#e4e4e0)]" aria-hidden="true" />
            <span>
              Mean ROAS{" "}
              <b className="font-semibold tabular-nums text-[var(--adc-ink,#1a1c1f)] [font-family:var(--font-ibm-plex-mono)]">
                {formatRoas(meanRoas)}
              </b>
            </span>
            <span className="ml-auto text-[11px] text-[var(--adc-ink3,#7d838c)] [font-family:var(--font-ibm-plex-mono)]">
              {formatNumber(selectedRows.length)} selected · preview {previewSummary.ready}/{previewSummary.total} · currency{" "}
              {visibleCurrencies.length === 0 ? "—" : visibleCurrencies.join(", ")}
            </span>
          </section>

          <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <CreativesTopSection
              businessId={businessId}
              showHeader={false}
              v3Decisions={v3Decisions}
              v3Flags={v3Flags}
              title="Creative Library"
              description="Inspect creative assets, sortable metrics, taxonomy, copy, and shareable evidence without issuing ad actions."
              dateRange={dateRangeValue}
              onDateRangeChange={setDateRangeValue}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              filters={topFilters}
              onFiltersChange={setTopFilters}
              selectedMetricIds={topMetricIds}
              onSelectedMetricIdsChange={setTopMetricIds}
              selectedRows={topPanelRows}
              allRowsForHeatmap={filteredRows}
              defaultCurrency={selectedBusinessCurrency}
              onOpenRow={(rowId) => setDetailRowId(rowId)}
              onShareExport={openShareModal}
              onCsvExport={handleCsvExport}
              shareExportLoading={shareLoading}
              csvExportLoading={csvLoading}
              shareUrl={shareUrl}
              shareError={shareError}
              csvError={csvError}
              previewStripState={previewStripState}
              previewStripSummary={previewSummary}
              belowToolbar={
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
                  <span className="chip chip--ghost">Gallery and table use the same visible rows</span>
                  <span className="chip chip--ghost">Decision labels are context only</span>
                  <span className="chip chip--ghost">Ad actions stay in Decisions or Launchpad</span>
                </div>
              }
            />
          </section>

          {creativesQuery.isLoading ? (
            <LoadingSkeleton rows={6} />
          ) : creativesQuery.isError ? (
            <ErrorState
              title="Could not load creative library"
              description={
                creativesQuery.error instanceof Error
                  ? creativesQuery.error.message
                  : "Could not load creative performance data."
              }
              onRetry={() => creativesQuery.refetch()}
            />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              title="No creatives found for this scope"
              description="Try a wider date range or remove filters. Missing data is not replaced with zero rows."
            />
          ) : (
            <CreativesTableSection
              rows={filteredRows}
              initialPresetName="Creative Studio"
              selectedMetricIds={topMetricIds}
              onSelectedMetricIdsChange={setTopMetricIds}
              selectedRowIds={selectedRowIds}
              defaultCurrency={selectedBusinessCurrency}
              v3Decisions={v3Decisions}
              v3Flags={v3Flags}
              buyerDecisionLanguage={buyerDecisionLanguage}
              onToggleRow={toggleRowSelection}
              onToggleAll={toggleAllRows}
              onOpenRow={(rowId) => setDetailRowId(rowId)}
              onSortedRowsChange={setSortedRows}
            />
          )}

          {!creativesQuery.isLoading && !creativesQuery.isError && filteredRows.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#fff)] px-4 py-2.5 text-[11px] text-[var(--adc-ink3,#7d838c)] [font-family:var(--font-ibm-plex-sans)]"
              data-testid="studio-compare-footer"
            >
              <span>
                Showing {filteredRows.length} of {allRows.length} active creatives · CSV export matches
                on-screen labels · video metrics blank without video evidence
              </span>
              <div className="flex-1" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setCompareOpen(true)}
                disabled={selectedRows.length < 2}
                className="rounded-[6px] border border-[var(--adc-b2,#cdcdc7)] bg-transparent px-2.5 py-1 text-[11.5px] text-[var(--adc-ink,#1a1c1f)] transition-colors hover:bg-[var(--adc-s3,#ededea)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
              >
                Compare {selectedRows.length} selected
              </button>
            </div>
          ) : null}

          <ReadOnlyCreativeDrawer
            businessId={businessId}
            row={activeDetailRow}
            notes={detailNotes}
            defaultCurrency={selectedBusinessCurrency}
            onNotesChange={setDetailNotes}
            onClose={() => setDetailRowId(null)}
          />

          {compareOpen ? (
            <CreativeCompareModal
              rows={compareRows}
              defaultCurrency={selectedBusinessCurrency}
              totals={compareTotals}
              window={`${drStart} to ${drEnd}`}
              onClose={() => setCompareOpen(false)}
            />
          ) : null}

          {shareModalOpen ? (
            <ShareSnapshotModal
              audience={shareAudience}
              anonymize={anonymize}
              allowCsv={allowCsv}
              decisionLanguageAvailable={buyerDecisionLanguage}
              shareLoading={shareLoading}
              shareError={shareError}
              shareUrl={shareUrl}
              onAudienceChange={setShareAudience}
              onAnonymizeChange={setAnonymize}
              onAllowCsvChange={setAllowCsv}
              onCopyLink={handleShareCopyLink}
              onPreview={submitShare}
              onClose={() => setShareModalOpen(false)}
            />
          ) : null}
        </div>
      </div>
    </PlanGate>
  );
}

function ReadOnlyCreativeDrawer({
  businessId,
  row,
  notes,
  defaultCurrency,
  onNotesChange,
  onClose,
}: {
  businessId: string;
  row: MetaCreativeRow | null;
  notes: string;
  defaultCurrency: string | null;
  onNotesChange: (value: string) => void;
  onClose: () => void;
}) {
  if (!row) return null;
  const currency = resolveCreativeCurrency(row.currency ?? null, defaultCurrency);
  const metrics = [
    ["Spend", formatMoney(row.spend, currency, defaultCurrency)],
    ["ROAS", formatRoas(row.roas)],
    ["CPA", formatMoney(row.cpa, currency, defaultCurrency)],
    ["Purchases", formatNumber(row.purchases)],
    ["Impressions", formatNumber(row.impressions)],
    ["Link clicks", formatNumber(row.linkClicks)],
  ];
  const decisionHref = `${DECISIONS_HREF}?businessId=${encodeURIComponent(businessId)}&creativeId=${encodeURIComponent(row.creativeId || row.id)}`;

  return (
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        aria-label="Close creative detail"
        className="absolute inset-0 cursor-default bg-neutral-950/40"
        onClick={onClose}
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[520px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
              Read-only detail
            </p>
            <h2 className="mt-1 truncate text-[16px] font-semibold text-[var(--ink)]">{row.name}</h2>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Creative Studio shows analysis only. Execution decisions live in Decisions.
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="overflow-hidden rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface-2)]">
            <CreativeRenderSurface
              id={row.id}
              name={row.name}
              preview={row.preview}
              size="large"
              mode="asset"
              assetState={hasRenderablePreview(row) ? "ready" : "missing"}
              assetFallbacks={[
                row.cardPreviewUrl,
                row.imageUrl,
                row.cachedThumbnailUrl,
                row.thumbnailUrl,
                row.previewUrl,
              ]}
              className="aspect-[4/5] w-full"
            />
          </div>
          <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
              <ImageIcon className="h-4 w-4 text-[var(--muted)]" />
              Performance
            </div>
            <div className="grid grid-cols-2 gap-2">
              {metrics.map(([label, value]) => (
                <div key={label} className="rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">{label}</p>
                  <p className="mt-1 text-[13px] font-semibold tabular-nums text-[var(--ink)]">{value}</p>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <h3 className="text-[13px] font-semibold text-[var(--ink)]">Creative context</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[row.format, row.creativePrimaryLabel, row.creativeSecondaryLabel, row.launchDate]
                .filter(Boolean)
                .map((value) => (
                  <span key={String(value)} className="chip chip--ghost">
                    {String(value)}
                  </span>
                ))}
            </div>
            {row.copyText ? (
              <p className="mt-3 whitespace-pre-wrap rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[12px] leading-5 text-[var(--ink-2)]">
                {row.copyText}
              </p>
            ) : null}
          </section>
          <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <label className="text-[13px] font-semibold text-[var(--ink)]" htmlFor="creative-studio-notes">
              Notes
            </label>
            <textarea
              id="creative-studio-notes"
              value={notes}
              onChange={(event) => onNotesChange(event.target.value)}
              placeholder="Write hypotheses or handoff notes. These are local to this view."
              className="mt-2 min-h-[94px] w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] outline-none focus:border-[var(--border-3)]"
            />
          </section>
        </div>
        <footer className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Link className="btn btn--primary w-full" href={decisionHref}>
            Open in Decisions
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </footer>
      </aside>
    </div>
  );
}

// Metrics compared side-by-side. Video-derived rows are structurally blanked when a
// creative has no video evidence (honesty law: no fabricated video metrics).
const COMPARE_METRIC_IDS = ["spend", "roas", "costPerPurchase", "purchases", "ctrAll", "thumbstopRatio"];
const COMPARE_VIDEO_METRIC_IDS = new Set([
  "thumbstopRatio",
  "firstFrameRetention",
  "video25Rate",
  "video50Rate",
  "video75Rate",
  "video100Rate",
  "watchScore",
  "holdRate",
]);

function CreativeCompareModal({
  rows,
  defaultCurrency,
  totals,
  window: windowLabel,
  onClose,
}: {
  rows: MetaCreativeRow[];
  defaultCurrency: string | null;
  totals: { totalSpend: number; totalPurchaseValue: number };
  window: string;
  onClose: () => void;
}) {
  const columns = rows.slice(0, 3);
  const gridTemplate = `120px repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(16,18,22,0.4)]">
      <button type="button" aria-label="Close compare overlay" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        data-testid="studio-compare-modal"
        className="relative max-h-[88vh] w-[900px] max-w-[94vw] overflow-y-auto rounded-[10px] border border-[var(--adc-b2,#cdcdc7)] bg-[var(--adc-s2,#fff)] p-5 shadow-[var(--shadow-lg)] [font-family:var(--font-ibm-plex-sans)]"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[15px] font-semibold text-[var(--adc-ink,#1a1c1f)]">
              Compare · {columns.length} {columns.length === 1 ? "creative" : "creatives"}
            </span>{" "}
            <span className="text-[11px] text-[var(--adc-ink3,#7d838c)]">
              · review-only — no writes here · window {windowLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-[var(--adc-b1,#e4e4e0)] text-[var(--adc-ink2,#4a4f56)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid items-start gap-2.5" style={{ gridTemplateColumns: gridTemplate }}>
          {/* Thumbnail header row */}
          <div />
          {columns.map((row) => (
            <div key={`head-${row.id}`} className="text-center">
              <div className="mx-auto w-[76px] overflow-hidden rounded-[6px] border border-[var(--adc-b1,#e4e4e0)]">
                <CreativeRenderSurface
                  id={row.id}
                  name={row.name}
                  preview={row.preview}
                  size="thumb"
                  mode="asset"
                  assetState={hasRenderablePreview(row) ? "ready" : "missing"}
                  assetFallbacks={[
                    row.cardPreviewUrl,
                    row.imageUrl,
                    row.cachedThumbnailUrl,
                    row.thumbnailUrl,
                    row.previewUrl,
                  ]}
                  className="aspect-[4/5] w-full"
                />
              </div>
              <div className="mt-1.5 truncate text-[12px] font-semibold text-[var(--adc-ink,#1a1c1f)]" title={row.name}>
                {row.name}
              </div>
              <div className="text-[10.5px] text-[var(--adc-ink3,#7d838c)]">
                {(row.format || "—").toUpperCase()} · ratio-true
              </div>
            </div>
          ))}

          {/* Metric rows */}
          {COMPARE_METRIC_IDS.map((metricId) => {
            const def = getCreativeMetricDefinition(metricId);
            if (!def) return null;
            const values = columns.map((row) => {
              const videoBlank = COMPARE_VIDEO_METRIC_IDS.has(metricId) && !hasCreativeVideoEvidence(row);
              return {
                row,
                videoBlank,
                value: videoBlank ? null : finite(def.getValue(row, totals)),
              };
            });
            const baseline = values[0]?.value ?? null;
            return (
              <CompareMetricRow
                key={metricId}
                label={def.label}
                cells={values.map((entry) => {
                  const currency = resolveCreativeCurrency(entry.row.currency ?? null, defaultCurrency);
                  const display = entry.value === null ? "—" : def.format(entry.value, currency, defaultCurrency);
                  return {
                    id: entry.row.id,
                    display,
                    ...resolveCompareDelta({
                      value: entry.value,
                      baseline,
                      isBaselineColumn: entry.row.id === values[0]?.row.id,
                      direction: def.direction,
                      videoBlank: entry.videoBlank,
                      currency,
                      defaultCurrency,
                      format: def.format,
                    }),
                  };
                })}
              />
            );
          })}

          {/* Copy row (context, not a metric) */}
          <CompareMetricRow
            label="Copy"
            cells={columns.map((row) => ({
              id: row.id,
              display: row.copyText?.trim() ? row.copyText.trim() : "—",
              deltaLabel: "",
              deltaColor: "var(--adc-ink3,#7d838c)",
              compact: true,
            }))}
          />
        </div>

        <div className="mt-2.5 text-[11px] text-[var(--adc-ink3,#7d838c)]">
          Deltas vs the first column (baseline). Missing values render “—”; ranking is omitted where the
          server does not supply it.
        </div>
      </div>
    </div>
  );
}

function resolveCompareDelta({
  value,
  baseline,
  isBaselineColumn,
  direction,
  videoBlank,
  currency,
  defaultCurrency,
  format,
}: {
  value: number | null;
  baseline: number | null;
  isBaselineColumn: boolean;
  direction: "high" | "low" | "neutral";
  videoBlank: boolean;
  currency: string | null;
  defaultCurrency: string | null;
  format: (n: number, rowCurrency?: string | null, defaultCurrency?: string | null) => string;
}): { deltaLabel: string; deltaColor: string } {
  const neutral = "var(--adc-ink3,#7d838c)";
  if (isBaselineColumn) return { deltaLabel: "baseline", deltaColor: neutral };
  if (value === null) return { deltaLabel: videoBlank ? "no video" : "—", deltaColor: neutral };
  if (baseline === null) return { deltaLabel: "", deltaColor: neutral };
  const delta = value - baseline;
  if (delta === 0) return { deltaLabel: "±0", deltaColor: neutral };
  const sign = delta > 0 ? "+" : "−";
  const label = `${sign}${format(Math.abs(delta), currency, defaultCurrency)}`;
  const improved = direction === "high" ? delta > 0 : direction === "low" ? delta < 0 : null;
  const color =
    improved === null
      ? neutral
      : improved
        ? "var(--adc-pos-fg,#0b6b4f)"
        : "var(--adc-danger-fg,#a6224a)";
  return { deltaLabel: label, deltaColor: color };
}

function CompareMetricRow({
  label,
  cells,
}: {
  label: string;
  cells: Array<{ id: string; display: string; deltaLabel: string; deltaColor: string; compact?: boolean }>;
}) {
  return (
    <>
      <div className="border-t border-[var(--adc-b1,#e4e4e0)] py-1.5 text-[11.5px] text-[var(--adc-ink3,#7d838c)]">
        {label}
      </div>
      {cells.map((cell) => (
        <div
          key={`${label}-${cell.id}`}
          className={`border-t border-[var(--adc-b1,#e4e4e0)] py-1.5 tabular-nums ${
            cell.compact
              ? "text-left text-[11.5px] leading-[1.4] text-[var(--adc-ink2,#4a4f56)]"
              : "text-center text-[12.5px]"
          }`}
        >
          <b className="font-semibold text-[var(--adc-ink,#1a1c1f)]">{cell.display}</b>
          {cell.deltaLabel ? (
            <span className="ml-1 text-[10.5px]" style={{ color: cell.deltaColor }}>
              {cell.deltaLabel}
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

const SHARE_AUDIENCES: Array<{ value: "buyer" | "creative_team" | "external"; label: string; note: string }> = [
  {
    value: "buyer",
    label: "Buyer",
    note: "Buyer preset: full metric set, decision language available only if the buyer-decision-language toggle is already on. Internal use.",
  },
  {
    value: "creative_team",
    label: "Creative team",
    note: "Creative-team preset: decision language is structurally removed at create-time and cannot be re-enabled on the share. Ships as a feedback package, not a table.",
  },
  {
    value: "external",
    label: "External",
    note: "External preset: decision language structurally removed, campaign names anonymized by default, plain-language results page + print PDF.",
  },
];

function ShareSnapshotModal({
  audience,
  anonymize,
  allowCsv,
  decisionLanguageAvailable,
  shareLoading,
  shareError,
  shareUrl,
  onAudienceChange,
  onAnonymizeChange,
  onAllowCsvChange,
  onCopyLink,
  onPreview,
  onClose,
}: {
  audience: "buyer" | "creative_team" | "external";
  anonymize: boolean;
  allowCsv: boolean;
  decisionLanguageAvailable: boolean;
  shareLoading: boolean;
  shareError: string | null;
  shareUrl: string | null;
  onAudienceChange: (value: "buyer" | "creative_team" | "external") => void;
  onAnonymizeChange: (value: boolean) => void;
  onAllowCsvChange: (value: boolean) => void;
  onCopyLink: () => void;
  onPreview: () => void;
  onClose: () => void;
}) {
  const activeNote = SHARE_AUDIENCES.find((entry) => entry.value === audience)?.note ?? "";
  const decisionLanguageState =
    audience === "buyer"
      ? decisionLanguageAvailable
        ? "carried (buyer toggle on)"
        : "off (buyer toggle off)"
      : "structurally removed";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(16,18,22,0.4)]">
      <button type="button" aria-label="Close share modal" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        data-testid="studio-share-modal"
        className="relative flex w-[480px] max-w-[92vw] flex-col gap-3 rounded-[10px] border border-[var(--adc-b2,#cdcdc7)] bg-[var(--adc-s2,#fff)] p-5 shadow-[var(--shadow-lg)] [font-family:var(--font-ibm-plex-sans)]"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-semibold text-[var(--adc-ink,#1a1c1f)]">Share a frozen snapshot</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-[var(--adc-b1,#e4e4e0)] text-[var(--adc-ink2,#4a4f56)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1.5">
          {SHARE_AUDIENCES.map((entry) => {
            const active = entry.value === audience;
            return (
              <button
                key={entry.value}
                type="button"
                onClick={() => onAudienceChange(entry.value)}
                aria-pressed={active}
                className={`flex-1 rounded-[6px] border px-1.5 py-[7px] text-[12px] font-medium text-[var(--adc-ink,#1a1c1f)] ${
                  active
                    ? "border-[var(--adc-b2,#cdcdc7)] bg-[var(--adc-s3,#ededea)]"
                    : "border-[var(--adc-b1,#e4e4e0)] bg-transparent"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-3 py-2.5 text-[11.5px] leading-[1.55] text-[var(--adc-ink2,#4a4f56)]">
          {activeNote}
        </div>

        <label className="flex items-center gap-2 text-[12px] text-[var(--adc-ink,#1a1c1f)]">
          <input
            type="checkbox"
            checked={anonymize}
            onChange={(event) => onAnonymizeChange(event.target.checked)}
            className="m-0 accent-[var(--adc-ink,#1a1c1f)]"
          />
          Anonymize campaign names
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[var(--adc-ink,#1a1c1f)]">
          <input
            type="checkbox"
            checked={allowCsv}
            onChange={(event) => onAllowCsvChange(event.target.checked)}
            className="m-0 accent-[var(--adc-ink,#1a1c1f)]"
          />
          Allow CSV download
        </label>

        <div className="text-[11.5px] text-[var(--adc-ink3,#7d838c)]">
          Decision language: <b className="font-semibold text-[var(--adc-ink,#1a1c1f)]">{decisionLanguageState}</b>
        </div>

        {shareError ? (
          <div className="rounded-[8px] border border-[var(--adc-danger-bd,#efc4d1)] bg-[var(--adc-danger-bg,#fbedf1)] px-3 py-2 text-[11.5px] text-[var(--adc-danger-fg,#a6224a)]">
            {shareError}
          </div>
        ) : null}
        {shareUrl ? (
          <div className="truncate rounded-[8px] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-3 py-2 text-[11.5px] text-[var(--adc-ink2,#4a4f56)] [font-family:var(--font-ibm-plex-mono)]" title={shareUrl}>
            {shareUrl}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onPreview}
            disabled={shareLoading}
            className="rounded-[6px] border border-[var(--adc-b2,#cdcdc7)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--adc-ink,#1a1c1f)] disabled:opacity-50"
          >
            Preview page
          </button>
          <button
            type="button"
            onClick={onCopyLink}
            disabled={shareLoading}
            className="rounded-[6px] border border-[var(--adc-ink,#1a1c1f)] bg-[var(--adc-ink,#1a1c1f)] px-3 py-1.5 text-[12px] font-medium text-[var(--adc-s2,#fff)] disabled:opacity-60"
          >
            {shareLoading ? "Creating…" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
