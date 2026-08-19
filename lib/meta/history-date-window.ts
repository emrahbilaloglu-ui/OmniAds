/**
 * ITEM 12 — the window Meta History reads, resolved on the server.
 *
 * WHAT WAS WRONG, IN TWO STAGES
 * -----------------------------
 * First, the route read `from: null, to: null` unconditionally. The shell above
 * it stated a window and wrote `startDate`/`endDate` into the URL, and History
 * answered a different question entirely: every entry ever recorded for the
 * account, newest first, capped at a page. The caption said "Last 7 days" and
 * the first row could be from last spring.
 *
 * That was repaired for the URL shape the shell writes — exact dates — but two
 * shapes were left unresolved, and both are real:
 *
 *   `?window=7d` with no dates. A pasted, truncated or hand-typed link, and the
 *   first paint before `useCanonicalDateWindowUrl` has written the URL. The page
 *   could not expand it, because the shared expansion was re-exported from a
 *   `"use client"` module and calling it from a Server Component threw. So it
 *   fell through to unbounded: the chip said "Last 7 days" and the table was the
 *   whole journal.
 *
 *   No window params at all. Same outcome for the same reason, and the same lie
 *   on screen — the topbar always asserts a window, so "no window stated" is
 *   never what the operator is looking at.
 *
 * `lib/dashboard/date-window-presets.ts` now owns the vocabulary and the
 * expansion with NO client boundary, so `resolveDateWindowFromParams` runs on a
 * server. Both shapes are answerable, and this module answers them with the
 * shared authority rather than a private copy of its rule.
 *
 * WHY THERE IS A DEFAULT NOW WHERE THERE WAS "UNBOUNDED"
 * ------------------------------------------------------
 * The objection the old code recorded is a good one: an invented default hides
 * entries nobody asked to exclude. But unbounded is not the neutral option it
 * looks like — the control at the top of the screen is always asserting a
 * window, so a table that ignores it is not "unfiltered", it is answering a
 * question the operator did not ask while a chip above it names the one they
 * did. Both readings hide something; only one of them can be seen.
 *
 * So the default is applied AND stated. `source` says whether the window came
 * from the URL or from this fallback, and the surface prints the resolved dates
 * either way (`components/zero-base/meta/history/history-view.tsx`), so nothing
 * is excluded silently. The default is the shell's own default preset, so the
 * server falls back to the same length the shell falls back to.
 *
 * A MALFORMED OR HALF-STATED PAIR IS NOT REPAIRED. `?startDate=2026-08-01` does
 * not become 08-01..08-01 or 08-01..today. The shared authority refuses to
 * repair such a pair — it returns null for it — and that null lands here as the
 * canonical default, marked `source: "default"`, exactly as an empty URL does.
 * A window nobody asked for wearing the shape of the one they typed is
 * indistinguishable from a correct answer, and that is the one outcome that must
 * never ship.
 */
import {
  getPresetDatesForReferenceDate,
  type RangePreset,
} from "@/lib/dashboard/date-window-presets";
import {
  DATE_WINDOW_INCLUDES_CURRENT_DAY,
  readDateWindowFromParams,
  resolveDateWindowFromParams,
  type DateWindowSelection,
  type SearchParamsLike,
} from "@/lib/dashboard/date-window-url";

/**
 * The canonical default, and the only preset this surface may invent.
 *
 * It is the shell's own default (`DASHBOARD_V2_DEFAULT_DATE_RANGE.rangePreset`,
 * `hooks/use-persistent-date-range.ts`). That hook is a `"use client"` module,
 * so the value cannot be imported into a Server Component —
 * `history-date-window.test.ts` asserts the two are the same string instead of
 * letting them drift apart silently.
 */
export const HISTORY_DEFAULT_WINDOW_PRESET: RangePreset = "28d";

const HISTORY_DEFAULT_SELECTION: DateWindowSelection = {
  rangePreset: HISTORY_DEFAULT_WINDOW_PRESET,
  customStart: "",
  customEnd: "",
};

export interface HistoryDateWindow {
  /** Inclusive first day of the journal read. */
  start: string;
  /** Inclusive last day of the journal read. */
  end: string;
  /** A NAME for `start`/`end`. Never re-expanded; carried for display only. */
  preset: RangePreset;
  /**
   * Where these two days came from.
   *
   * `"url"` — the link stated a window and it is being honoured verbatim (exact
   * dates) or expanded exactly once (a bare preset key).
   * `"default"` — the link stated nothing usable, so the shell's default preset
   * was applied. The surface says so; a hidden default is the defect this field
   * exists to prevent.
   */
  source: "url" | "default";
}

/**
 * The one window this route measures.
 *
 * `referenceDate` must be an ISO day on the WORKSPACE's clock — the same day
 * `components/layout/v2/app-topbar.tsx` resolves through
 * `getTodayIsoForTimeZone`, so the chip and the table cannot name different
 * weeks. It is a parameter rather than a call because the caller is the only
 * layer that knows which workspace this is.
 */
export function resolveHistoryDateWindow(input: {
  searchParams: SearchParamsLike | null | undefined;
  referenceDate: string;
}): HistoryDateWindow {
  const { searchParams, referenceDate } = input;

  // Only asks WHETHER the URL states a window, so the answer is not coloured by
  // preset-name recovery. No reference date is passed for the same reason.
  const statedByUrl = readDateWindowFromParams(searchParams) !== null;

  const resolved = resolveDateWindowFromParams(
    searchParams,
    referenceDate,
    HISTORY_DEFAULT_SELECTION,
  );

  if (resolved) {
    return {
      start: resolved.start,
      end: resolved.end,
      preset: resolved.preset,
      source: statedByUrl ? "url" : "default",
    };
  }

  // Unreachable while a fallback selection is supplied: the shared resolver
  // answers null only when neither the URL nor the fallback states a window.
  // Handled rather than asserted away, and expanded through the SAME shared
  // function, so even this branch cannot become a second expansion rule.
  const fallback = getPresetDatesForReferenceDate(
    HISTORY_DEFAULT_WINDOW_PRESET,
    referenceDate,
    "",
    "",
    { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
  );
  return {
    start: fallback.start,
    end: fallback.end,
    preset: HISTORY_DEFAULT_WINDOW_PRESET,
    source: "default",
  };
}
