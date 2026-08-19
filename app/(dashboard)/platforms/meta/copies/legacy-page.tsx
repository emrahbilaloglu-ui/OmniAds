"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { buildCreativeStudioTabHrefs } from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import {
  describeCopiesRowsClock,
  mapApiRowToCopyRow,
  resolveCopiesFreshness,
  type CopyMotionRow,
  type MetaCopiesResponse,
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
import { hasDateWindowParams } from "@/lib/dashboard/date-window-url";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import type { CreativeRouteWindow } from "@/lib/zero-base/creative/route-scope";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { useAppStore } from "@/store/app-store";

export interface CopiesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
  /**
   * The window the canonical route parsed out of `?start`/`?end`, validated on
   * the server. `null`/absent means the request named no window, which is not
   * the same as asking for a default — the shell's range stays in charge.
   */
  serverDateWindow?: CreativeRouteWindow | null;
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

interface CommercialTargetsResponse {
  snapshot?: {
    targetPack?: { targetRoas?: number | null } | null;
  } | null;
}

async function fetchCommercialTargetRoas(
  businessId: string,
): Promise<CommercialTargetsResponse> {
  const response = await fetch(
    `/api/business-commercial-settings?businessId=${encodeURIComponent(businessId)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Commercial targets could not be read (${response.status}).`);
  }
  return (await response.json()) as CommercialTargetsResponse;
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

/**
 * There is still no `launchpadHref` here, and there will not be one.
 *
 * It built `/…/meta/launchpad?providerAccountId=…` and the drawer put that one
 * URL on every alternate's "Draft" control under a footnote claiming the line's
 * evidence was attached. The URL carried no copy id, no alternate text, no
 * evidence window and no lineage, and a URL parameter cannot mint any of them.
 *
 * What carries the line now is `mintCopyLaunchpadHandoff` below: a POST the
 * SERVER answers by re-reading the served copy for that creative and window,
 * refusing any line Meta did not serve, and persisting an account-scoped,
 * single-use record. Only the resulting reference travels in the URL, and the
 * Launchpad route re-verifies and burns it server-side.
 */

interface CopyHandoffMintResult {
  ok: boolean;
  handoff: string | null;
  message: string | null;
}

/**
 * Asks the server to prepare a Launchpad draft for one alternate line.
 *
 * The body NAMES a creative, a window and a line. It asserts nothing: the
 * server decides whether that line was served, what the selection is, and what
 * authority (none) the resulting record carries.
 */
