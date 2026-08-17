"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioLandingModel } from "@/components/creatives/creative-studio-exact-adapters";
import type {
  CreativeStudioDataState,
  CreativeStudioTabId,
} from "@/components/creatives/creative-studio-exact-types";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { standardDateRangeToCreative } from "@/components/creatives/creatives-top-section-support";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { getTodayIsoForTimeZone } from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";
import {
  fetchMetaCreatives,
  type MetaCreativesResponse,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";

export interface LandingPagesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

const LEGACY_TAB_HREFS: Record<CreativeStudioTabId, string> = {
  assets: "/platforms/meta/creatives",
  copies: "/platforms/meta/copies",
  "landing-pages": "/platforms/meta/landing-pages",
  inbox: "/platforms/meta/creative-inbox",
  audiences: "/platforms/meta/audiences",
};

function downloadCsv(rows: MetaCreativesResponse["rows"]) {
  if (rows.length === 0 || typeof document === "undefined") return;
  const headers = [
    "Destination",
    "Ad id",
    "Spend",
    "Link clicks",
    "Landing page views",
    "Purchases",
    "Purchase value",
    "Currency",
  ];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((row) =>
    [
      row.destination_url,
      row.id,
      row.spend,
      row.link_clicks,
      row.landing_page_views,
      row.purchases,
      row.purchase_value,
      row.currency,
    ]
      .map(escape)
      .join(","),
  );
  const blob = new Blob([[headers.map(escape).join(","), ...body].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "meta-destinations.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function LandingPagesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: LandingPagesPageProps = {}) {
  const pathname = usePathname() || "/platforms/meta/landing-pages";
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const [dashboardRange] = usePersistentDateRange();
  const hasAuthorizedScope = authorizedBusinessId !== undefined;
  const businessId = hasAuthorizedScope ? authorizedBusinessId : storeBusinessId ?? "";
  const requestedProviderAccountId = hasAuthorizedScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : searchParams?.get("providerAccountId")?.trim() ?? "";

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const providerAccountId = hasAuthorizedScope
    ? requestedProviderAccountId
    : requestedProviderAccountId &&
        providerAccounts.some((account) => account.id === requestedProviderAccountId)
      ? requestedProviderAccountId
      : providerAccounts.length === 1
        ? providerAccounts[0]!.id
        : "";
  const account = providerAccounts.find((candidate) => candidate.id === providerAccountId) ?? null;
  const referenceDate = getTodayIsoForTimeZone(account?.timezone || "UTC");
  const creativeRange = standardDateRangeToCreative(dashboardRange);
  const { start, end } = resolveCreativeDateRange(creativeRange, referenceDate);

  const query = useQuery({
    queryKey: ["meta-creative-destinations", businessId, providerAccountId, start, end],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () =>
      fetchMetaCreatives({
        businessId,
        providerAccountId,
        start,
        end,
        groupBy: "ad",
        format: "all",
        sort: "spend",
        mediaMode: "metadata",
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const dataState: CreativeStudioDataState =
    !workspaceResolved && !hasAuthorizedScope
      ? "loading"
      : providerAccountsQuery.isLoading || query.isLoading
        ? "loading"
        : providerAccountsQuery.isError || query.isError
          ? "error"
          : !providerAccountId
            ? "account_required"
            : (query.data?.rows.length ?? 0) > 0
              ? "ready"
              : "empty";
  const message =
    dataState === "loading"
      ? "Loading Meta destinations…"
      : dataState === "error"
        ? "Meta destination data is unavailable."
        : dataState === "account_required"
          ? "Select one assigned Meta ad account."
          : dataState === "empty"
            ? "No Meta-reported destinations are available for this window."
            : null;
  const model = buildCreativeStudioLandingModel({
    rows: query.data?.rows ?? [],
    state: dataState,
    message,
  });
  const tabHrefs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(LEGACY_TAB_HREFS).map(([tab, href]) => [
          tab,
          dashboardHrefForRouteFamily(
            buildMetaScopedHref(href, { businessId, providerAccountId }),
            pathname,
          ),
        ]),
      ) as Record<CreativeStudioTabId, string>,
    [businessId, pathname, providerAccountId],
  );

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: dataState === "loading",
    isFetching: query.isFetching || providerAccountsQuery.isFetching,
    error: query.error ?? providerAccountsQuery.error,
    partialReason: null,
    asOf: measuredAsOf(null),
    businessId: businessId || null,
    onRetry: () => {
      void providerAccountsQuery.refetch();
      if (providerAccountId) void query.refetch();
    },
  });

  if (!hasAuthorizedScope && workspaceResolved && !businessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <main data-testid="landing-pages-studio-page" data-landing-state={dataState}>
        <CreativeStudioExact
          activeTab="landing-pages"
          counts={{ "landing-pages": model.rows.length }}
          landingPages={model}
          onExport={model.rows.length > 0 ? () => downloadCsv(query.data?.rows ?? []) : undefined}
          tabHrefs={tabHrefs}
        />
      </main>
    </PlanGate>
  );
}
