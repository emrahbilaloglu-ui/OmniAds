"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import { buildCreativeStudioTabHrefs } from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import {
  mapApiRowToCopyRow,
  type CopyMotionRow,
} from "@/app/(dashboard)/platforms/meta/copies/page-support";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import { CopyDetailDrawerExact } from "@/components/creatives/CopyDetailDrawerExact";
import {
  buildCopyDetailDrawerExactViewModel,
  type CopyDetailDrawerExactRow,
} from "@/components/creatives/copy-detail-drawer-exact-adapter";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { standardDateRangeToCreative } from "@/components/creatives/creatives-top-section-support";
import { buildCreativeStudioCopiesModel } from "@/components/creatives/creative-studio-exact-adapters";
import { formatMoney } from "@/components/creatives/money";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";

interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
    generatedAt?: string;
    warehouseObservedAt?: string | null;
    provider_account_id?: string;
  };
}

export interface CopiesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

function hasMessage(payload: unknown): payload is { message: string } {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

async function fetchCopyRows(params: {
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
}): Promise<MetaCopiesResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    providerAccountId: params.providerAccountId,
    start: params.start,
    end: params.end,
    groupBy: "copy",
    format: "all",
    sort: "spend",
  });
  const response = await fetch(`/api/meta/copies?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      hasMessage(payload)
        ? payload.message
        : `Could not load copies (${response.status}).`,
    );
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function launchpadHref(input: {
  pathname: string | null;
  businessId: string;
  providerAccountId: string;
}) {
  if (input.pathname?.startsWith("/c/")) {
    const query = input.providerAccountId
      ? `?providerAccountId=${encodeURIComponent(input.providerAccountId)}`
      : "";
    return `/c/${encodeURIComponent(input.businessId)}/meta/launchpad${query}`;
  }
  if (input.pathname?.startsWith("/app/")) {
    const query = input.providerAccountId
      ? `?providerAccountId=${encodeURIComponent(input.providerAccountId)}`
      : "";
    return `/app/meta/launchpad${query}`;
  }
  return buildMetaScopedHref("/platforms/meta/launchpad", {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
}

export default function CopiesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: CopiesPageProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const hasAuthorizedBusinessScope = authorizedBusinessId !== undefined;
  const hasAuthorizedProviderScope = authorizedProviderAccountId !== undefined;
  const businessId = hasAuthorizedBusinessScope
    ? authorizedBusinessId?.trim() ?? ""
    : storeBusinessId ?? "";
  const requestedProviderAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : searchParams?.get("providerAccountId")?.trim() ?? "";
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );
  const [dashboardDateRange] = usePersistentDateRange();
  const { start, end } = resolveCreativeDateRange(
    standardDateRangeToCreative(dashboardDateRange),
  );
  const [detailRowId, setDetailRowId] = useState<string | null>(null);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId) && !hasAuthorizedProviderScope,
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const discoveredProviderAccountId =
    (selectedProviderAccountId &&
    providerAccounts.some((account) => account.id === selectedProviderAccountId)
      ? selectedProviderAccountId
      : "") ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const providerAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : discoveredProviderAccountId;

  useEffect(() => {
    if (hasAuthorizedProviderScope) return;
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
    businessId,
    hasAuthorizedProviderScope,
    providerAccounts,
    requestedProviderAccountId,
  ]);

  const hasExplicitAccountScope = Boolean(businessId && providerAccountId);
  const copiesQuery = useQuery({
    queryKey: [
      "copies-creatives",
      businessId,
      providerAccountId,
      start,
      end,
      "copy",
    ],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchCopyRows({
        businessId,
        providerAccountId,
        start,
        end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isLoading) ||
      copiesQuery.isLoading,
    isFetching:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isFetching) ||
      copiesQuery.isFetching,
    error: copiesQuery.error ?? providerAccountsQuery.error,
    asOf: measuredAsOf(copiesQuery.data?.meta?.warehouseObservedAt ?? null),
    businessId: businessId || null,
    onRetry: () => {
      if (!hasAuthorizedProviderScope && providerAccountsQuery.isError) {
        void providerAccountsQuery.refetch();
      }
      if (hasExplicitAccountScope) void copiesQuery.refetch();
    },
  });

  const rows = useMemo(
    () =>
      (copiesQuery.data?.rows ?? [])
        .map(mapApiRowToCopyRow)
        .filter((row) => row.accountId === providerAccountId),
    [copiesQuery.data?.rows, providerAccountId],
  );
  const accountCurrency =
    providerAccounts.find((account) => account.id === providerAccountId)?.currency ??
    rows.find((row) => row.currency)?.currency ??
    null;
  const scopeLoading =
    !hasAuthorizedProviderScope && providerAccountsQuery.isLoading;
  const scopeError =
    !hasAuthorizedProviderScope && providerAccountsQuery.isError;
  const state = scopeLoading
    ? "loading"
    : scopeError
      ? "error"
      : !providerAccountId
        ? "account_required"
        : copiesQuery.isLoading
          ? "loading"
          : copiesQuery.isError
            ? "error"
            : rows.length > 0
              ? "ready"
              : "empty";
  const message = scopeLoading
    ? "Loading assigned Meta account scope."
    : scopeError
      ? errorMessage(
          providerAccountsQuery.error,
          "Assigned Meta accounts could not load.",
        )
      : !providerAccountId
        ? "Select one assigned Meta account to load copy performance."
        : copiesQuery.isLoading
          ? "Loading copy performance."
          : copiesQuery.isError
            ? errorMessage(copiesQuery.error, "Copy performance is unavailable.")
            : rows.length === 0
              ? "No copy performance is available for this account and date range."
              : null;
  const model = useMemo(() => {
    const base = buildCreativeStudioCopiesModel({
      rows,
      state,
      message,
      onOpenRow: setDetailRowId,
    });
    const angles = [...base.angles];
    while (angles.length < 4) {
      const slot = angles.length + 1;
      angles.push({
        id: `unavailable-${slot}`,
        name: "—",
        tone: "neutral",
        lines: null,
        spendShare: null,
        roas: null,
        ctr: null,
        bestLine: null,
        usage: null,
      });
    }
    return { ...base, angles: angles.slice(0, 4) };
  }, [message, rows, state]);
  const activeDetailRow = useMemo(
    () => rows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, rows],
  );
  const closeDetailDrawer = useCallback(() => setDetailRowId(null), []);
  const drawerPeers = useMemo(() => rows.map(toCopyDrawerRow), [rows]);
  const tabHrefs = buildCreativeStudioTabHrefs({
    pathname,
    businessId,
    providerAccountId,
    start,
    end,
  });

  if (!businessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div
        data-copies-fetch-status={copiesQuery.fetchStatus}
        data-copies-query-status={copiesQuery.status}
        data-testid="copies-studio-page"
      >
        <CreativeStudioExact
          activeTab="copies"
          copies={model}
          counts={buildCreativeStudioTabCounts({})}
          onExport={rows.length > 0 ? () => exportCopiesCsv(rows, accountCurrency) : undefined}
          tabHrefs={tabHrefs}
        />
        {activeDetailRow ? (
          <CopyDetailDrawerExact
            onClose={closeDetailDrawer}
            viewModel={buildCopyDetailDrawerExactViewModel({
              row: toCopyDrawerRow(activeDetailRow),
              peers: drawerPeers,
              targetRoas: null,
              draftHref: launchpadHref({
                pathname,
                businessId,
                providerAccountId,
              }),
            })}
          />
        ) : null}
      </div>
    </PlanGate>
  );
}

/**
 * Narrows a synced copy row to the drawer's pure input. See-more and
 * engagement have no field in the Meta copies response, so they stay null and
 * the drawer renders the design's tiles with an em dash rather than
 * substituting a different metric.
 */
function toCopyDrawerRow(row: CopyMotionRow): CopyDetailDrawerExactRow {
  return {
    id: row.id,
    text: row.copyText ?? null,
    assetType: row.copyAssetType ?? null,
    angle: row.copyAngle ?? null,
    seeMore: null,
    ctr: Number.isFinite(row.linkCtr) ? row.linkCtr : null,
    engagement: null,
    roas: Number.isFinite(row.roas) ? row.roas : null,
    variants: row.copyVariants ?? [],
  };
}
