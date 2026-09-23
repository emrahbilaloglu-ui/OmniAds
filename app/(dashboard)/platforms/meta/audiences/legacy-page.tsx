"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import type {
  CreativeStudioAudiencesModel,
  CreativeStudioBreakdown,
  CreativeStudioTone,
} from "@/components/creatives/creative-studio-exact-types";
import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { DATE_WINDOW_INCLUDES_CURRENT_DAY } from "@/lib/dashboard/date-window-url";
import { buildCreativeStudioTabHrefs } from "@/lib/meta/creative-studio-tab-hrefs";
import type { MetaResponseEnvelope } from "@/lib/meta/read-state-contract";
import {
  resolveMetaSurfaceReadState,
  type MetaSurfaceSource,
} from "@/lib/meta/surface-read-state";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import type { MetaWarehouseFreshness } from "@/lib/meta/warehouse-types";
import { windowFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import { useAppStore } from "@/store/app-store";
import { publishMetaSurfaceState } from "@/components/meta/meta-surface-state-live";

export interface MetaAudiencesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
  /** The page's already-authorized scope and permission envelope. */
  initialReadState?: MetaResponseEnvelope<null>;
}

const BREAKDOWN_TITLES = [
  ["frequency", "Frequency", "exposures / user"],
  ["age", "Age", "spend share · ROAS"],
  ["gender", "Gender", "spend share · ROAS"],
  ["placement", "Placement", "spend share · ROAS"],
  ["platform", "Platform", "spend share · ROAS"],
] as const;

/**
 * Why a panel that can never fill is empty.
 *
 * The two dimensions are not merely absent from this account — the pipeline
 * behind this screen cannot express them. Gender is summed away at the write
 * (the `age,gender` fetch is keyed by age alone), and reach is never requested,
 * so exposures per user has no numerator. An em dash alone would let the
 * operator read "this account has no gender split", which is a different and
 * false fact, so the panel states the reason in the note slot the design
 * already renders.
 */
const WITHHELD_BREAKDOWN_NOTES: Record<string, string> = {
  gender: "Gender breakdown is unavailable for this date range.",
  frequency: "Frequency is unavailable for this date range.",
};

function unavailableBreakdowns(
  reason: string | null = null,
): CreativeStudioBreakdown[] {
  return BREAKDOWN_TITLES.map(([id, title, subtitle]) => ({
    id,
    title,
    subtitle,
    // A read that failed says so on every panel. Silence here would present the
    // failure as an account with nothing in it.
    note: reason,
    rows: [],
  }));
}

interface BreakdownApiRow {
  key: string;
  label: string;
  spend: number;
  purchases: number;
  revenue: number;
  clicks: number;
  impressions: number;
}

interface BreakdownApiResponse {
  status?: string;
  age?: BreakdownApiRow[];
  /**
   * The second dimension of the same age,gender fetch. Optional because a
   * day written before the write-path fold was removed carries none, and an
   * absent split is a different fact from a measured one.
   */
  gender?: BreakdownApiRow[];
  placement?: BreakdownApiRow[];
  isPartial?: boolean;
  notReadyReason?: string | null;
  emptyObserved?: boolean;
  emptyObservedAt?: string | null;
  freshness?: MetaWarehouseFreshness | null;
}

/**
 * Convert the breakdown request's outcome into the shared surface vocabulary.
 *
 * A provider/integration refusal is not an empty account. An answered `ok`
 * payload with no rows is proven empty only when a finalized breakdown slice
 * explicitly carries that result and its observation instant. A generic
 * warehouse timestamp may belong to another dimension, so it cannot prove this
 * view empty. Keeping the mapping pure prevents the body state and the §9
 * banner from drifting apart.
 */
