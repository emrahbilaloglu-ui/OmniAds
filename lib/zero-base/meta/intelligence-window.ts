/**
 * The window Account Intelligence measures, resolved on the server.
 *
 * WHAT WAS WRONG
 * --------------
 * This surface carried a private resolver: a 28-day window ending on the
 * workspace's *today*. Two separate lies came out of it.
 *
 * 1. Today is a partial day. Its spend, revenue and conversions are still
 *    arriving, so counting it as a whole day understates every rate and
 *    inflates every per-day divisor — the same failure the budget-utilisation
 *    invariant names ("must use the actual evidence-window day count"). Every
 *    other surface had already moved to completed days ending yesterday
 *    (`DATE_WINDOW_INCLUDES_CURRENT_DAY`); this one had not, so the shell's
 *    chip and this page's own sentence named two different weeks for one click.
 * 2. `?window=7d` — the preset key the shell itself writes, and the only thing
 *    a hand-typed or truncated link usually carries — was not read at all. The
 *    private resolver looked for `startDate`/`endDate` and nothing else, so
 *    `?window=7d` silently produced 28 days ending today.
 *
 * WHAT WAS STILL WRONG AFTER THE FIRST REPAIR, AND IS FIXED HERE
 * --------------------------------------------------------------
 * The first repair adopted the shared authority's PARSE but kept a private
 * EXPANSION: a local `expandWindowPreset` (its own day-count table and its own
 * ±1 shift), a local `todayIsoInTimeZone`, and a local `recoverPreset` that
 * could only ever name the key the URL already carried. All three existed for
 * exactly one reason, stated in the file at the time: the shared expansion was
 * re-exported from `components/date-range/DateRangePicker.tsx`, a `"use client"`
 * module, so calling `resolveDateWindowFromParams` from a Server Component threw
 *
 *   Attempted to call getPresetDatesForReferenceDate() from the server but
 *   getPresetDatesForReferenceDate is on the client.
 *
 * That constraint is gone. `lib/dashboard/date-window-presets.ts` now owns the
 * vocabulary and the expansion with NO client boundary, and
 * `lib/dashboard/date-window-url.ts` imports the VALUE from it, so the shared
 * resolver runs on a server. The duplicate day-count table, the duplicate day
 * shift and the duplicate timezone reader are therefore deleted rather than
 * pinned by a test: two implementations that agree today are still two places
 * to change, and the surviving one is the authority every other surface reads.
 *
 * WHAT THIS MODULE IS NOW
 * -----------------------
 * The shared resolver, plus one thing the shared resolver deliberately does not
 * have: a default. `resolveDateWindowFromParams` answers `null` when neither the
 * URL nor the caller states a window, because inventing one is a caller's
 * decision. This surface's decision is stated below, once.
 */
import {
  DATE_WINDOW_INCLUDES_CURRENT_DAY,
  resolveDateWindowFromParams,
  type DateWindowSelection,
  type SearchParamsLike,
} from "@/lib/dashboard/date-window-url";
import { getPresetDatesForReferenceDate } from "@/lib/dashboard/date-window-presets";

type WindowPreset = DateWindowSelection["rangePreset"];

/**
 * The canonical default, and the only preset this surface may invent.
 *
 * It is the shell's own default (`DASHBOARD_V2_DEFAULT_DATE_RANGE.rangePreset`,
 * `hooks/use-persistent-date-range.ts`). That hook is a `"use client"` module,
 * so the value cannot be imported here — `intelligence-window.test.ts` asserts
 * the two are the same string instead of letting them drift apart silently.
 */
export const INTELLIGENCE_DEFAULT_WINDOW_PRESET: WindowPreset = "28d";

/**
 * The fallback selection handed to the shared resolver.
 *
 * It is passed as the resolver's `fallback`, not applied afterwards, so the
 * default travels through the same single expansion as every stated preset —
 * completed days, ending yesterday — instead of being expanded by a second rule
 * living here.
 */
const INTELLIGENCE_DEFAULT_SELECTION: DateWindowSelection = {
  rangePreset: INTELLIGENCE_DEFAULT_WINDOW_PRESET,
  customStart: "",
  customEnd: "",
};

