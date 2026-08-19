/**
 * The one URL spelling of the dashboard's date window.
 *
 * Four incompatible spellings of a single concept were in the tree at once:
 * the Meta Decision Center read `?window` plus `?startDate`/`?endDate`, Meta
 * Intelligence read `?startDate`/`?endDate` on the server, the Creative Studio
 * routes read `?start`/`?end`, and the shell's own picker read nothing at all —
 * it wrote a preferences store and no router, so on six of nine Meta surfaces
 * the control at the top of the screen changed no request. A server-rendered
 * surface could never see it, because localStorage does not reach a server.
 *
 * This module is the wire format the shell writes and every URL-reading surface
 * already parses:
 *
 * - `startDate` / `endDate` — the resolved absolute window. Always written, so
 *   the window is a stated fact rather than a preset name each surface
 *   re-resolves against whichever clock it happens to hold.
 * - `window` — the preset key, in the exact vocabulary the Decision Center
 *   parses (`7d`, `14d`, `28d`, `90d`, else `custom`). Writing a key it does not
 *   parse would silently fall back to its 28-day default and show a window
 *   nobody asked for, so anything outside that set is written as `custom`,
 *   which is precisely the case where it honours the exact dates instead.
 *
 * Reading is the inverse, and it is exact: dates in the URL win over the stored
 * preset. The preset name is recovered only when it resolves to the very dates
 * the URL states, so the picker can keep saying "Last 28 days" without that
 * label ever naming a different window than the one being requested.
 */
// The VALUE comes from the module with no client boundary, so this file — the
// one authority for which window a surface is answering — is fully callable
// from a Server Component. Importing the expansion from the picker made this
// module a client reference, which is why Intelligence and History each grew
// a private expansion and could name a different week than the topbar on the
// same paint.
import {
  getPresetDatesForReferenceDate,
  type RangePreset,
} from "@/lib/dashboard/date-window-presets";
// Type-only, therefore erased at compile time: no runtime edge to the client
// module. Keep it `import type` — a value import here would undo the above.
import type { DateRangeValue } from "@/components/date-range/DateRangePicker";

export const DATE_WINDOW_START_PARAM = "startDate";
export const DATE_WINDOW_END_PARAM = "endDate";
export const DATE_WINDOW_PRESET_PARAM = "window";