export function audienceBreakdownSurfaceSource(input: {
  payload: BreakdownApiResponse | null;
  readFailed: boolean;
}): MetaSurfaceSource {
  const { payload, readFailed } = input;
  if (readFailed) {
    return {
      id: "breakdowns",
      outcome: "failed",
      rowCount: 0,
      failureCode: "source_read_failed",
    };
  }
  if (!payload || payload.status !== "ok") {
    return {
      id: "breakdowns",
      outcome: "not-ready",
      rowCount: 0,
      failureCode:
        payload?.status === "no_access_token"
          ? "provider_auth_expired"
          : "source_read_failed",
    };
  }
  const rowCount =
    (payload.age?.length ?? 0) +
    (payload.gender?.length ?? 0) +
    (payload.placement?.length ?? 0);
  const sourceIsPartial =
    payload.isPartial === true ||
    payload.freshness?.isPartial === true ||
    (payload.freshness?.missingWindows?.length ?? 0) > 0 ||
    Boolean(payload.notReadyReason?.trim());
  if (sourceIsPartial) {
    return {
      id: "breakdowns",
      outcome: "partial",
      rowCount,
    };
  }
  const hasTimestampedEmptyEvidence =
    payload.emptyObserved === true &&
    typeof payload.emptyObservedAt === "string" &&
    payload.emptyObservedAt.trim().length > 0;
  if (rowCount === 0 && !hasTimestampedEmptyEvidence) {
    return {
      id: "breakdowns",
      outcome: "not-ready",
      rowCount: 0,
      failureCode: "source_read_failed",
    };
  }
  return {
    id: "breakdowns",
    outcome: rowCount > 0 ? "served" : "empty",
    rowCount,
  };
}

/**
 * The client may only finish the page's provisional loading state.
 *
 * A server-owned refusal or degraded scope is already the stronger fact. The
 * breakdown request cannot overturn it, and publishing a second envelope would
 * replace a precise scope failure with a generic source failure.
 */
export function mayPublishAudienceBreakdownState(
  initialReadState: MetaResponseEnvelope<null> | null | undefined,
): boolean {
  return !initialReadState || initialReadState.state === "loading";
}

function toneForRoas(roas: number | null): CreativeStudioTone {
  if (roas === null) return "neutral";
  if (roas >= 2) return "positive";
  return roas >= 1 ? "warning" : "negative";
}

/**
 * One breakdown panel from the served rows.
 *
 * Spend share is each row's spend over the panel's own total — a proportion of
 * what the server returned, not of the account — expressed as a percentage,
 * which is the unit the bar and its caption both read (`--share: {n}%`,
 * `formatPercent(share, 0)`). ROAS is `revenue / spend`, the two figures the
 * same row carries; a row with no spend has no ROAS rather than a zero, because
 * "we spent nothing here" and "we earned nothing here" are different facts.
 */
function breakdownPanel(
  id: string,
  title: string,
  subtitle: string,
  rows: BreakdownApiRow[],
): CreativeStudioBreakdown {
  const total = rows.reduce((sum, row) => sum + (row.spend || 0), 0);
  const ranked = [...rows]
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 8);
  return {
    id,
    title,
    subtitle,
    note: null,
    rows: ranked.map((row) => {
      const roas = row.spend > 0 ? row.revenue / row.spend : null;
      return {
        id: `${id}-${row.key}`,
        label: row.label,
        spendShare: total > 0 ? (row.spend / total) * 100 : null,
        roas,
        tone: toneForRoas(roas),
      };
    }),
  };
}

/**
 * Publisher platform, regrouped from the placement rows the server already
 * returned.
 *
 * The route emits placement keys as `platform|position|device`
 * (`facebook|feed|iphone`), so the platform is a component the server produced —
 * summing the rows that share it is a regrouping, not a new measure. Rows whose
 * key does not carry that shape are left out rather than bucketed as unknown.
 */
function platformRowsFrom(placement: BreakdownApiRow[]): BreakdownApiRow[] {
  const byPlatform = new Map<string, BreakdownApiRow>();
  for (const row of placement) {
    const platform = row.key.split("|")[0]?.trim();
    if (!platform || !row.key.includes("|")) continue;
    const current = byPlatform.get(platform) ?? {
      key: platform,
      label: platform,
      spend: 0,
      purchases: 0,
      revenue: 0,
      clicks: 0,
      impressions: 0,
    };
    byPlatform.set(platform, {
      ...current,
      spend: current.spend + (row.spend || 0),
      purchases: current.purchases + (row.purchases || 0),
      revenue: current.revenue + (row.revenue || 0),
      clicks: current.clicks + (row.clicks || 0),
      impressions: current.impressions + (row.impressions || 0),
    });
  }
  return [...byPlatform.values()];
}

