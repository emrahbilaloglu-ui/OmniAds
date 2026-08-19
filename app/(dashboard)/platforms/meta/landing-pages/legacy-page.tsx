"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import { buildCreativeStudioLandingModel } from "@/components/creatives/creative-studio-exact-adapters";
import type { CreativeStudioDataState } from "@/components/creatives/creative-studio-exact-types";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { standardDateRangeToCreative } from "@/components/creatives/creatives-top-section-support";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { getTodayIsoForTimeZone } from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { hasDateWindowParams } from "@/lib/dashboard/date-window-url";
import type { CreativeRouteWindow } from "@/lib/zero-base/creative/route-scope";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { buildCreativeStudioTabHrefs } from "@/lib/meta/creative-studio-tab-hrefs";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";
import {
  describeMetaCreativesSourceHealth,
  fetchMetaCreatives,
  type MetaCreativesResponse,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";

export interface LandingPagesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
  /**
   * The window the canonical route parsed out of `?start`/`?end`, validated on
   * the server. `null`/absent means the request named no window — the shell's
   * range then stays in charge rather than a substituted default.
   */
  serverDateWindow?: CreativeRouteWindow | null;
}

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

/**
 * The measured instant behind this table, or null when there is not one.
 *
 * `warehouse_observed_at` is the primary answer and the only one that is
 * always an observation: `/api/meta/creatives` fills it from
 * `MAX(updated_at)` over the very rows it returned — `meta_ad_daily` for this
 * surface's `groupBy=ad` read (see `readMetaCreativesWarehouseObservedAt` in
 * lib/meta/creatives-warehouse.ts). Before it existed this function had nothing
 * to read: the warehouse path never stamps `last_synced_at` at all, so every
 * persisted read here reported "age unknown".
 *
 * `last_synced_at` stays as the snapshot path's fallback, still gated on
 * `snapshot_source`. That gate is the whole point: `buildLiveApiResponse`
 * stamps `last_synced_at: new Date().toISOString()`
 * (lib/meta/creatives-snapshot-helpers.ts), which is the age of the *request*,
 * not of the data — exactly what lib/tier-zero-as-of.ts forbids presenting as
 * a data age. A live read therefore keeps the honest "age unknown" instead of
 * borrowing a reassuring number nobody should trust.
 */
function measuredTableInstant(payload: MetaCreativesResponse | undefined): string | null {
  if (!payload) return null;
  if (payload.warehouse_observed_at) return payload.warehouse_observed_at;
  if (payload.snapshot_source !== "persisted") return null;
  return payload.last_synced_at ?? null;
}

