"use client";

import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import type {
  CreativeStudioAssetRow,
  CreativeStudioAssetsModel,
  CreativeStudioDataState,
  CreativeStudioTabId,
  CreativeStudioTone,
} from "@/components/creatives/creative-studio-exact-types";
import { DEFAULT_TOP_METRIC_IDS } from "@/components/creatives/CreativesTopSection";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { resolveCreativeCurrency } from "@/components/creatives/money";
import {
  calculateCreativeAverageOrderValue,
  calculateCreativeClickToAddToCartRate,
  calculateCreativeClickToPurchaseRate,
  calculateCreativeLinkCtr,
} from "@/components/creatives/creative-truth";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { CreativesBriefingResponse } from "@/components/creatives/briefing/types";
import { PlanGate } from "@/components/pricing/PlanGate";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useAppStore } from "@/store/app-store";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { standardDateRangeToCreative } from "@/components/creatives/creatives-top-section-support";
import type { ShareAudience } from "@/components/creatives/shareCreativeTypes";
import {
  fetchMetaCreatives,
  mapApiRowToUiRow,
  toCsv,
  toCreatorTier0SharedCreative,
  toSharedCreative,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import { resolveCreativeStudioSharePolicy } from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import {
  BUYER_ACKNOWLEDGEMENT_VALUE,
  BUYER_FINANCIAL_WARNING,
} from "@/lib/zero-base/creative/share-acknowledgement";

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusTone(status: string | null): CreativeStudioTone {
  switch (status?.trim().toUpperCase()) {
    case "ACTIVE":
      return "positive";
    case "PAUSED":
    case "ARCHIVED":
      return "neutral";
    case "DISAPPROVED":
    case "WITH_ISSUES":
      return "warning";
    default:
      return "neutral";
  }
}

function assetImageUrl(row: MetaCreativeRow): string | null {
  return (
    row.tableThumbnailUrl ??
    row.cachedThumbnailUrl ??
    row.thumbnailUrl ??
    row.imageUrl ??
    row.preview.poster_url ??
    row.preview.image_url ??
    row.cardPreviewUrl ??
    row.previewUrl ??
    null
  );
}

/**
 * Presentation-only projection for the exact Assets surface.
 *
 * It does not read decision fields. A row whose metric payload is unavailable
 * withholds every numeric cell, even though the legacy row shape contains zero
 * placeholders. Hold intentionally stays absent until Meta serves a dedicated
 * hold metric; video completion is not a substitute.
 */
export function toCreativeStudioAssetRows(
  rows: readonly MetaCreativeRow[],
  defaultCurrency: string | null,
): CreativeStudioAssetRow[] {
  return rows.map((row) => {
    const metricsAvailable = row.metricsAvailability === "available";
    const metrics: CreativeStudioAssetRow["metrics"] = metricsAvailable
      ? {
          spend: finite(row.spend),
          impressions: finite(row.impressions),
          clicks: finite(row.clicks),
          purchases: finite(row.purchases),
          roas: finite(row.roas),
          cpa: finite(row.cpa),
          cpm: finite(row.cpm),
          aov: finite(calculateCreativeAverageOrderValue(row)),
          ctr: finite(calculateCreativeLinkCtr(row)),
          thumbstop: finite(row.thumbstop),
          hold: null,
          frequency: finite(row.frequency),
          atcRate: finite(calculateCreativeClickToAddToCartRate(row)),
          cvr: finite(calculateCreativeClickToPurchaseRate(row)),
        }
      : {
          spend: null,
          impressions: null,
          clicks: null,
          purchases: null,
          roas: null,
          cpa: null,
          cpm: null,
          aov: null,
          ctr: null,
          thumbstop: null,
          hold: null,
          frequency: null,
          atcRate: null,
          cvr: null,
        };
    const effectiveStatus = row.effectiveStatus?.trim() || null;
    const marketingAngle =
      row.aiTags.messagingAngle?.map((value) => value.trim()).filter(Boolean).join(", ") || null;

    return {
      id: row.id,
      name: row.name,
      kind: row.creativePrimaryLabel ?? row.creativeTypeLabel ?? row.format,
      imageUrl: assetImageUrl(row),
      status: effectiveStatus,
      statusTone: statusTone(effectiveStatus),
      marketingAngle,
      currency: resolveCreativeCurrency(row.currency ?? null, defaultCurrency),
      metrics,
    };
  });
}

export function buildCreativeStudioTabHrefs(input: {
  pathname: string | null;
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
}): Record<CreativeStudioTabId, string> {
  const inBusinessRoute = Boolean(input.pathname?.startsWith("/c/"));
  const inSessionRoute = Boolean(input.pathname?.startsWith("/app/"));
  const prefix = inBusinessRoute
    ? `/c/${encodeURIComponent(input.businessId)}/creative`
    : inSessionRoute
      ? "/app/creative"
      : null;
  const paths: Record<CreativeStudioTabId, string> = prefix
    ? {
        assets: `${prefix}/performance`,
        copies: `${prefix}/copies`,
        "landing-pages": `${prefix}/landing-pages`,
        inbox: `${prefix}/inbox`,
        audiences: `${prefix}/audiences`,
      }
    : {
        assets: "/platforms/meta/creatives",
        copies: "/platforms/meta/copies",
        "landing-pages": "/platforms/meta/landing-pages",
        inbox: "/platforms/meta/creative-inbox",
        audiences: "/platforms/meta/audiences",
      };
  const params = new URLSearchParams();
  if (!prefix && input.businessId) params.set("businessId", input.businessId);
  if (input.providerAccountId) params.set("providerAccountId", input.providerAccountId);
  if (input.start) params.set("start", input.start);
  if (input.end) params.set("end", input.end);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";

  return Object.fromEntries(
    Object.entries(paths).map(([key, href]) => [key, `${href}${suffix}`]),
  ) as Record<CreativeStudioTabId, string>;
}

async function fetchCreativeStudioBriefing(input: {
  businessId: string;
  providerAccountId: string;
  start: string;
  asOf: string;
}): Promise<CreativesBriefingResponse> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    start: input.start,
    asOf: input.asOf,
    decisionCenter: "1",
    status_filter: "all",
  });
  const response = await fetch(`/api/creatives/briefing?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (CreativesBriefingResponse & { message?: string })
    | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.message ?? `Creative decision context could not load (${response.status}).`);
  }
  return payload;
}

interface MetaCreativeStudioPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

export default function MetaCreativeStudioPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: MetaCreativeStudioPageProps = {}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const hasServerAuthorizedScope = authorizedBusinessId !== undefined;
  const businessId = hasServerAuthorizedScope
    ? authorizedBusinessId?.trim() ?? ""
    : selectedBusinessId ?? "";

  const [dashboardDateRange] = usePersistentDateRange();
  const topMetricIds = DEFAULT_TOP_METRIC_IDS;
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareAudience, setShareAudience] = useState<ShareAudience>("buyer");
  const [buyerAcknowledged, setBuyerAcknowledged] = useState(false);
  const [anonymize, setAnonymize] = useState(true);
  const [allowCsv, setAllowCsv] = useState(true);
  const requestedProviderAccountId = hasServerAuthorizedScope
    ? ""
    : searchParams?.get("providerAccountId")?.trim() ?? "";
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(() =>
    hasServerAuthorizedScope
      ? authorizedProviderAccountId?.trim() ?? ""
      : requestedProviderAccountId,
  );

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const providerAccountId = hasServerAuthorizedScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : (selectedProviderAccountId &&
        providerAccounts.some((account) => account.id === selectedProviderAccountId)
        ? selectedProviderAccountId
        : "") || (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const scopeLoading =
    !hasServerAuthorizedScope && providerAccountsQuery.isLoading;
  const scopeError =
    !hasServerAuthorizedScope && providerAccountsQuery.isError;

  useEffect(() => {
    if (hasServerAuthorizedScope) {
      setSelectedProviderAccountId(authorizedProviderAccountId?.trim() ?? "");
      return;
    }
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
  }, [
    authorizedProviderAccountId,
    businessId,
    hasServerAuthorizedScope,
    providerAccounts,
    requestedProviderAccountId,
  ]);

  const selectedProviderAccount = useMemo<MetaHistoryAccount | null>(
    () => providerAccounts.find((account) => account.id === providerAccountId) ?? null,
    [providerAccountId, providerAccounts],
  );
  const accountTimeZone = selectedProviderAccount?.timezone || "UTC";
  const accountReferenceDate = getTodayIsoForTimeZone(accountTimeZone);
  const dashboardWindow = getPresetDatesForReferenceDate(
    dashboardDateRange.rangePreset,
    accountReferenceDate,
    dashboardDateRange.customStart,
    dashboardDateRange.customEnd,
  );
  const dateRangeValue = standardDateRangeToCreative({
    ...dashboardDateRange,
    customStart: dashboardWindow.start,
    customEnd: dashboardWindow.end,
  });
  const { start: drStart, end: drEnd } = resolveCreativeDateRange(
    dateRangeValue,
    accountReferenceDate,
  );
  const accountCurrency = selectedProviderAccount?.currency ?? null;
  const hasExplicitAccountScope = Boolean(businessId && providerAccountId);

  const creativesQuery = useQuery({
    queryKey: ["meta-creative-studio", businessId, providerAccountId, drStart, drEnd, "creative"],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchMetaCreatives({
        businessId,
        providerAccountId,
        start: drStart,
        end: drEnd,
        groupBy: "creative",
        format: "all",
        sort: "spend",
        mediaMode: "full",
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const briefingQuery = useQuery({
    queryKey: [
      "meta-creative-studio-briefing",
      businessId,
      providerAccountId,
      drStart,
      drEnd,
    ],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchCreativeStudioBriefing({
        businessId,
        providerAccountId,
        start: drStart,
        asOf: drEnd,
      }),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  // One freshness contract across every Tier-0 surface. Derived from the
  // query state this surface already has, so it cannot drift from what is
  // actually on screen.
  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: scopeLoading || creativesQuery.isLoading,
    isFetching: providerAccountsQuery.isFetching || creativesQuery.isFetching,
    error: creativesQuery.error ?? (scopeError ? providerAccountsQuery.error : null),
    // Decision context failing leaves a workspace that looks complete but is not.
    partialReason: briefingQuery.error
      ? "Creative decision context could not be read; this view is incomplete"
      : null,
    // When the snapshot rows were computed. Not `source.asOf` (the client's
    // own request parameter echoed back) and not `asOfDate` (the calendar day
    // the rows describe) -- a date is not an instant, and using one made the
    // same data read as a different age depending on the hour.
    asOf: measuredAsOf(
      briefingQuery.data?.source?.measurementReconciliation?.snapshotLatest
        ?.observedAt ?? null,
    ),
    businessId,
    onRetry: () => {
      if (scopeError) void providerAccountsQuery.refetch();
      void creativesQuery.refetch();
      if (briefingQuery.isError) void briefingQuery.refetch();
    },
  });

  const allRows = useMemo(
    () =>
      (creativesQuery.data?.rows ?? [])
        .map(mapApiRowToUiRow)
        .filter((row) => row.accountId === providerAccountId),
    [creativesQuery.data?.rows, providerAccountId],
  );

  useEffect(() => {
    setSelectedRowIds((previous) => {
      const visibleIds = new Set(allRows.map((row) => row.id));
      const kept = previous.filter((id) => visibleIds.has(id));
      return kept.length === previous.length ? previous : kept;
    });
  }, [allRows]);

  const selectedRows = useMemo(
    () => allRows.filter((row) => selectedRowIds.includes(row.id)),
    [allRows, selectedRowIds],
  );

  // The Studio Share action mints an audience-aware, frozen snapshot link. The
  // POST carries only backend-supported ShareLinkConfig fields — no fabricated
  // config, and Tier-0 audiences structurally remove financial fields.
  const openShareModal = () => {
    setShareError(null);
    setShareUrl(null);
    setShareAudience("creative_team");
    setBuyerAcknowledged(false);
    setShareModalOpen(true);
  };

  const submitShare = async (): Promise<string | null> => {
    setShareError(null);
    if (shareAudience === "buyer" && !buyerAcknowledged) {
      setShareError("A buyer share requires the financial-limitation acknowledgement.");
      return null;
    }
    setShareLoading(true);
    try {
      const rows = selectedRows;
      if (rows.length === 0) throw new Error("Select at least one creative first.");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const sharePolicy = resolveCreativeStudioSharePolicy({
        audience: shareAudience,
        selectedMetricIds: topMetricIds,
        buyerDecisionLanguage: false,
        allowCsv,
        anonymizeCampaignNames: anonymize,
      });
      const response = await fetch("/api/creatives/share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title: "Creative Studio snapshot",
          businessId,
          providerAccountId,
          dateRange: `${drStart} - ${drEnd}`,
          expiresAt,
          metrics: sharePolicy.metrics,
          includeNotes: false,
          audience: shareAudience,
          ...(shareAudience === "buyer"
            ? { acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE }
            : {}),
          presetId: "creative-studio",
          presetLabel: "Creative Studio",
          includeCampaignNames: sharePolicy.includeCampaignNames,
          includeDecisionLanguage: sharePolicy.includeDecisionLanguage,
          allowCsv: sharePolicy.allowCsv,
          snapshotOnly: true,
          filters: ["Creative Studio", "selected assets"],
          selectedRowIds: rows.map((row) => row.id),
          totalRows: allRows.length,
          creatives: rows.map((row) =>
            sharePolicy.creatorTier0 ? toCreatorTier0SharedCreative(row) : toSharedCreative(row),
          ),
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

  const handleCsvExport = () => {
    if (typeof window === "undefined" || allRows.length === 0) return;
    const blob = new Blob(["\ufeff" + toCsv(allRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `creative-studio-assets-${drEnd}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const assetsState: CreativeStudioDataState = scopeLoading
    ? "loading"
    : scopeError
      ? "error"
      : !providerAccountId
        ? "account_required"
        : creativesQuery.isError
          ? "error"
          : creativesQuery.isLoading
            ? "loading"
            : allRows.length === 0
              ? "empty"
              : "ready";
  const assetsMessage =
    assetsState === "loading"
      ? scopeLoading
        ? "Loading assigned Meta account scope."
        : "Loading creative assets."
      : assetsState === "account_required"
      ? "Select one assigned Meta ad account. Assets remain withheld until the provider scope is explicit."
      : assetsState === "error"
        ? providerAccountsQuery.error instanceof Error && scopeError
          ? providerAccountsQuery.error.message
          : creativesQuery.error instanceof Error
            ? creativesQuery.error.message
            : "Creative assets could not be read."
        : assetsState === "empty"
          ? "No creative assets were served for this window."
          : null;
  const assetRows = useMemo(
    () => toCreativeStudioAssetRows(allRows, accountCurrency),
    [accountCurrency, allRows],
  );
  const assetsModel = useMemo<CreativeStudioAssetsModel>(
    () => ({
      state: assetsState,
      message: assetsMessage,
      syncedCount:
        assetsState === "ready" || assetsState === "empty" ? allRows.length : null,
      rows: assetRows,
      persistenceKey: `creative-studio:assets:v1:${businessId}:${providerAccountId || "account-required"}`,
      onPinnedIdsChange: (ids) => {
        const visibleIds = new Set(allRows.map((row) => row.id));
        setSelectedRowIds(ids.filter((id) => visibleIds.has(id)));
      },
    }),
    [assetRows, assetsMessage, assetsState, allRows, businessId, providerAccountId],
  );
  const tabHrefs = useMemo(
    () =>
      buildCreativeStudioTabHrefs({
        pathname,
        businessId,
        providerAccountId,
        start: drStart,
        end: drEnd,
      }),
    [businessId, drEnd, drStart, pathname, providerAccountId],
  );

  if (!businessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div
        data-testid="creative-studio-page"
        data-creatives-query-status={creativesQuery.status}
        data-creatives-fetch-status={creativesQuery.fetchStatus}
        data-responsive-studio="true"
        data-provider-writes="none"
      >
        <CreativeStudioExact
          activeTab="assets"
          tabHrefs={tabHrefs}
          counts={{ assets: assetsModel.syncedCount }}
          onExport={handleCsvExport}
          onShare={openShareModal}
          assets={assetsModel}
        />

        {shareModalOpen ? (
          <ShareSnapshotModal
            audience={shareAudience}
            buyerAcknowledged={buyerAcknowledged}
            anonymize={anonymize}
            allowCsv={allowCsv}
            decisionLanguageAvailable={false}
            shareLoading={shareLoading}
            shareError={shareError}
            shareUrl={shareUrl}
            selectedCount={selectedRows.length}
            onAudienceChange={(nextAudience) => {
              setShareAudience(nextAudience);
              if (nextAudience !== "buyer") setBuyerAcknowledged(false);
            }}
            onBuyerAcknowledgedChange={setBuyerAcknowledged}
            onAnonymizeChange={setAnonymize}
            onAllowCsvChange={setAllowCsv}
            onCopyLink={handleShareCopyLink}
            onPreview={submitShare}
            onClose={() => setShareModalOpen(false)}
          />
        ) : null}
      </div>
    </PlanGate>
  );
}