export function buildAudienceBreakdowns(
  payload: BreakdownApiResponse | null,
  readFailureReason?: string | null,
): CreativeStudioBreakdown[] {
  if (!payload || payload.status !== "ok") {
    return unavailableBreakdowns(
      readFailureReason?.trim() || payload?.notReadyReason
        ? "Audience data is unavailable. Try again."
        : null,
    );
  }
  // A range the warehouse is still backfilling is not a complete one. The panel
  // keeps its rows — they are real — but says the range is incomplete, so a
  // half-filled bar is not read as a finished measurement.
  const partialNote = payload.isPartial
    ? "Some audience data is unavailable. Try again."
    : null;
  const age = payload.age ?? [];
  const gender = payload.gender ?? [];
  const placement = payload.placement ?? [];
  const platform = platformRowsFrom(placement);
  return BREAKDOWN_TITLES.map(([id, title, subtitle]) => {
    if (id === "age") {
      return { ...breakdownPanel(id, title, subtitle, age), note: partialNote };
    }
    if (id === "gender") {
      // Served now that the write path keeps the two dimensions apart. A day
      // written before that holds no gender rows at all, so an empty list
      // still falls through to the withheld note rather than drawing an
      // empty panel that reads as "this account has no gender split".
      if (gender.length > 0) {
        return {
          ...breakdownPanel(id, title, subtitle, gender),
          note: partialNote,
        };
      }
    }
    if (id === "placement") {
      return {
        ...breakdownPanel(id, title, subtitle, placement),
        note: partialNote,
      };
    }
    if (id === "platform") {
      return {
        ...breakdownPanel(id, title, subtitle, platform),
        note: partialNote,
      };
    }
    // Gender and frequency stay empty: the breakdown read returns neither, and
    // neither can be derived from what it does return. The note names which of
    // the two facts is missing so the emptiness cannot be misread as a measured
    // absence.
    return {
      id,
      title,
      subtitle,
      note: WITHHELD_BREAKDOWN_NOTES[id] ?? null,
      rows: [],
    };
  });
}

