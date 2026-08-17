/**
 * The window Commercial Truth is labelled with.
 *
 * Three figures on this screen print "28d": the campaign table's `Spend · 28d`
 * header, the `share of labeled ad spend · 28d` note under the band strip, and
 * the revenue split's `28d blended pace`. Every endpoint behind them defaults
 * to 30 days when called without dates — `lib/meta/campaigns-source.ts` starts
 * at `nDaysAgo(29)`, `lib/google-ads-request-params.ts` normalises a missing
 * range to `"30"`, and `/api/overview-summary` shifts its end date by -29. So
 * the window is stated explicitly here and passed to all three, and the label
 * is true because the request says so.
 *
 * The end day is "today" in the workspace's own timezone, which is the basis
 * `/api/overview-summary` uses for its own fallback; the start is 27 days
 * earlier, making the window 28 days inclusive.
 */

export const TRUTH_WINDOW_DAYS = 28;

export interface CommercialTruthWindow {
  startDate: string;
  endDate: string;
  days: number;
}

function isoDayInTimeZone(timeZone: string | null, at: Date): string {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat("en-CA", {
      ...(zone ? { timeZone: zone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  if (timeZone) {
    try {
      return format(timeZone);
    } catch {
      // An unusable stored timezone falls back to the runtime's own day rather
      // than refusing to build a window at all.
    }
  }
  return format();
}

export function buildCommercialTruthWindow(
  timeZone: string | null,
  at: Date = new Date(),
): CommercialTruthWindow {
  const endDate = isoDayInTimeZone(timeZone, at);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (TRUTH_WINDOW_DAYS - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate,
    days: TRUTH_WINDOW_DAYS,
  };
}
