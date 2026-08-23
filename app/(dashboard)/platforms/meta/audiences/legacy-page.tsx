"use client";

import { useMemo } from "react";
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
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import type { MetaWarehouseFreshness } from "@/lib/meta/warehouse-types";
import { windowFromSearchParams } from "@/lib/zero-base/creative/route-scope";
import { useAppStore } from "@/store/app-store";

export interface MetaAudiencesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
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
  gender:
    "Not measured for this range — the gender split is captured from this sync onward, and days written before it hold only the blended age bucket.",
  frequency:
    "Not measured for this range — reach is requested from this sync onward, and days written before it stored a zero that was never a measurement.",
};

function unavailableBreakdowns(reason: string | null = null): CreativeStudioBreakdown[] {
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
  freshness?: MetaWarehouseFreshness | null;
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
  const ranked = [...rows].sort((left, right) => right.spend - left.spend).slice(0, 8);
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
      readFailureReason?.trim() || payload?.notReadyReason?.trim() || null,
    );
  }
  // A range the warehouse is still backfilling is not a complete one. The panel
  // keeps its rows — they are real — but says the range is incomplete, so a
  // half-filled bar is not read as a finished measurement.
  const partialNote = payload.isPartial
    ? payload.notReadyReason?.trim() || null
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
        return { ...breakdownPanel(id, title, subtitle, gender), note: partialNote };
      }
    }
    if (id === "placement") {
      return { ...breakdownPanel(id, title, subtitle, placement), note: partialNote };
    }
    if (id === "platform") {
      return { ...breakdownPanel(id, title, subtitle, platform), note: partialNote };
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

function readFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

export default function MetaAudiencesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: MetaAudiencesPageProps = {}) {
  const pathname = usePathname() || "/platforms/meta/audiences";
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const businesses = useAppStore((state) => state.businesses);
  const hasAuthorizedScope = authorizedBusinessId !== undefined;
  const businessId = hasAuthorizedScope ? authorizedBusinessId : storeBusinessId ?? "";
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
    (businesses ?? []).find((business) => business.id === businessId)?.timezone ||
    "UTC";
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
      const response = await fetch(`/api/meta/breakdowns?${params.toString()}`, {
        cache: "no-store",
      });
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
      if (!payload) throw new Error("Meta breakdowns returned an unreadable response.");
      return payload;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Five states, because the design declares five. Collapsing loading, error
  // and partial into "empty" told the operator the account has no audience data
  // when the read had simply failed or had not finished.
  const scopeLoading = !hasAuthorizedScope && !workspaceResolved;
  const readError = breakdownsQuery.isError;
  const payload = breakdownsQuery.data ?? null;
  const servedReason = payload?.notReadyReason?.trim() || null;
  const errorText = readError
    ? readFailureMessage(
        breakdownsQuery.error,
        "Audience breakdowns could not be read for this account.",
      )
    : null;
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
          : hasBreakdownRows
            ? "ready"
            : "empty";
  const message =
    state === "loading"
      ? scopeLoading
        ? "Loading the assigned Meta account scope."
        : "Loading audience breakdowns."
      : state === "account_required"
        ? "Select one assigned Meta ad account."
        : state === "error"
          ? errorText
          : state === "ready"
            ? // Rows exist, but say so when the range is still being prepared.
              (payload?.isPartial ? servedReason : null)
            : // Empty. The route names the reason for every non-"ok" status and
              // for a range still backfilling; only a genuinely empty account
              // falls through to the generic sentence.
              (servedReason ??
              "Audience-level creative evidence is unavailable for this assigned Meta account.");
  const model: CreativeStudioAudiencesModel = {
    state,
    message,
    // The caption names the window these breakdowns were measured over,
    // which is the same window the request carried. It used to be the
    // literal "28d", so a 7-day or custom selection was labelled 28 days on
    // screen. Withheld when either bound is unknown rather than defaulted.
    windowLabel: startDate && endDate ? `${startDate} → ${endDate}` : null,
    summaries: Array.from({ length: 4 }, (_, index) => ({
      id: `unavailable-${index + 1}`,
      name: "—",
      status: null,
      tone: "neutral" as const,
      currency: null,
      spend: null,
      roas: null,
      frequency: null,
      note: null,
    })),
    breakdowns,
    matrixColumns: [],
    matrixRows: [],
  };
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
    partialReason: servedReason,
    asOf: measuredAsOf(payload?.freshness?.lastSyncedAt ?? null),
    businessId: businessId || null,
    onRetry: () => {
      void breakdownsQuery.refetch();
    },
  });

  if (!hasAuthorizedScope && workspaceResolved && !businessId) return <BusinessEmptyState />;

  return (
    /*
     * `section`, not `main`. The shell already owns the page's `main` landmark,
     * and a second one on the same page gives a screen-reader user two "main
     * content" targets with no way to tell which is the page. Found by a strict
     * locator resolving `main` to two elements on the mounted route.
     */
    <section data-testid="audiences-studio-page" data-audiences-state={model.state}>
      <CreativeStudioExact
        activeTab="audiences"
        audiences={model}
        counts={buildCreativeStudioTabCounts({})}
        tabHrefs={tabHrefs}
      />
    </section>
  );
}