/** The window this surface reads, and the preset name that labels it. */
export interface IntelligenceWindow {
  startDate: string;
  endDate: string;
  /**
   * Only a name for the dates above — never re-expanded.
   *
   * It is deliberately not rendered: the topbar already prints the label, and a
   * second place to print it is a second place for the two to disagree. It is
   * returned so a test can assert the server recovered the same name the picker
   * is showing, which is the half of "the topbar and the server agree" that
   * dates alone do not prove. The recovery is now literally the picker's own —
   * `readDateWindowFromParams`, same function, same eleven-preset scan — so
   * agreement is structural rather than coincidental.
   */
  preset: WindowPreset;
}

/**
 * The one window every windowed source on Account Intelligence is scoped to.
 *
 * Precedence is the shared authority's, unchanged and no longer restated here:
 *
 * 1. `startDate` + `endDate`, both ISO and in order — the window, VERBATIM. The
 *    label is whatever preset expands to exactly those two days on this clock,
 *    and `custom` when none does.
 * 2. `window=7d|14d|28d|90d` with no usable pair — expanded exactly once, to
 *    completed days on the workspace clock.
 * 3. Anything else — including a HALF pair (`startDate` with no `endDate`) and a
 *    MALFORMED or INVERTED pair — RESOLVES TO THE CANONICAL DEFAULT. It does not
 *    fail closed.
 *
 * WHY CASE 3 DEFAULTS RATHER THAN FAILING CLOSED. It is a fallback, not a
 * repair, and that distinction is the whole of it.
 * `?startDate=2026-08-01&endDate=nope` does not become 08-01..08-01, and it does
 * not become 08-01..today: a window nobody asked for wearing the shape of the
 * one they typed is indistinguishable from a correct answer, which is the one
 * outcome that must never ship. The shared authority already refuses to repair
 * such a pair — it returns null for it — and every client surface answers that
 * null with its stored range. Failing closed here would make Intelligence the
 * one surface that goes blank where the rest keep reading, and a blank page is
 * not more honest than a stated window: the view prints the resolved dates
 * verbatim ("Every windowed source below covers X to Y"), so what is on screen
 * is always the window that was actually measured. The default is the shell's
 * own default preset, so the fallback is the same length the shell falls back to.
 *
 * The residual gap is stated rather than papered over: when the URL carries no
 * usable window AND no `window` key, the topbar falls back to this browser's
 * stored preset while the server falls back to the canonical default.
 * localStorage does not reach a server, so the two can name different lengths
 * for one paint — until `useCanonicalDateWindowUrl` writes the stored selection
 * onto the URL and navigates, at which point both read the same thing. A
 * `window` key alone is enough to close it without that round trip, which is
 * why case 2 exists.
 */
export function resolveIntelligenceWindow(input: {
  searchParams: SearchParamsLike | null | undefined;
  /** The ISO day the workspace calls "today". */
  referenceDate: string;
}): IntelligenceWindow {
  const { searchParams, referenceDate } = input;

  const resolved = resolveDateWindowFromParams(
    searchParams,
    referenceDate,
    INTELLIGENCE_DEFAULT_SELECTION,
  );

  if (resolved) {
    return {
      startDate: resolved.start,
      endDate: resolved.end,
      preset: resolved.preset,
    };
  }

  // Unreachable while a fallback selection is supplied: the shared resolver
  // answers null only when neither the URL nor the fallback states a window.
  // It is handled rather than asserted away because a `!` here would be a claim
  // about another module's control flow. The default is expanded by the SAME
  // shared function the resolver would have used, so even this branch cannot
  // become a second expansion rule.
  const fallback = getPresetDatesForReferenceDate(
    INTELLIGENCE_DEFAULT_WINDOW_PRESET,
    referenceDate,
    "",
    "",
    { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
  );
  return {
    startDate: fallback.start,
    endDate: fallback.end,
    preset: INTELLIGENCE_DEFAULT_WINDOW_PRESET,
  };
}