const SHARE_AUDIENCES: Array<{ value: ShareAudience; label: string; note: string }> = [
  {
    value: "buyer",
    label: "Buyer",
    note: "Buyer preset: full metric set, decision language available only if the buyer-decision-language toggle is already on. Internal use.",
  },
  {
    value: "creative_team",
    label: "Creative team",
    note: "Tier 0 only: thumbstop, CTR, and video completion. Financials, delivery totals, targets, campaign names, and decision language are removed.",
  },
  {
    value: "external",
    label: "External",
    note: "Tier 0 only: thumbstop, CTR, and video completion. Campaign names, financials, delivery totals, targets, decision language, and CSV are removed.",
  },
];

function ShareSnapshotModal({
  audience,
  buyerAcknowledged,
  anonymize,
  allowCsv,
  decisionLanguageAvailable,
  shareLoading,
  shareError,
  shareUrl,
  selectedCount,
  onAudienceChange,
  onBuyerAcknowledgedChange,
  onAnonymizeChange,
  onAllowCsvChange,
  onCopyLink,
  onPreview,
  onClose,
}: {
  audience: ShareAudience;
  buyerAcknowledged: boolean;
  anonymize: boolean;
  allowCsv: boolean;
  decisionLanguageAvailable: boolean;
  shareLoading: boolean;
  shareError: string | null;
  shareUrl: string | null;
  selectedCount: number;
  onAudienceChange: (value: ShareAudience) => void;
  onBuyerAcknowledgedChange: (value: boolean) => void;
  onAnonymizeChange: (value: boolean) => void;
  onAllowCsvChange: (value: boolean) => void;
  onCopyLink: () => void;
  onPreview: () => void;
  onClose: () => void;
}) {
  const activeNote = SHARE_AUDIENCES.find((entry) => entry.value === audience)?.note ?? "";
  const creatorTier0 = audience !== "buyer";
  const decisionLanguageState =
    audience === "buyer"
      ? decisionLanguageAvailable
        ? "carried from server evidence"
        : "not included from Studio"
      : "structurally removed";
  const submissionBlocked =
    shareLoading || selectedCount === 0 || (audience === "buyer" && !buyerAcknowledged);

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

        <div className="text-[11.5px] text-[var(--adc-ink3,#7d838c)]">
          {selectedCount} creative{selectedCount === 1 ? "" : "s"} selected.
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

        {audience === "buyer" ? (
          <label className="flex items-start gap-2 rounded-[8px] border border-[var(--adc-caution-bd,#ead7ae)] bg-[var(--adc-caution-bg,#fff8e7)] px-3 py-2.5 text-[11.5px] leading-[1.5] text-[var(--adc-caution-fg,#86590a)]">
            <input
              type="checkbox"
              checked={buyerAcknowledged}
              onChange={(event) => onBuyerAcknowledgedChange(event.target.checked)}
              className="mt-0.5 accent-[var(--adc-ink,#1a1c1f)]"
            />
            <span>{BUYER_FINANCIAL_WARNING}</span>
          </label>
        ) : null}

        <label className="flex items-center gap-2 text-[12px] text-[var(--adc-ink,#1a1c1f)]">
          <input
            type="checkbox"
            checked={creatorTier0 || anonymize}
            disabled={creatorTier0}
            onChange={(event) => onAnonymizeChange(event.target.checked)}
            className="m-0 accent-[var(--adc-ink,#1a1c1f)]"
          />
          Anonymize campaign names
        </label>
        <label className="flex items-center gap-2 text-[12px] text-[var(--adc-ink,#1a1c1f)]">
          <input
            type="checkbox"
            checked={!creatorTier0 && allowCsv}
            disabled={creatorTier0}
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
            disabled={submissionBlocked}
            className="rounded-[6px] border border-[var(--adc-b2,#cdcdc7)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--adc-ink,#1a1c1f)] disabled:opacity-50"
          >
            Preview page
          </button>
          <button
            type="button"
            onClick={onCopyLink}
            disabled={submissionBlocked}
            className="rounded-[6px] border border-[var(--adc-ink,#1a1c1f)] bg-[var(--adc-ink,#1a1c1f)] px-3 py-1.5 text-[12px] font-medium text-[var(--adc-s2,#fff)] disabled:opacity-60"
          >
            {shareLoading ? "Creating…" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
