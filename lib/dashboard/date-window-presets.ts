/**
 * The date-window vocabulary and its expansion, with no client boundary.
 *
 * WHY THIS FILE EXISTS. `RangePreset`, `getTodayIsoForTimeZone` and
 * `getPresetDatesForReferenceDate` are pure functions over strings, but they
 * lived inside `components/date-range/DateRangePicker.tsx`, which carries
 * `"use client"`. Importing them from a Server Component made the whole module
 * a client reference, so `lib/dashboard/date-window-url.ts` — the one authority
 * for which window a surface is answering — could not be fully used on the
 * server. Every server surface then grew its own expansion: Intelligence kept a
 * private today-inclusive 28-day default, History read a bare `?window=7d` as
 * unbounded, and the topbar and the body could name different weeks on one
 * paint. That is the defect this extraction removes at the root.
 *
 * The picker re-exports these, so every existing import keeps working and there
 * is still exactly ONE implementation.
 *
 * THE CONTRACT, unchanged from the picker: a rolling preset ends YESTERDAY, on
 * completed days only. Today is a part-day whose spend and conversions are
 * still arriving; counting it whole makes a "7-day window" whose seventh day is
 * three hours long. `includeCurrentDay` opts into the other reading explicitly,
 * for the callers that genuinely want it.
 */

export type RangePreset =
  | "today"
  | "yesterday"
  | "3d"
  | "7d"
  | "14d"
  | "28d"
  | "30d"
  | "90d"
  | "365d"
  | "thisMonth"
  | "lastMonth"
  | "custom";

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

/**
 * "Today" on the workspace's clock, not the viewer's browser and not UTC.
 *
 * An unresolvable time zone falls back to UTC rather than throwing, because a
 * broken zone must not take a page down — but the caller should prefer passing
 * a real workspace zone, since UTC will name a different day for part of every
 * day in most of the world.
 */
export function getTodayIsoForTimeZone(timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  }

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function getPresetDatesForReferenceDate(
  preset: RangePreset,
  referenceDate: string,
  customStart?: string,
  customEnd?: string,
  options: { includeCurrentDay?: boolean } = {},
): { start: string; end: string } {
  const today = parseISODate(referenceDate);
  const completedRollingWindow = (days: number) => {
    const end = options.includeCurrentDay ? today : addDays(today, -1);
    return {
      start: toISO(addDays(end, -(days - 1))),
      end: toISO(end),
    };
  };

  switch (preset) {
    case "today":
      return { start: referenceDate, end: referenceDate };
    case "yesterday": {
      const yesterday = toISO(addDays(today, -1));
      return { start: yesterday, end: yesterday };
    }
    case "3d":
      return completedRollingWindow(3);
    case "7d":
      return completedRollingWindow(7);
    case "14d":
      return completedRollingWindow(14);
    case "28d":
      return completedRollingWindow(28);
    case "30d":
      return completedRollingWindow(30);
    case "90d":
      return completedRollingWindow(90);
    case "365d":
      return completedRollingWindow(365);
    case "thisMonth":
      return {
        start: toISO(
          new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
        ),
        end: referenceDate,
      };
    case "lastMonth": {
      const year = today.getUTCFullYear();
      const month = today.getUTCMonth();
      const start = new Date(
        Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, 1),
      );
      const end = new Date(Date.UTC(year, month, 0));
      return { start: toISO(start), end: toISO(end) };
    }
    case "custom":
      return {
        start: customStart || toISO(addDays(today, -29)),
        end: customEnd || referenceDate,
      };
  }
}
