"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { usePreferencesStore } from "@/store/preferences-store";
import {
  DEFAULT_DATE_RANGE,
  getTodayIsoForTimeZone,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";
import {
  DEFAULT_CREATIVE_DATE_RANGE,
  type CreativeDateRangeValue,
} from "@/components/creatives/CreativesTopSection";
import { usePersistentPreferenceValue } from "@/hooks/persistent-date-range-support";
import {
  applyDateWindowToParams,
  canonicalDateWindowParams,
  hrefWithParams,
  readDateWindowFromParams,
} from "@/lib/dashboard/date-window-url";

export const DASHBOARD_V2_DEFAULT_DATE_RANGE: DateRangeValue = {
  ...DEFAULT_DATE_RANGE,
  rangePreset: "28d",
  comparisonPreset: "previousPeriod",
};

/**
 * The window every surface falls back to when the URL states none.
 *
 * This is not a free choice. `MetaPlatformPage`'s `parseMetaWindow(null)`
 * returns `"28d"` and the Intelligence route's `DEFAULT_WINDOW_DAYS` is 28, so
 * an unstated window already means 28 days everywhere below the shell. The
 * shell has to mean the same thing by the same name, or the picker and the
 * body disagree in the very first paint — which is the ITEM 10 defect. Change
 * this only together with those.
 */
export const UNSTATED_DATE_WINDOW: Pick<
  DateRangeValue,
  "rangePreset" | "customStart" | "customEnd"
> = {
  rangePreset: DASHBOARD_V2_DEFAULT_DATE_RANGE.rangePreset,
  customStart: "",
  customEnd: "",
};

/**
 * Dashboard v2 exposes one binary comparison state. Old persisted custom/year
 * presets remain "on", but are narrowed to the only comparison the shell can
 * truthfully name and request.
 */
export function normalizeDashboardV2DateRange(
  value: DateRangeValue,
): DateRangeValue {
  const comparisonPreset =
    value.comparisonPreset === "none" ? "none" : "previousPeriod";
  return {
    ...value,
    comparisonPreset,
    comparisonStart: "",
    comparisonEnd: "",
  };
}

/** The viewer's own clock, used only when a caller states no reference date. */
function browserReferenceDate(): string {
  const timeZone =
    (typeof Intl !== "undefined" &&
      Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "UTC";
  return getTodayIsoForTimeZone(timeZone);
}

/**
 * States the window on the URL the operator is looking at.
 *
 * `history.replaceState` is integrated with the App Router, so `useSearchParams`
 * re-reads it and every client surface on the page moves together. A surface
 * rendered on the server cannot see a store write at all, which is why the URL —
 * not the preferences store — is the authority; the shell control pairs this
 * with a `router.replace` so those surfaces re-render too.
 */
function stateDateWindowOnLocation(
  value: DateRangeValue,
  referenceDate: string,
): void {
  if (typeof window === "undefined") return;
  const params = applyDateWindowToParams(
    new URLSearchParams(window.location.search),
    value,
    referenceDate,
  );
  window.history.replaceState(
    null,
    "",
    hrefWithParams(window.location.pathname, params),
  );
}

/**
 * ITEM 10 — a layout effect, so the URL is canonical before anything reads it.
 *
 * A passive effect runs child-first, i.e. after the body below the shell has
 * already fired its first request. A layout effect on the shell runs before any
 * passive effect in the tree and before the browser paints, so the window is
 * stated first and read second.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The dashboard's date window, read from the URL.
 *
 * The URL is the authority, full stop. It used to share that job with the
 * preferences store — the store answered whenever the URL stated nothing — and
 * that is precisely how one workspace came to show two windows in a single
 * paint: this hook read a persisted 90 days out of localStorage while
 * `MetaPlatformPage` and the server-rendered Intelligence route, which cannot
 * read localStorage at all, both defaulted to 28. Two answers to one question
 * is not a precedence bug that can be fixed by ordering them; it is a second
 * authority, and the fix is to remove it.
 *
 * So a stored selection is no longer a window. It is a SEED, canonicalized into
 * the URL by `useCanonicalDateWindowUrl` (mounted once, by the shell that also
 * mounts the picker), and until it lands there this hook reports
 * `UNSTATED_DATE_WINDOW` — the same 28 days every body already means by an
 * unstated window. The comparison preset is not part of the window and stays a
 * plain preference.
 *
 * @param referenceDate the ISO day this surface calls "today". Supplying it
 * lets a stated window keep its preset label ("Last 28 days") when the dates
 * are exactly that preset's; without one, an exact window is reported as
 * `custom`, which is the honest reading — the dates are used verbatim.
 */
export function usePersistentDateRange(
  referenceDate?: string | null,
): [DateRangeValue, (value: DateRangeValue) => void] {
  const stored = usePreferencesStore((s) => s.dashboardDateRange);
  const set = usePreferencesStore((s) => s.setDashboardDateRange);
  const searchParams = useSearchParams();
  const [value, setValue] = usePersistentPreferenceValue(
    stored,
    set,
    DASHBOARD_V2_DEFAULT_DATE_RANGE,
  );
  const storedRange = normalizeDashboardV2DateRange(value);
  const statedWindow = readDateWindowFromParams(searchParams, {
    referenceDate,
    preferredPreset: storedRange.rangePreset,
  });
  const effective = statedWindow
    ? { ...storedRange, ...statedWindow }
    : { ...storedRange, ...UNSTATED_DATE_WINDOW };

  const setNormalizedValue = useCallback(
    (next: DateRangeValue) => {
      const normalized = normalizeDashboardV2DateRange(next);
      setValue(normalized);
      stateDateWindowOnLocation(
        normalized,
        referenceDate && referenceDate.length > 0
          ? referenceDate
          : browserReferenceDate(),
      );
    },
    [referenceDate, setValue],
  );
  return [effective, setNormalizedValue];
}

/**
 * States the persisted selection on the URL, once, before the first read.
 *
 * Mount this exactly ONCE per page, in the shell that also mounts the picker —
 * two canonicalizers holding two clocks would recreate the disagreement it
 * exists to remove. The shell passes the workspace's own reference date for
 * that reason.
 *
 * Both writes are deliberate and neither is redundant:
 *
 * - `history.replaceState` is integrated with the App Router, so every client
 *   surface's `useSearchParams` re-reads the window with no server round trip
 *   and no history entry.
 * - `navigate` (the shell hands it `router.replace`) is the only way a
 *   SERVER-rendered surface can be told. `app/c/[businessId]/meta/intelligence`
 *   resolves `startDate`/`endDate` on the server; without the navigation it
 *   would keep rendering its own default under a caption naming another window.
 *
 * `enabled` is the fail-closed gate: the caller passes `false` until the shell
 * has CONFIRMED which workspace this is, because the workspace supplies the
 * clock. Expanding "last 7 days" against a placeholder clock and then again
 * against the real one would state two windows in a row, which is the defect
 * wearing a different hat.
 */
export function useCanonicalDateWindowUrl({
  referenceDate,
  enabled,
  navigate,
}: {
  referenceDate: string | null | undefined;
  enabled: boolean;
  navigate: (href: string) => void;
}): void {
  const stored = usePreferencesStore((s) => s.dashboardDateRange);
  const preferencesHydrated = usePreferencesStore((s) => s.hasHydrated);
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useIsomorphicLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!referenceDate) return;
    // Before rehydration `stored` is still the DEFAULT, and writing that into
    // the URL makes it an exact stated window — so the real selection, which
    // arrives one tick later, can no longer state itself. Symptom: pick 90
    // days, reload, and land silently on 28. Waiting costs one paint against
    // a window nobody has stated yet, which is the honest thing to show.
    if (!preferencesHydrated) return;
    const seed = normalizeDashboardV2DateRange(
      stored ?? DASHBOARD_V2_DEFAULT_DATE_RANGE,
    );
    const params = canonicalDateWindowParams(
      new URLSearchParams(window.location.search),
      seed,
      referenceDate,
    );
    // Null means the URL already states an exact window. Restating it would be
    // a second chance to disagree with it, and it also terminates this effect:
    // the write below changes `search`, the re-run finds the window stated, and
    // nothing further is written.
    if (!params) return;
    const href = hrefWithParams(window.location.pathname, params);
    window.history.replaceState(null, "", href);
    navigateRef.current(href);
  }, [enabled, preferencesHydrated, referenceDate, search, stored]);
}

/**
 * Dashboard v2 has one shell-owned date/comparison state. Meta and the command
 * center use that state rather than retaining private comparison presets that
 * can disagree with the fixed "vs previous period" control.
 */
export function usePersistentMetaDateRange(
  referenceDate?: string | null,
): [DateRangeValue, (value: DateRangeValue) => void] {
  return usePersistentDateRange(referenceDate);
}

export function usePersistentCommandCenterDateRange(
  referenceDate?: string | null,
): [DateRangeValue, (value: DateRangeValue) => void] {
  return usePersistentDateRange(referenceDate);
}

/**
 * Persists the Motion (Creatives / Copies) date range value across navigations.
 */
export function usePersistentCreativeDateRange(): [
  CreativeDateRangeValue,
  (value: CreativeDateRangeValue) => void,
] {
  const stored = usePreferencesStore((s) => s.creativeDateRange);
  const set = usePreferencesStore((s) => s.setCreativeDateRange);
  return usePersistentPreferenceValue(stored, set, DEFAULT_CREATIVE_DATE_RANGE);
}
