"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ImageIcon, X } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativeBriefPanel } from "@/components/creatives/CreativeBriefPanel";
import {
  StudioOsView,
  type StudioOsDatePreset,
  type StudioOsDecisionsData,
  type StudioOsTab,
} from "@/components/creatives/StudioOsView";
import { DEFAULT_TOP_METRIC_IDS } from "@/components/creatives/CreativesTopSection";
import type {
  CreativeGroupBy,
  CreativeDatePreset,
  CreativeDateRangeValue,
} from "@/components/creatives/CreativesTopSection";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import { PlanGate } from "@/components/pricing/PlanGate";
import { usePersistentCreativeDateRange } from "@/hooks/use-persistent-date-range";
import { useAppStore } from "@/store/app-store";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { getTodayIsoForTimeZone } from "@/components/date-range/DateRangePicker";
import {
  creativeDateRangeToStandard,
  standardDateRangeToCreative,
} from "@/components/creatives/creatives-top-section-support";
import type {
  MetaCreativeBrief,
  MetaCreativeBriefCapability,
} from "@/lib/meta/creative-brief-contract";
import type {
  CreativeShareLedgerEntry,
  CreativeShareLedgerCapability,
  ShareAudience,
} from "@/components/creatives/shareCreativeTypes";
import {
  fetchMetaCreatives,
  hasRenderablePreview,
  mapApiRowToUiRow,
  toCreatorTier0SharedCreative,
  toSharedCreative,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import {
  findCreativeStudioCard,
  flattenCreativeStudioBriefingCards,
  indexCreativeStudioBriefingCards,
  qualifyCurrentWinner,
  resolveCreativeStudioSharePolicy,
  resolveServerDecisionBadge,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";

const DECISIONS_HREF = "/platforms/meta";
const LAUNCHPAD_HREF = "/platforms/meta/launchpad";
const AUTOMATION_HREF = "/platforms/meta/automation";

const DATE_PRESETS: Array<{ key: CreativeDatePreset; label: string; lastDays: number }> = [
  { key: "last7Days", label: "Last 7 days", lastDays: 7 },
  { key: "last14Days", label: "Last 14 days", lastDays: 14 },
  { key: "last30Days", label: "Last 30 days", lastDays: 30 },
  { key: "lastMonth", label: "Last month", lastDays: 30 },
  { key: "last365Days", label: "Last 365 days", lastDays: 365 },
];

function creativeGroupByToApi(value: CreativeGroupBy): "adName" | "ad" | "creative" | "adSet" {
  if (value === "adName" || value === "creative" || value === "adSet") return value;
  return "creative";
}

function studioTabFromQuery(value: string | null | undefined): StudioOsTab {
  if (value === "winners" || value === "briefs" || value === "shares") {
    return value;
  }
  return "assets";
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

function briefingCardAccountId(card: BriefingCreativeCard): string {
  return (
    card.providerAccountId?.trim() ||
    card.accountId?.trim() ||
    card.metaAccountId?.trim() ||
    ""
  );
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

async function fetchStudioWriteAuthority(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<StudioOsDecisionsData> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    summary: "1",
  });
  const response = await fetch(`/api/meta/automation?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (StudioOsDecisionsData & { error?: string; message?: string })
    | null;
  if (!response.ok || !payload || !payload.system) {
    throw new Error(payload?.message ?? payload?.error ?? `Write authority could not load (${response.status}).`);
  }
  return payload;
}

async function fetchCreativeBriefs(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<{
  briefs: MetaCreativeBrief[];
  capability: MetaCreativeBriefCapability;
}> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const response = await fetch(`/api/meta/creative-briefs?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        briefs?: MetaCreativeBrief[];
        capability?: MetaCreativeBriefCapability;
        message?: string;
        error?: { message?: string };
      }
    | null;
  if (!response.ok || !Array.isArray(payload?.briefs) || !payload.capability) {
    throw new Error(
      payload?.error?.message ??
        payload?.message ??
        `Creative briefs could not load (${response.status}).`,
    );
  }
  return { briefs: payload.briefs, capability: payload.capability };
}

async function fetchCreativeShareLedger(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<{
  grants: CreativeShareLedgerEntry[];
  capability: CreativeShareLedgerCapability;
}> {
  const query = new URLSearchParams(input);
  const response = await fetch(`/api/creatives/share?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        grants?: CreativeShareLedgerEntry[];
        capability?: CreativeShareLedgerCapability;
        message?: string;
      }
    | null;
  if (!response.ok || !Array.isArray(payload?.grants) || !payload.capability) {
    throw new Error(payload?.message ?? `Creator share ledger could not load (${response.status}).`);
  }
  return { grants: payload.grants, capability: payload.capability };
}

export default function MetaCreativeStudioPage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";

  const [dateRangeValue, setDateRangeValue] = usePersistentCreativeDateRange();
  const [groupBy, setGroupBy] = useState<CreativeGroupBy>("creative");
  const [topMetricIds] = useState<string[]>(DEFAULT_TOP_METRIC_IDS);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [briefEditorBriefId, setBriefEditorBriefId] = useState<string | null | undefined>(undefined);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMutationToken, setShareMutationToken] = useState<string | null>(null);
  const [shareMutationError, setShareMutationError] = useState<string | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareAudience, setShareAudience] = useState<ShareAudience>("buyer");
  const [anonymize, setAnonymize] = useState(true);
  const [allowCsv, setAllowCsv] = useState(true);
  const requestedProviderAccountId = searchParams?.get("providerAccountId")?.trim() ?? "";
  const requestedCreativeId = searchParams?.get("creativeId")?.trim() ?? "";
  const activeStudioTab = studioTabFromQuery(searchParams?.get("tab"));
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(requestedProviderAccountId);

  const apiGroupBy = creativeGroupByToApi(groupBy);

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
    () => providerAccounts.find((account) => account.id === providerAccountId) ?? null,
    [providerAccountId, providerAccounts],
  );
  const accountTimeZone = selectedProviderAccount?.timezone || "UTC";
  const accountReferenceDate = getTodayIsoForTimeZone(accountTimeZone);
  const { start: drStart, end: drEnd } = resolveCreativeDateRange(
    dateRangeValue,
    accountReferenceDate,
  );
  const accountCurrency = selectedProviderAccount?.currency ?? null;
  const hasExplicitAccountScope = Boolean(selectedBusinessId && providerAccountId);

  const creativesQuery = useQuery({
    queryKey: ["meta-creative-studio", businessId, providerAccountId, drStart, drEnd, apiGroupBy],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchMetaCreatives({
        businessId,
        providerAccountId,
        start: drStart,
        end: drEnd,
        groupBy: apiGroupBy,
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
  const decisionsWorkspaceQuery = useQuery({
    queryKey: ["meta-studio-write-authority", businessId, providerAccountId],
    enabled: hasExplicitAccountScope,
    queryFn: () => fetchStudioWriteAuthority({ businessId, providerAccountId }),
    staleTime: 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const creativeBriefsQueryKey = ["meta-creative-briefs", businessId, providerAccountId] as const;
  const creativeBriefsQuery = useQuery({
    queryKey: creativeBriefsQueryKey,
    enabled: hasExplicitAccountScope,
    queryFn: () => fetchCreativeBriefs({ businessId, providerAccountId }),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
  const creativeShareLedgerQueryKey = ["creative-share-ledger", businessId, providerAccountId] as const;
  const creativeShareLedgerQuery = useQuery({
    queryKey: creativeShareLedgerQueryKey,
    enabled: hasExplicitAccountScope,
    queryFn: () => fetchCreativeShareLedger({ businessId, providerAccountId }),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  const allRows = useMemo(
    () =>
      (creativesQuery.data?.rows ?? [])
        .map(mapApiRowToUiRow)
        .filter((row) => row.accountId === providerAccountId),
    [creativesQuery.data?.rows, providerAccountId],
  );

  const loadUsageRows = (creativeId: string) =>
    queryClient.fetchQuery({
      queryKey: [
        "meta-creative-studio-usages",
        businessId,
        providerAccountId,
        creativeId,
        drStart,
        drEnd,
      ],
      queryFn: async () => {
        const payload = await fetchMetaCreatives({
          businessId,
          providerAccountId,
          creativeId,
          start: drStart,
          end: drEnd,
          groupBy: "ad",
          format: "all",
          sort: "spend",
          mediaMode: "metadata",
        });
        return payload.rows
          .map(mapApiRowToUiRow)
          .filter(
            (row) =>
              row.accountId === providerAccountId &&
              row.creativeId === creativeId &&
              Boolean(row.realAdId?.trim()),
          );
      },
      staleTime: 5 * 60 * 1000,
    });

  useEffect(() => {
    setSelectedRowIds((previous) => {
      const visibleIds = new Set(allRows.map((row) => row.id));
      const kept = previous.filter((id) => visibleIds.has(id));
      return kept.length === previous.length ? previous : kept;
    });
  }, [allRows]);

  useEffect(() => {
    if (!requestedCreativeId || detailRowId) return;
    const requestedRow = allRows.find(
      (row) => row.creativeId === requestedCreativeId || row.id === requestedCreativeId,
    );
    if (requestedRow) setDetailRowId(requestedRow.id);
  }, [allRows, detailRowId, requestedCreativeId]);

  const activeDetailRow = useMemo(
    () => allRows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, allRows],
  );
  const briefingCards = useMemo(
    () =>
      flattenCreativeStudioBriefingCards(briefingQuery.data).filter(
        (card) => briefingCardAccountId(card) === providerAccountId,
      ),
    [briefingQuery.data, providerAccountId],
  );
  const briefingCardIndex = useMemo(
    () => indexCreativeStudioBriefingCards(briefingCards),
    [briefingCards],
  );
  const activeDecisionCard = useMemo(
    () => (activeDetailRow ? findCreativeStudioCard(activeDetailRow, briefingCardIndex) : null),
    [activeDetailRow, briefingCardIndex],
  );
  const activeCreativeBrief = useMemo(() => {
    const creativeId = activeDetailRow?.creativeId || activeDetailRow?.id;
    if (!creativeId) return null;
    if (briefEditorBriefId === null) return null;
    if (typeof briefEditorBriefId === "string") {
      return creativeBriefsQuery.data?.briefs.find((brief) => brief.id === briefEditorBriefId) ?? null;
    }
    const activeSnapshotId = activeDecisionCard?.sourceDecisionSnapshotId ?? null;
    if (!activeSnapshotId) return null;
    return (
      creativeBriefsQuery.data?.briefs.find(
        (brief) =>
          brief.sourceDecision.creativeId === creativeId &&
          brief.sourceDecision.snapshotId === activeSnapshotId,
      ) ?? null
    );
  }, [activeDecisionCard, activeDetailRow, briefEditorBriefId, creativeBriefsQuery.data]);

  const handleCreativeBriefChanged = (brief: MetaCreativeBrief) => {
    queryClient.setQueryData<{
      briefs: MetaCreativeBrief[];
      capability: MetaCreativeBriefCapability;
    }>(creativeBriefsQueryKey, (current) =>
      current
        ? {
            ...current,
            briefs: [brief, ...current.briefs.filter((item) => item.id !== brief.id)],
          }
        : current,
    );
    setBriefEditorBriefId(brief.id);
  };

  const openBriefCard = (card: BriefingCreativeCard) => {
    const creativeId = card.creativeId?.trim() || card.id;
    const row = allRows.find(
      (candidate) => candidate.creativeId === creativeId || candidate.id === creativeId,
    );
    if (!row) return;
    setBriefEditorBriefId(null);
    setDetailRowId(row.id);
  };

  const editCreativeBrief = (brief: MetaCreativeBrief) => {
    const row = allRows.find(
      (candidate) =>
        candidate.creativeId === brief.sourceDecision.creativeId ||
        candidate.id === brief.sourceDecision.creativeId,
    );
    if (!row) return;
    setBriefEditorBriefId(brief.id);
    setDetailRowId(row.id);
  };

  const selectedRows = useMemo(
    () => allRows.filter((row) => selectedRowIds.includes(row.id)),
    [allRows, selectedRowIds],
  );

  const toggleRowSelection = (rowId: string) => {
    setSelectedRowIds((previous) =>
      previous.includes(rowId) ? previous.filter((id) => id !== rowId) : [...previous, rowId],
    );
  };

  // The Studio Share action mints an audience-aware, frozen snapshot link. The
  // POST carries only backend-supported ShareLinkConfig fields — no fabricated
  // config, and Tier-0 audiences structurally remove financial fields.
  const openShareModal = () => {
    setShareError(null);
    setShareAudience("creative_team");
    setShareModalOpen(true);
  };

  const submitShare = async (): Promise<string | null> => {
    setShareError(null);
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
      await queryClient.invalidateQueries({ queryKey: creativeShareLedgerQueryKey });
      return payload.url;
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Share link could not be created.");
      return null;
    } finally {
      setShareLoading(false);
    }
  };

  const mutateShareGrant = async (token: string, action: "revoke" | "rotate") => {
    setShareMutationToken(token);
    setShareMutationError(null);
    try {
      const response = await fetch(`/api/creatives/share/${encodeURIComponent(token)}`, {
        method: action === "revoke" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(
          action === "revoke"
            ? { businessId }
            : { businessId, action: "rotate" },
        ),
      });
      const payload = (await response.json().catch(() => null)) as
        | { token?: string; url?: string; message?: string }
        | null;
      if (!response.ok) throw new Error(payload?.message ?? `Share ${action} failed (${response.status}).`);
      await queryClient.invalidateQueries({ queryKey: creativeShareLedgerQueryKey });
      if (action === "rotate" && payload?.url) setShareUrl(payload.url);
      return action === "rotate" ? payload?.token ?? null : null;
    } catch (error) {
      setShareMutationError(error instanceof Error ? error.message : `Share ${action} failed.`);
      return null;
    } finally {
      setShareMutationToken(null);
    }
  };

  const handleShareCopyLink = async () => {
    const url = await submitShare();
    if (url && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url).catch(() => {});
    }
  };

  const datePresets = useMemo<StudioOsDatePreset[]>(
    () =>
      DATE_PRESETS.map((preset) => ({
        key: preset.key,
        label: preset.label,
        value: {
          preset: preset.key,
          customStart: "",
          customEnd: "",
          lastDays: preset.lastDays,
          sinceDate: "",
        } satisfies CreativeDateRangeValue,
      })),
    [],
  );

  const account = providerAccountId
    ? {
        name: selectedProviderAccount?.name ?? providerAccountId,
        id: providerAccountId,
        currency: accountCurrency,
      }
    : null;

  const asOf = briefingQuery.data?.source?.asOf ?? null;
  const freshnessLabel = asOf ? `as of ${asOf}` : "as of —";
  const engineVersion =
    briefingQuery.data?.pulse?.engineVersion ??
    briefingQuery.data?.source?.measurementReconciliation?.snapshotLatest?.engineVersion ??
    null;
  const dataSource = briefingQuery.data?.source?.dataSource ?? null;

  const rowsState: "loading" | "error" | "ready" = creativesQuery.isError
    ? "error"
    : creativesQuery.isLoading
      ? "loading"
      : "ready";
  const rowsError = creativesQuery.error instanceof Error ? creativesQuery.error.message : null;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div
        data-testid="creative-studio-page"
        data-creatives-query-status={creativesQuery.status}
        data-creatives-fetch-status={creativesQuery.fetchStatus}
      >
        <StudioOsView
          businessId={businessId}
          allRows={allRows}
          briefingCards={briefingCards}
          creativeBriefs={creativeBriefsQuery.data?.briefs ?? []}
          creativeBriefsState={
            creativeBriefsQuery.isError
              ? "error"
              : creativeBriefsQuery.data?.capability.status === "migration_required"
                ? "migration_required"
                : creativeBriefsQuery.data
                  ? "ready"
                  : "loading"
          }
          shareGrants={creativeShareLedgerQuery.data?.grants ?? []}
          shareGrantsCapability={creativeShareLedgerQuery.data?.capability ?? null}
          shareGrantsState={
            creativeShareLedgerQuery.isError
              ? "error"
              : creativeShareLedgerQuery.data
                ? "ready"
                : "loading"
          }
          shareMutationToken={shareMutationToken}
          shareMutationError={shareMutationError}
          defaultCurrency={accountCurrency}
          account={account}
          providerAccounts={providerAccounts.map((entry) => ({
            id: entry.id,
            name: entry.name,
            currency: entry.currency,
          }))}
          providerAccountId={providerAccountId}
          accountsLoading={providerAccountsQuery.isLoading}
          onSelectAccount={(nextProviderAccountId) => {
            if (typeof window !== "undefined") {
              const url = new URL(window.location.href);
              url.searchParams.set("providerAccountId", nextProviderAccountId);
              url.searchParams.delete("creativeId");
              window.history.replaceState(null, "", url);
            }
            setSelectedProviderAccountId(nextProviderAccountId);
            setSelectedRowIds([]);
            setDetailRowId(null);
            setBriefEditorBriefId(undefined);
            setShareUrl(null);
            setShareError(null);
          }}
          dateRangeLabel={`${drStart} → ${drEnd}`}
          dateStart={drStart}
          dateEnd={drEnd}
          windowLabel={`window ${drStart} to ${drEnd}`}
          freshnessLabel={freshnessLabel}
          engineVersion={engineVersion}
          dataSource={dataSource}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          datePresets={datePresets}
          currentDatePresetKey={dateRangeValue.preset}
          onDatePreset={setDateRangeValue}
          dateRangePickerValue={creativeDateRangeToStandard(
            dateRangeValue,
            accountReferenceDate,
          )}
          onDateRangePickerChange={(next) =>
            setDateRangeValue(standardDateRangeToCreative(next))
          }
          dateReferenceDate={accountReferenceDate}
          dateTimeZoneLabel={accountTimeZone}
          activeTab={activeStudioTab}
          selectedRowIds={selectedRowIds}
          onToggleRow={toggleRowSelection}
          onClearSelection={() => setSelectedRowIds([])}
          loadUsageRows={loadUsageRows}
          rowsState={rowsState}
          rowsError={rowsError}
          briefingState={
            briefingQuery.isError ? "error" : briefingQuery.data ? "ready" : "loading"
          }
          briefingError={
            briefingQuery.error instanceof Error ? briefingQuery.error.message : null
          }
          decisionsHref={buildMetaScopedHref(DECISIONS_HREF, {
            businessId,
            providerAccountId,
          })}
          launchpadHref={buildMetaScopedHref(LAUNCHPAD_HREF, {
            businessId,
            providerAccountId,
          })}
          automationHref={buildMetaScopedHref(AUTOMATION_HREF, {
            businessId,
            providerAccountId,
          })}
          onEditBrief={editCreativeBrief}
          onNewBrief={
            creativeBriefsQuery.data?.capability.canWrite && briefingCards.length > 0
              ? () => openBriefCard(briefingCards[0]!)
              : null
          }
          onOpenGrant={openShareModal}
          onRevokeShare={async (token) => {
            await mutateShareGrant(token, "revoke");
          }}
          onRotateShare={(token) => mutateShareGrant(token, "rotate")}
          decisions={decisionsWorkspaceQuery.data ?? null}
          decisionsState={
            decisionsWorkspaceQuery.isError ? "error" : decisionsWorkspaceQuery.data ? "ready" : "loading"
          }
        />

        <ReadOnlyCreativeDrawer
          businessId={businessId}
          providerAccountId={providerAccountId}
          row={activeDetailRow}
          decisionCard={activeDecisionCard}
          creativeBrief={activeCreativeBrief}
          creativeBriefState={
            creativeBriefsQuery.isError
              ? "error"
              : creativeBriefsQuery.data?.capability.status === "migration_required"
                ? "migration_required"
                : creativeBriefsQuery.data
                  ? "ready"
                  : "loading"
          }
          creativeBriefError={
            creativeBriefsQuery.error instanceof Error ? creativeBriefsQuery.error.message : null
          }
          defaultCurrency={accountCurrency}
          onCreativeBriefChanged={handleCreativeBriefChanged}
          onClose={() => {
            setDetailRowId(null);
            setBriefEditorBriefId(undefined);
          }}
        />

        {shareModalOpen ? (
          <ShareSnapshotModal
            audience={shareAudience}
            anonymize={anonymize}
            allowCsv={allowCsv}
            decisionLanguageAvailable={false}
            shareLoading={shareLoading}
            shareError={shareError}
            shareUrl={shareUrl}
            selectedCount={selectedRows.length}
            onAudienceChange={setShareAudience}
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

function ReadOnlyCreativeDrawer({
  businessId,
  providerAccountId,
  row,
  decisionCard,
  creativeBrief,
  creativeBriefState,
  creativeBriefError,
  defaultCurrency,
  onCreativeBriefChanged,
  onClose,
}: {
  businessId: string;
  providerAccountId: string;
  row: MetaCreativeRow | null;
  decisionCard: BriefingCreativeCard | null;
  creativeBrief: MetaCreativeBrief | null;
  creativeBriefState: "loading" | "error" | "migration_required" | "ready";
  creativeBriefError: string | null;
  defaultCurrency: string | null;
  onCreativeBriefChanged: (brief: MetaCreativeBrief) => void;
  onClose: () => void;
}) {
  if (!row) return null;
  const decisionBadge = resolveServerDecisionBadge(decisionCard);
  const winnerQualification = qualifyCurrentWinner(decisionCard);
  const currency = resolveCreativeCurrency(row.currency ?? null, defaultCurrency);
  const metrics = [
    ["Spend", formatMoney(row.spend, currency, defaultCurrency)],
    ["ROAS", formatRoas(row.roas)],
    ["CPA", formatMoney(row.cpa, currency, defaultCurrency)],
    ["Purchases", formatNumber(row.purchases)],
    ["Impressions", formatNumber(row.impressions)],
    ["Link clicks", formatNumber(row.linkClicks)],
  ];
  const decisionHref = `${DECISIONS_HREF}?businessId=${encodeURIComponent(businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}&creativeId=${encodeURIComponent(row.creativeId || row.id)}`;

  return (
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        aria-label="Close creative detail"
        className="absolute inset-0 cursor-default bg-[rgba(16,18,22,0.4)]"
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
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-[var(--ink)]">Server decision context</h3>
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  {decisionCard?.engineVersion ?? "Engine era unavailable"} · {decisionCard?.sourceAsOf ?? "as-of unavailable"}
                </p>
              </div>
              {decisionBadge ? (
                <span className="chip chip--info" data-decision-source="server">{decisionBadge.label}</span>
              ) : (
                <span className="chip chip--ghost">No server badge</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--muted)]">
              <span className="chip chip--ghost">truth {decisionCard?.truthSource ?? "unavailable"}</span>
              <span className="chip chip--ghost">threshold {decisionCard?.thresholdQuality ?? "unavailable"}</span>
              <span className="chip chip--ghost">source {decisionCard?.sourceDataSource ?? "unavailable"}</span>
            </div>
            {winnerQualification.candidate && !winnerQualification.qualified ? (
              <p className="mt-2 rounded-[var(--r-sm)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--warn)]">
                {winnerQualification.explanation}
              </p>
            ) : null}
          </section>
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
          {creativeBriefState === "ready" ? (
            <CreativeBriefPanel
              businessId={businessId}
              providerAccountId={providerAccountId}
              creativeId={row.creativeId || row.id}
              decisionCard={decisionCard}
              existingBrief={creativeBrief}
              onBriefChanged={onCreativeBriefChanged}
            />
          ) : (
            <section className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] leading-4 text-[var(--muted)]">
              <h3 className="text-[13px] font-semibold text-[var(--ink)]">Creative Brief</h3>
              <p className="mt-1">
                {creativeBriefState === "error"
                  ? creativeBriefError ?? "Creative briefs are unavailable; editing is withheld."
                  : creativeBriefState === "migration_required"
                    ? "Creative Brief storage needs the pending database migration. Analysis remains available; creating and editing briefs is disabled."
                    : "Loading account-scoped creative briefs..."}
              </p>
            </section>
          )}
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
  anonymize,
  allowCsv,
  decisionLanguageAvailable,
  shareLoading,
  shareError,
  shareUrl,
  selectedCount,
  onAudienceChange,
  onAnonymizeChange,
  onAllowCsvChange,
  onCopyLink,
  onPreview,
  onClose,
}: {
  audience: ShareAudience;
  anonymize: boolean;
  allowCsv: boolean;
  decisionLanguageAvailable: boolean;
  shareLoading: boolean;
  shareError: string | null;
  shareUrl: string | null;
  selectedCount: number;
  onAudienceChange: (value: ShareAudience) => void;
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