async function mintCopyLaunchpadHandoff(input: {
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  alternateText: string;
  start: string;
  end: string;
}): Promise<CopyHandoffMintResult> {
  let response: Response;
  try {
    response = await fetch("/api/meta/launchpad-handoff/copy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(input),
    });
  } catch {
    return {
      ok: false,
      handoff: null,
      message: "The launch handoff service could not be reached.",
    };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  const message =
    typeof payload?.message === "string" && payload.message.trim()
      ? payload.message
      : null;
  const handoff =
    typeof payload?.handoff === "string" && payload.handoff.trim()
      ? payload.handoff
      : null;
  if (!response.ok || !handoff) {
    // Never invent a success sentence for a refusal, and never invent a reason
    // the server did not give.
    return {
      ok: false,
      handoff: null,
      message: message ?? "The launch draft was refused.",
    };
  }
  return { ok: true, handoff, message };
}
export default function CopiesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  serverDateWindow = null,
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
  const shellWindow = resolveCreativeDateRange(
    standardDateRangeToCreative(dashboardDateRange),
  );
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
  // This is the one Studio surface whose preset is resolved with no reference
  // date, i.e. against the browser clock, so before this the same "28d" link
  // could open on two different windows for two operators. A stated window
  // removes the clock from the answer entirely.
  const linkWindow = hasDateWindowParams(searchParams) ? null : serverDateWindow;
  const start = linkWindow?.start ?? shellWindow.start;
  const end = linkWindow?.end ?? shellWindow.end;
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

  // The drawer's ROAS tile reads "target —" unless the operator's own target
  // pack is read. This is the same authority every other target-aware surface
  // uses (`/api/business-commercial-settings` → snapshot.targetPack), and it is
  // business-scoped, so it is not gated on the account scope. A failed or
  // unconfigured read stays null and the tile keeps its honest em dash.
  const commercialTargetsQuery = useQuery<CommercialTargetsResponse>({
    queryKey: ["copies-commercial-targets", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchCommercialTargetRoas(businessId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const rawTargetRoas = commercialTargetsQuery.data?.snapshot?.targetPack?.targetRoas;
  const targetRoas =
    typeof rawTargetRoas === "number" && Number.isFinite(rawTargetRoas) && rawTargetRoas > 0
      ? rawTargetRoas
      : null;

  // ITEM 16 — the endpoint's freshness lineage, bound to the bar.
  //
  // The page used to declare its own narrower `MetaCopiesResponse` carrying
  // only `warehouseObservedAt`, and read exactly that. Four facts
  // `/api/meta/copies` publishes were therefore dropped on the floor —
  // `isPartial`, `notReadyReason`, `readSource` and `rowsObservedAt` — and
  // `resolveCopiesFreshness` had no importer at all outside its own test, so
  // the endpoint half reached no pixel.
  //
  // TWO CLOCKS, KEPT APART, which is why `warehouseObservedAt` is not read here
  // any more. It is `MAX(updated_at)` over the warehouse for this window. The
  // copies route builds its rows from `/api/meta/creatives`, and on the
  // current-day and fallback paths that reads Meta LIVE and touches no
  // warehouse row — so on those paths the warehouse instant is the age of
  // DIFFERENT data than the table shows. `rowsObservedAt` is the warehouse
  // instant only when `readSource === "warehouse"`, and null otherwise; null
  // renders "age unknown", and the surface says which clock it is using by
  // appending the live-read note to the partial reason.
  const copiesFreshness = resolveCopiesFreshness(copiesQuery.data);

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isLoading) ||
      copiesQuery.isLoading,
    isFetching:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isFetching) ||
      copiesQuery.isFetching,
    error: copiesQuery.error ?? providerAccountsQuery.error,
    // `resolveCopiesFreshness` already refuses anything that is not a measured
    // instant, and this restates that law at the surface boundary — the same
    // sentence every other Tier-0 surface writes, and the one
    // `lib/tier-zero-as-of.test.ts` reads back. `measuredAsOf` is idempotent on
    // an ISO instant, so this narrows and never widens.
    asOf: measuredAsOf(copiesFreshness.asOf),
    partialReason: copiesFreshness.partialReason,
    businessId: businessId || null,
    onRetry: () => {
      if (!hasAuthorizedProviderScope && providerAccountsQuery.isError) {
        void providerAccountsQuery.refetch();
      }
      if (hasExplicitAccountScope) void copiesQuery.refetch();
    },
  });

  // No client-side ad counting. `?groupBy=copy` already merged the per-ad rows,
  // so grouping the served rows again could only ever answer 1; the count
  // travels on each row as `associated_ads_count` and the mapper reads it.
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
  // The lineage sentence the operator can actually read, in the Copy
  // performance header pill. The shell's age pill is one number and cannot say
  // whose clock it is; `partialReason` is the server's own words about an
  // incomplete window, and the clock note names the source when the window is
  // complete. Nothing here invents a reason — both strings come from the
  // endpoint's published metadata.
  const copiesLineageNote =
    copiesFreshness.partialReason ?? describeCopiesRowsClock(copiesQuery.data);

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
    return {
      ...base,
      angles: angles.slice(0, 4),
      insight: copiesLineageNote,
      // The subtitle names the window these rows were measured over, which is
      // the window the request carried. It used to be the literal "28d".
      windowLabel: start && end ? `${start} → ${end}` : null,
    };
  }, [copiesLineageNote, end, message, rows, start, state]);
  const activeDetailRow = useMemo(
    () => rows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, rows],
  );
  const closeDetailDrawer = useCallback(() => setDetailRowId(null), []);
  const drawerPeers = useMemo(() => rows.map(toCopyDrawerRow), [rows]);

  /**
   * Preparing a Launchpad draft for one alternate line.
   *
   * All three scope facts have to be established before the control is offered:
   * without a business, an assigned account and a window there is nothing to
   * name to the endpoint, and offering the control would promise a refusal.
   */
  const [draftPending, setDraftPending] = useState(false);
  const [draftStatusMessage, setDraftStatusMessage] = useState<string | null>(
    null,
  );
  const draftingAvailable = Boolean(businessId && providerAccountId && start && end);
  const handleDraftAlternate = useCallback(
    (alternate: { text?: string | number | null }) => {
      const creativeId = activeDetailRow?.creativeId?.trim() ?? "";
      const alternateText =
        typeof alternate.text === "string" ? alternate.text.trim() : "";
      if (!draftingAvailable || !creativeId || !alternateText) return;
      setDraftPending(true);
      setDraftStatusMessage(null);
      void mintCopyLaunchpadHandoff({
        businessId,
        providerAccountId,
        creativeId,
        alternateText,
        start,
        end,
      })
        .then((result) => {
          if (!result.ok || !result.handoff) {
            setDraftStatusMessage(result.message);
            return;
          }
          // Only the reference travels. No copy text, no creative id, no window
          // and no lineage ride in the URL — Launchpad reads all of that back
          // out of the record it re-verifies server-side.
          window.location.assign(
            buildMetaScopedHref(
              "/platforms/meta/launchpad",
              { businessId, providerAccountId },
              { handoff: result.handoff },
            ),
          );
        })
        .finally(() => setDraftPending(false));
    },
    [
      activeDetailRow?.creativeId,
      businessId,
      draftingAvailable,
      end,
      providerAccountId,
      start,
    ],
  );
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
            draftPending={draftPending}
            onClose={closeDetailDrawer}
            onDraftAlternate={draftingAvailable ? handleDraftAlternate : undefined}
            viewModel={buildCopyDetailDrawerExactViewModel({
              row: toCopyDrawerRow(activeDetailRow),
              peers: drawerPeers,
              targetRoas,
              draftingAvailable,
              draftStatusMessage,
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
    // The provider creative, which is what the handoff endpoint names. The row
    // id is a synthetic copy-bucket key and names no provider object.
    creativeId: row.creativeId ?? null,
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