export default function LandingPagesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  serverDateWindow = null,
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
  const shellWindow = resolveCreativeDateRange(creativeRange, referenceDate);
  // A link that names a window renders that window — but only when the shell is
  // not already naming one.
  //
  // The shell's date control states its window on the URL as
  // `?window`/`?startDate`/`?endDate` (`lib/dashboard/date-window-url.ts`) and
  // `usePersistentDateRange` reads that back, so whenever those params are
  // present the range above IS the URL's answer and this prop can only repeat
  // it. What the prop adds is the Creative Studio's own `?start`/`?end`
  // spelling, which the shell does not read: those links used to render
  // whatever range this browser had stored. It steps aside the instant the
  // operator moves the control, because moving it states a window on the URL.
  //
  // The destinations read below is keyed on the result, so the rows are the
  // ones the link asked for.
  const linkWindow = hasDateWindowParams(searchParams) ? null : serverDateWindow;
  const start = linkWindow?.start ?? shellWindow.start;
  const end = linkWindow?.end ?? shellWindow.end;

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

  /**
   * The accounts read only decides the *surface* when it decides the account.
   *
   * On the server-scoped route (app/c/[businessId]/creative/landing-pages) the
   * account is handed to this page, so the accounts read is a lookup for the
   * account's timezone and nothing more. Letting its failure gate `dataState`
   * turned a name/timezone lookup into a total outage: the destinations fetch
   * for that same account had succeeded and its rows were sitting in
   * `query.data`, yet the table rendered "Meta destination data is
   * unavailable." with no rows.
   *
   * In the unscoped branch the accounts read genuinely selects the account, so
   * there its failure IS a surface failure and stays one.
   */
  const scopeLoading = !hasAuthorizedScope && providerAccountsQuery.isLoading;
  const scopeError = !hasAuthorizedScope && providerAccountsQuery.isError;

  /**
   * What the destinations response says about its own source.
   *
   * `/api/meta/creatives` answers HTTP 200 with `rows: []` for
   * `no_connection`, `no_access_token` and `no_accounts_assigned` — verdicts
   * that mean no read was attempted. This surface counted rows and nothing
   * else, so all three rendered as "No Meta-reported destinations are
   * available for this window.": a definite statement about the operator's
   * account, produced by a read that never happened.
   */
  const sourceHealth = describeMetaCreativesSourceHealth(query.data);

  const dataState: CreativeStudioDataState =
    !workspaceResolved && !hasAuthorizedScope
      ? "loading"
      : scopeLoading || query.isLoading
        ? "loading"
        : scopeError || query.isError
          ? "error"
          : !providerAccountId
            ? "account_required"
            : sourceHealth.kind === "unavailable"
              ? "unavailable"
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
          : dataState === "unavailable"
            ? sourceHealth.kind === "unavailable"
              ? sourceHealth.message
              : "Meta destination data could not be read for this scope."
            : dataState === "empty"
              ? "No Meta-reported destinations are available for this window."
              : null;
  const model = {
    ...buildCreativeStudioLandingModel({
      rows: query.data?.rows ?? [],
      state: dataState,
      message,
    }),
    // The subtitle names the window these destination reads cover, which is
    // the window the request carried. It used to be the literal "28d".
    windowLabel: start && end ? `${start} → ${end}` : null,
  };
  /**
   * ITEM 17 — the shared Studio builder, so a tab hop keeps the account AND
   * the window.
   *
   * `dashboardHrefForRouteFamily(buildMetaScopedHref(...))` emitted the business
   * and the account and no dates at all, so every link out of Landers reset the
   * range to whatever the destination had stored — while the four links INTO
   * Landers carried a window. The asymmetry is what made it invisible: the walk
   * worked in one direction.
   *
   * `start`/`end` here are the window this surface actually read its
   * destinations with, so the link states the measured window rather than a
   * separately resolved one.
   */
  const tabHrefs = useMemo(
    () =>
      buildCreativeStudioTabHrefs({
        pathname,
        businessId,
        providerAccountId,
        start,
        end,
      }),
    [businessId, end, pathname, providerAccountId, start],
  );

  /**
   * Ads the table cannot show, counted rather than swallowed.
   *
   * `buildCreativeStudioLandingModel` groups by destination and skips any row
   * whose landing URL could not be resolved
   * (components/creatives/creative-studio-exact-adapters.ts:243-246). Those ads
   * leave the table, the Ads column and the Spend total together, so without a
   * count the page reads as a complete picture of where the money went when it
   * is not. This mirrors that adapter's predicate exactly; if the adapter's
   * skip rule changes, the landing-pages test that pins the two together fails.
   */
  const unresolvedDestinationCount = useMemo(
    () => (query.data?.rows ?? []).filter((row) => !row.destination_url?.trim()).length,
    [query.data?.rows],
  );

  /**
   * Degradations the operator is entitled to see, rather than a silent zero.
   *
   * Both reasons describe a table that rendered successfully but is not the
   * whole truth, which is what "partial" means. The timezone failure belongs
   * here and not in `error`: `deriveTierZeroFreshnessState` ranks error above
   * partial, so routing it through `error` would put the bar back into the
   * total-outage state that claim 1 removed.
   */
  const partialReasons: string[] = [];
  // The server's own statement that this window is not finished yet. It rides
  // on a served table, which is what a partial is; dropping it presented an
  // in-progress window as a complete one.
  if (sourceHealth.kind === "serving" && sourceHealth.partialReason) {
    partialReasons.push(sourceHealth.partialReason);
  }
  if (hasAuthorizedScope && providerAccountsQuery.isError) {
    partialReasons.push("Account timezone could not be read; the window was computed in UTC");
  }
  if (unresolvedDestinationCount > 0) {
    partialReasons.push(
      unresolvedDestinationCount === 1
        ? "1 ad has no resolvable destination and is not in this table"
        : `${unresolvedDestinationCount} ads have no resolvable destination and are not in this table`,
    );
  }

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: dataState === "loading",
    isFetching: query.isFetching || providerAccountsQuery.isFetching,
    // Scoped for the same reason `dataState` is: on the server-scoped route a
    // failed timezone lookup is a partial, not a failed read of the table.
    error: query.error ?? (hasAuthorizedScope ? null : providerAccountsQuery.error),
    partialReason: partialReasons.length > 0 ? partialReasons.join(" · ") : null,
    asOf: measuredAsOf(measuredTableInstant(query.data)),
    businessId: businessId || null,
    onRetry: () => {
      void providerAccountsQuery.refetch();
      if (providerAccountId) void query.refetch();
    },
  });

  if (!hasAuthorizedScope && workspaceResolved && !businessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <main
        data-testid="landing-pages-studio-page"
        data-landing-state={dataState}
        data-landing-source-status={query.data?.status ?? "unread"}
      >
        <CreativeStudioExact
          activeTab="landing-pages"
          counts={buildCreativeStudioTabCounts({})}
          landingPages={model}
          onExport={model.rows.length > 0 ? () => downloadCsv(query.data?.rows ?? []) : undefined}
          tabHrefs={tabHrefs}
        />
      </main>
    </PlanGate>
  );
}