export default function MetaAudiencesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  initialReadState,
}: MetaAudiencesPageProps = {}) {
  const pathname = usePathname() || "/platforms/meta/audiences";
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const businesses = useAppStore((state) => state.businesses);
  const hasAuthorizedScope = authorizedBusinessId !== undefined;
  const businessId = hasAuthorizedScope
    ? authorizedBusinessId
    : (storeBusinessId ?? "");
  const providerAccountId = hasAuthorizedScope
    ? authorizedProviderAccountId?.trim() || null
    : searchParams?.get("providerAccountId")?.trim() || null;

  /**
   * ITEM 17 — the window this screen measures, resolved by ONE reader that
   * understands BOTH live URL spellings.
   *
   * This page used to read `?start`/`?end` alone, through
   * `scopeFromSearchParams`. The shell's own date control does not write that
   * pair: it writes `?window`/`?startDate`/`?endDate`
   * (`lib/dashboard/date-window-url.ts`). So moving the control at the top of
   * the screen changed the caption and not one parameter of the request below
   * it, and every tab link that arrived carrying the shell spelling was read as
   * naming no window at all.
   *
   * `windowFromSearchParams` is the common resolver: it reads the shell's pair
   * first and the Studio's legacy `start`/`end` second, and
   * `route-window.test.ts` pins its spellings against the module that owns
   * them. Precedence matters and is not incidental — the shell's pair is the one
   * the operator's own control just wrote, so a stale Studio pair further along
   * the query cannot outrank the range they chose a moment ago.
   *
   * A malformed, half or inverted pair is reported as no window and falls
   * through to the shell's range; it is never repaired into a plausible-looking
   * one, because a mistyped URL must not become authority for what was read.
   */
  const linkWindow = useMemo(
    () =>
      windowFromSearchParams({
        startDate: searchParams?.get("startDate") ?? undefined,
        endDate: searchParams?.get("endDate") ?? undefined,
        start: searchParams?.get("start") ?? undefined,
        end: searchParams?.get("end") ?? undefined,
      }),
    [searchParams],
  );

  /**
   * What the shell says when the URL says nothing.
   *
   * The fallback used to be `defaultCreativeWindow(new Date())` — 28 days
   * ending TODAY on the runner's UTC clock. The shell's unstated default is 28
   * days ending YESTERDAY on the WORKSPACE clock, because today is a part day
   * (`DATE_WINDOW_INCLUDES_CURRENT_DAY`). Two constants that both call
   * themselves "28 days" and name different days is the exact defect this wave
   * exists to remove, so this surface expands the shell's own selection with
   * the shell's own rule instead of keeping a second 28.
   *
   * The timezone is the workspace's, read from the same store the topbar reads
   * (`components/layout/v2/app-topbar.tsx`), so "today" means the same day here
   * as it does in the control. An unknown business falls back to UTC rather
   * than to the viewer's browser timezone, which is nobody's measurement.
   */
  const [dashboardRange] = usePersistentDateRange();
  const workspaceTimeZone =
    (businesses ?? []).find((business) => business.id === businessId)
      ?.timezone || "UTC";
  const { start: startDate, end: endDate } = useMemo(() => {
    if (linkWindow) return linkWindow;
    return getPresetDatesForReferenceDate(
      dashboardRange.rangePreset,
      getTodayIsoForTimeZone(workspaceTimeZone),
      dashboardRange.customStart,
      dashboardRange.customEnd,
      { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
    );
  }, [
    dashboardRange.customEnd,
    dashboardRange.customStart,
    dashboardRange.rangePreset,
    linkWindow,
    workspaceTimeZone,
  ]);
  // The breakdown read this screen draws has existed all along at
  // /api/meta/breakdowns; the page simply never called it, so every panel
  // rendered an em dash while the warehouse held the spend behind them.
  const breakdownsQuery = useQuery({
    queryKey: [
      "meta-audience-breakdowns",
      businessId,
      providerAccountId,
      startDate,
      endDate,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: async () => {
      const params = new URLSearchParams({
        businessId,
        providerAccountId: providerAccountId!,
        startDate,
        endDate,
      });
      const response = await fetch(
        `/api/meta/breakdowns?${params.toString()}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response
        .json()
        .catch(() => null)) as BreakdownApiResponse | null;
      if (!response.ok) {
        // The served reason, when there is one, beats a generic sentence: a 500,
        // a disconnected integration and an expired token are different facts.
        throw new Error(
          payload?.notReadyReason?.trim() ||
            `Meta breakdowns could not be read (${response.status}).`,
        );
      }
      if (!payload)
        throw new Error("Meta breakdowns returned an unreadable response.");
      return payload;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Six states, because the design separates a provider non-read from a failed
  // HTTP read and from a measured empty result. Collapsing any of those into
  // "empty" tells the operator the account has no audience data when the read
  // did not establish that fact.
  const scopeLoading = !hasAuthorizedScope && !workspaceResolved;
  const readError = breakdownsQuery.isError;
  const payload = breakdownsQuery.data ?? null;
  const servedReason = payload?.notReadyReason?.trim() || null;
  const errorText = readError
    ? "Audience data could not be loaded. Try again."
    : null;
  const breakdownSource = useMemo(
    () =>
      audienceBreakdownSurfaceSource({
        payload,
        readFailed: readError,
      }),
    [payload, readError],
  );
  const breakdowns = useMemo(
    () => buildAudienceBreakdowns(payload, errorText),
    [payload, errorText],
  );
  const hasBreakdownRows = breakdowns.some((panel) => panel.rows.length > 0);
  const state: CreativeStudioAudiencesModel["state"] = scopeLoading
    ? "loading"
    : !providerAccountId
      ? "account_required"
      : breakdownsQuery.isLoading
        ? "loading"
        : readError
          ? "error"
          : breakdownSource.outcome === "failed" ||
              breakdownSource.outcome === "not-ready" ||
              (breakdownSource.outcome === "partial" && !hasBreakdownRows)
            ? "unavailable"
            : hasBreakdownRows
              ? "ready"
              : "empty";
  const message =
    state === "loading"
      ? scopeLoading
        ? "Loading Meta accounts."
        : "Loading audience breakdowns."
      : state === "account_required"
        ? "Select a Meta ad account to view audiences."
        : state === "error"
          ? errorText
          : state === "unavailable"
            ? "Audience breakdowns are unavailable for this date range."
            : state === "ready"
              ? // Rows exist, but say so when the range is still being prepared.
                payload?.isPartial
                ? "Some audience data is unavailable. Try again."
                : null
              : // Empty. The route names the reason for every non-"ok" status and
                // for a range still backfilling; only a genuinely empty account
                // falls through to the generic sentence.
                "No audience breakdowns found for this date range.";
  const model: CreativeStudioAudiencesModel = {
    state,
    message,
    // The caption names the window these breakdowns were measured over,
    // which is the same window the request carried. It used to be the
    // literal "28d", so a 7-day or custom selection was labelled 28 days on
    // screen. Withheld when either bound is unknown rather than defaulted.
    windowLabel: startDate && endDate ? `${startDate} → ${endDate}` : null,
    // This reader has no audience-summary source. Empty placeholder cards add
    // four blank panels without helping the operator, so only measured
    // breakdown rows are rendered.
    summaries: [],
    breakdowns,
    matrixColumns: [],
    matrixRows: [],
  };

  /**
   * Close the server page's initial `loading` envelope with the request that
   * actually powers this tab. Without this publication the body can finish and
   * render an empty/error/ready state while the shared surface banner remains
   * `loading` forever.
   */
  useEffect(() => {
    if (!mayPublishAudienceBreakdownState(initialReadState)) {
      publishMetaSurfaceState("creative-audiences", null);
      return;
    }
    if (!hasAuthorizedScope || !providerAccountId) {
      publishMetaSurfaceState("creative-audiences", null);
      return;
    }
    if (scopeLoading || breakdownsQuery.isLoading) {
      publishMetaSurfaceState("creative-audiences", null);
      return;
    }
    publishMetaSurfaceState(
      "creative-audiences",
      resolveMetaSurfaceReadState({
        businessId,
        providerAccountId,
        requiresProviderAccount: true,
        permissions: initialReadState?.permissions ?? {
          role: null,
          reviewerReadOnly: false,
          demo: false,
        },
        capability: initialReadState?.capability ?? {
          canRead: true,
          canWrite: false,
        },
        sources: [breakdownSource],
        refreshing:
          breakdownsQuery.isFetching && breakdownSource.outcome !== "empty",
        evidence: {
          sourceUpdatedAt:
            payload?.emptyObservedAt ??
            payload?.freshness?.lastSyncedAt ??
            null,
          observedAt:
            payload?.emptyObservedAt ??
            payload?.freshness?.lastSyncedAt ??
            null,
          window: { startDate, endDate },
        },
      }),
    );
  }, [
    businessId,
    breakdownSource,
    breakdownsQuery.isFetching,
    breakdownsQuery.isLoading,
    endDate,
    hasAuthorizedScope,
    initialReadState,
    payload,
    providerAccountId,
    readError,
    scopeLoading,
    startDate,
  ]);
  /**
   * ITEM 17 — the shared Studio builder, so a tab hop keeps the account AND
   * the window.
   *
   * These links used to be built by `dashboardHrefForRouteFamily(
   * buildMetaScopedHref(...))`, which emits the business and the account and no
   * dates whatsoever. Audiences -> Assets therefore dropped the range every
   * time, and the destination silently substituted its own stored preference:
   * two screens, two windows, one walk, and a caption on each naming only its
   * own.
   */
  const tabHrefs = useMemo(
    () =>
      buildCreativeStudioTabHrefs({
        pathname,
        businessId,
        providerAccountId: providerAccountId ?? "",
        start: startDate,
        end: endDate,
      }),
    [businessId, endDate, pathname, providerAccountId, startDate],
  );

  // The freshness bar reports THIS screen's read, not the workspace resolve it
  // used to report alone: an in-flight fetch, the fetch's own error, a retry
  // that re-runs it, and the warehouse's own observation time. `asOf` stays null
  // whenever the route serves no measured instant — "age unknown" beats a
  // number invented from this machine's clock.
  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: scopeLoading || breakdownsQuery.isLoading,
    isFetching: breakdownsQuery.isFetching,
    error: breakdownsQuery.error ?? null,
    partialReason: servedReason
      ? "Some audience data is unavailable. Try again."
      : null,
    asOf: measuredAsOf(payload?.freshness?.lastSyncedAt ?? null),
    businessId: businessId || null,
    onRetry: () => {
      void breakdownsQuery.refetch();
    },
  });

  if (!hasAuthorizedScope && workspaceResolved && !businessId)
    return <BusinessEmptyState />;

  return (
    /*
     * `section`, not `main`. The shell already owns the page's `main` landmark,
     * and a second one on the same page gives a screen-reader user two "main
     * content" targets with no way to tell which is the page. Found by a strict
     * locator resolving `main` to two elements on the mounted route.
     */
    <section
      data-testid="audiences-studio-page"
      data-audiences-state={model.state}
    >
      <CreativeStudioExact
        activeTab="audiences"
        audiences={model}
        counts={buildCreativeStudioTabCounts({})}
        tabHrefs={tabHrefs}
      />
    </section>
  );
}