/** Every param this module owns, for callers that need to copy or clear them. */
export const DATE_WINDOW_PARAMS = [
  DATE_WINDOW_PRESET_PARAM,
  DATE_WINDOW_START_PARAM,
  DATE_WINDOW_END_PARAM,
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The preset keys the Meta Decision Center's own parser accepts. Anything else
 * must travel as `custom` + exact dates.
 */
const SHARED_WINDOW_PRESETS: Partial<Record<RangePreset, string>> = {
  "7d": "7d",
  "14d": "14d",
  "28d": "28d",
  "90d": "90d",
};

const WINDOW_PARAM_TO_PRESET: Record<string, RangePreset> = {
  "7d": "7d",
  "14d": "14d",
  "28d": "28d",
  "90d": "90d",
};

/**
 * Presets the picker can name, in the order a recovery scan should try them.
 * `custom` is not here: it is the answer when nothing else matches.
 */
const RECOVERABLE_PRESETS: readonly RangePreset[] = [
  "today",
  "yesterday",
  "3d",
  "7d",
  "14d",
  "28d",
  "30d",
  "90d",
  "365d",
  "thisMonth",
  "lastMonth",
];

export interface SearchParamsLike {
  get(name: string): string | null;
}

/** Just the window half of a picker value; comparison stays a preference. */
export type DateWindowSelection = Pick<
  DateRangeValue,
  "rangePreset" | "customStart" | "customEnd"
>;

/**
 * THE INTENT. One picked preset produces exactly one window, and this is it.
 *
 * Three resolvers used to answer the same question differently for the same
 * click: the shell writer expanded a preset to completed days ending
 * yesterday, the Meta page body re-expanded the same preset with
 * `includeCurrentDay: true` (ending today), and
 * `/api/meta/decisions-workspace` ignored the dates entirely and resolved an
 * end date of its own. Picking "Last 7 days" once therefore measured
 * 2026-08-11..08-17 in the caption, 2026-08-12..08-18 in the sparklines, and a
 * third window in the decisions themselves.
 *
 * Two rules end that, and every layer obeys both:
 *
 * 1. EXACT DATES ARE THE WINDOW. When the URL states `startDate`/`endDate`,
 *    those two days are what gets measured — verbatim, never re-expanded. A
 *    recovered preset name ("Last 7 days") is a LABEL for those dates and
 *    nothing more. Re-expanding the label is what let two surfaces holding
 *    different clocks (workspace timezone vs. provider-account timezone) turn
 *    one stated window into two.
 *
 * 2. A PRESET EXPANDS ONCE, TO COMPLETED DAYS. `includeCurrentDay` is false
 *    here and everywhere downstream. Today is a partial day: its spend,
 *    revenue and conversions are still arriving, so counting it as a whole day
 *    understates every rate and inflates every per-day divisor. That is the
 *    "budget utilization must use the actual evidence-window day count"
 *    invariant in its other form — a 7-day window whose seventh day is three
 *    hours long is not a 7-day window. Ending on yesterday is also already
 *    what the shell writer and the decisions route's own `previousUtcDate()`
 *    default produced, so this makes the honest reading the only reading.
 *
 * The caption the operator reads names the preset; because of (1) and (2) the
 * dates behind that name are the dates that were actually measured.
 */
export const DATE_WINDOW_INCLUDES_CURRENT_DAY = false;

/** The absolute window a URL resolves to, plus the label that names it. */
export interface ResolvedDateWindow {
  start: string;
  end: string;
  /** Only a name for `start`/`end`. Never re-expand it. */
  preset: RangePreset;
}

function readParam(
  params: SearchParamsLike | null | undefined,
  name: string,
): string {
  return params?.get(name)?.trim() ?? "";
}

function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

/**
 * The window this URL states, or null when it states none.
 *
 * A malformed or inverted pair is not a window: it is ignored so the caller
 * falls back to its stored range, and the picker keeps naming what it actually
 * uses. It is never repaired into a plausible-looking window.
 */
export function readDateWindowFromParams(
  params: SearchParamsLike | null | undefined,
  options: {
    /** The clock this surface calls "today", for preset-name recovery. */
    referenceDate?: string | null;
    /** Tried first, so the operator's own choice keeps its label. */
    preferredPreset?: RangePreset | null;
  } = {},
): DateWindowSelection | null {
  const start = readParam(params, DATE_WINDOW_START_PARAM);
  const end = readParam(params, DATE_WINDOW_END_PARAM);
  const presetParam = readParam(params, DATE_WINDOW_PRESET_PARAM);
  const hasExactWindow = isIsoDate(start) && isIsoDate(end) && start <= end;

  if (!hasExactWindow) {
    const preset = WINDOW_PARAM_TO_PRESET[presetParam];
    if (!preset) return null;
    return { rangePreset: preset, customStart: "", customEnd: "" };
  }

  const referenceDate = options.referenceDate ?? "";
  if (isIsoDate(referenceDate)) {
    const candidates: readonly (RangePreset | null | undefined)[] = [
      options.preferredPreset,
      WINDOW_PARAM_TO_PRESET[presetParam],
      ...RECOVERABLE_PRESETS,
    ];
    for (const candidate of candidates) {
      if (!candidate || candidate === "custom") continue;
      const resolved = getPresetDatesForReferenceDate(candidate, referenceDate);
      if (resolved.start === start && resolved.end === end) {
        return { rangePreset: candidate, customStart: start, customEnd: end };
      }
    }
  }

  return { rangePreset: "custom", customStart: start, customEnd: end };
}

/**
 * The one absolute window this URL means — the single expansion every layer
 * calls instead of resolving a preset against its own clock.
 *
 * Exact dates on the URL are returned verbatim (rule 1 above); only a
 * preset-without-dates is expanded, and then with completed-day semantics
 * (rule 2). `fallback` is the caller's stored selection, used only when the
 * URL states nothing at all; null means neither stated a window, which is a
 * caller's cue to say so rather than to invent one.
 */
export function resolveDateWindowFromParams(
  params: SearchParamsLike | null | undefined,
  referenceDate: string,
  fallback?: DateWindowSelection | null,
): ResolvedDateWindow | null {
  const start = readParam(params, DATE_WINDOW_START_PARAM);
  const end = readParam(params, DATE_WINDOW_END_PARAM);
  const stated = readDateWindowFromParams(params, {
    referenceDate,
    preferredPreset: fallback?.rangePreset ?? null,
  });

  if (stated && isIsoDate(start) && isIsoDate(end) && start <= end) {
    // Verbatim: the URL already states the measured window. `stated.rangePreset`
    // is whatever label happens to fit these dates on this clock, and it is
    // carried for display only.
    return { start, end, preset: stated.rangePreset };
  }

  const selection = stated ?? fallback ?? null;
  if (!selection) return null;
  const resolved = getPresetDatesForReferenceDate(
    selection.rangePreset,
    referenceDate,
    selection.customStart,
    selection.customEnd,
    { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
  );
  return {
    start: resolved.start,
    end: resolved.end,
    preset: selection.rangePreset,
  };
}

/** True when this URL is the one naming the window. */
export function hasDateWindowParams(
  params: SearchParamsLike | null | undefined,
): boolean {
  return readDateWindowFromParams(params) !== null;
}

/**
 * The same query with this window stated on it. Every other parameter — the
 * business, the provider account, a cursor, an OAuth `state` — is preserved
 * exactly, including repeats, because dropping one turns a working link into a
 * different request.
 */
export function applyDateWindowToParams(
  params: SearchParamsLike | URLSearchParams | null | undefined,
  value: DateWindowSelection,
  referenceDate: string,
): URLSearchParams {
  const next =
    params instanceof URLSearchParams
      ? new URLSearchParams(params)
      : new URLSearchParams();
  // Same expansion as every reader: completed days, current day excluded.
  // Writing one rule here and a different one in a consumer is precisely how
  // the picker came to name a window nobody measured.
  const resolved = getPresetDatesForReferenceDate(
    value.rangePreset,
    referenceDate,
    value.customStart,
    value.customEnd,
    { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
  );
  next.set(
    DATE_WINDOW_PRESET_PARAM,
    SHARED_WINDOW_PRESETS[value.rangePreset] ?? "custom",
  );
  next.set(DATE_WINDOW_START_PARAM, resolved.start);
  next.set(DATE_WINDOW_END_PARAM, resolved.end);
  return next;
}

/**
 * The Creative Studio's older spelling of the same window.
 *
 * It is still minted by live links, and it is exact dates rather than a preset
 * name, so canonicalization ADOPTS it instead of overwriting it — overwriting
 * would give the shell one window and the Studio body the other, which is the
 * split this module exists to end.
 */
export const LEGACY_DATE_WINDOW_START_PARAM = "start";
export const LEGACY_DATE_WINDOW_END_PARAM = "end";

/** True when both halves are ISO days in order. Half a pair is not a window. */
function isExactPair(start: string, end: string): boolean {
  return isIsoDate(start) && isIsoDate(end) && start <= end;
}

/**
 * The selection this URL already asserts, before any stored preference is
 * consulted. Exact dates outrank a preset name, per rule 1.
 */
function urlStatedSelection(
  params: SearchParamsLike | null | undefined,
): DateWindowSelection | null {
  const legacyStart = readParam(params, LEGACY_DATE_WINDOW_START_PARAM);
  const legacyEnd = readParam(params, LEGACY_DATE_WINDOW_END_PARAM);
  if (isExactPair(legacyStart, legacyEnd)) {
    return {
      rangePreset: "custom",
      customStart: legacyStart,
      customEnd: legacyEnd,
    };
  }
  const preset = WINDOW_PARAM_TO_PRESET[readParam(params, DATE_WINDOW_PRESET_PARAM)];
  if (preset) return { rangePreset: preset, customStart: "", customEnd: "" };
  return null;
}

/**
 * ITEM 10 — the window this URL must state before anything reads it, or `null`
 * when it already states one.
 *
 * Writing the URL when the picker is CLICKED is not enough. The proven defect:
 * a browser holds a persisted 90-day selection, the operator opens
 * `/c/:id/meta/decisions` with no dates on it, and two things answer the same
 * question differently in the same paint — the shell's picker reads
 * localStorage and says "Last 90 days", while `MetaPlatformPage`'s
 * `parseMetaWindow(null)` and `resolveIntelligenceWindow`'s own default both
 * fall back to 28 days. One workspace, one screen, two windows; the caption
 * names a measurement nobody performed.
 *
 * A store cannot be the authority, because a server-rendered surface cannot
 * read it — `app/c/[businessId]/meta/intelligence/page.tsx` resolves its window
 * on the server from `startDate`/`endDate` and can only ever be told through
 * the URL. So the URL is the authority, and a persisted selection is
 * canonicalized INTO it before the first read rather than being consulted
 * beside it.
 *
 * Precedence, and the reason for each step:
 *
 * 1. `startDate`/`endDate` already form an exact pair → `null`. The URL is
 *    already the authority; restating it would only be a chance to disagree.
 * 2. legacy `start`/`end` form an exact pair → adopt those days verbatim.
 * 3. `window=<preset>` → adopt the preset the link names, NOT the stored one.
 *    A pasted `?window=7d` must not be overruled by whatever this browser last
 *    picked, or the link does not reproduce the window it names.
 * 4. otherwise → the stored selection, which is the operator's own last choice.
 *
 * A half pair (`?startDate=` alone) and an inverted or malformed pair are not
 * windows and are not repaired into plausible-looking ones: they fall through
 * to the stated preset or the stored selection, and the honest answer is then
 * written over them. Every other parameter on the URL is preserved, because
 * `applyDateWindowToParams` copies the query it is given.
 *
 * Without a usable `referenceDate` this returns `null` — a rolling preset
 * cannot be expanded without a clock, and inventing one is how two surfaces
 * came to hold two clocks in the first place.
 */
export function canonicalDateWindowParams(
  params: URLSearchParams,
  stored: DateWindowSelection,
  referenceDate: string,
): URLSearchParams | null {
  const start = readParam(params, DATE_WINDOW_START_PARAM);
  const end = readParam(params, DATE_WINDOW_END_PARAM);
  if (isExactPair(start, end)) return null;
  if (!isIsoDate(referenceDate)) return null;
  return applyDateWindowToParams(
    params,
    urlStatedSelection(params) ?? stored,
    referenceDate,
  );
}

/** `path?query`, with the `?` omitted when there is no query. */
export function hrefWithParams(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Carries a stated window onto an outgoing link.
 *
 * Only a window the current URL states travels: a stored preference is already
 * read by every client surface, but a server-rendered surface can only be told
 * through the link it is opened with. A destination that already names its own
 * window keeps it.
 */
export function carryDateWindowParams(
  href: string,
  current: SearchParamsLike | null | undefined,
): string {
  if (!hasDateWindowParams(current)) return href;
  const [path, existingQuery = ""] = href.split("?", 2);
  const params = new URLSearchParams(existingQuery);
  if (hasDateWindowParams(params)) return href;
  for (const key of DATE_WINDOW_PARAMS) {
    const value = current?.get(key)?.trim() ?? "";
    if (value) params.set(key, value);
  }
  return hrefWithParams(path ?? href, params);
}
