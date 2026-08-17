"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Popover } from "radix-ui";
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

/**
 * The comparisons this product can actually compute.
 *
 * Four more were offered here — previous week, month, quarter, and a
 * weekday-matched previous year — and none had a server implementation. Every
 * one of them resolved to a previous-*period* delta, so an operator picking
 * "Previous year" saw a number measured against something else entirely and
 * had no way to tell. `lib/comparison-preset-contract.ts` is the single place
 * these map to compare modes, and its test fails if this list grows past what
 * `getComparisonWindow` implements.
 */
export type ComparisonPreset =
  | "none"
  | "custom"
  | "previousPeriod"
  | "previousYear";

export interface DateRangeValue {
  rangePreset: RangePreset;
  customStart: string;
  customEnd: string;
  comparisonPreset: ComparisonPreset;
  comparisonStart: string;
  comparisonEnd: string;
}

export const DEFAULT_DATE_RANGE: DateRangeValue = {
  rangePreset: "30d",
  customStart: "",
  customEnd: "",
  comparisonPreset: "none",
  comparisonStart: "",
  comparisonEnd: "",
};

export function togglePreviousPeriodComparison(
  value: DateRangeValue,
): DateRangeValue {
  return {
    ...value,
    comparisonPreset:
      value.comparisonPreset === "none" ? "previousPeriod" : "none",
    comparisonStart: "",
    comparisonEnd: "",
  };
}

export type DateWindowKey =
  | "today"
  | "yesterday"
  | "7d"
  | "14d"
  | "28d"
  | "90d"
  | "this_month"
  | "last_month"
  | "custom";

export interface DateWindowValue {
  window: DateWindowKey;
  start: string;
  end: string;
}

const WINDOW_TO_RANGE_PRESET: Record<DateWindowKey, RangePreset> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "7d",
  "14d": "14d",
  "28d": "28d",
  "90d": "90d",
  this_month: "thisMonth",
  last_month: "lastMonth",
  custom: "custom",
};

const DATE_WINDOW_LABELS: Record<DateWindowKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "28d": "Last 28 days",
  "90d": "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export function dateWindowLabel(window: DateWindowKey): string {
  return DATE_WINDOW_LABELS[window];
}

export function normalizeDateWindowBounds(
  value: DateWindowValue,
  bounds: { minDate?: string; maxDate?: string } = {}
): DateWindowValue {
  let start = value.start;
  let end = value.end;
  if (bounds.minDate) {
    if (start < bounds.minDate) start = bounds.minDate;
    if (end < bounds.minDate) end = bounds.minDate;
  }
  if (bounds.maxDate) {
    if (start > bounds.maxDate) start = bounds.maxDate;
    if (end > bounds.maxDate) end = bounds.maxDate;
  }
  if (start > end) [start, end] = [end, start];
  return { ...value, start, end };
}

export function dateWindowToRangeValue(value: DateWindowValue): DateRangeValue {
  return {
    rangePreset: WINDOW_TO_RANGE_PRESET[value.window],
    customStart: value.start,
    customEnd: value.end,
    comparisonPreset: "none",
    comparisonStart: "",
    comparisonEnd: "",
  };
}

type PresetOption<TValue extends string> = {
  value: TValue;
  label: string;
  hint: string;
  group: string;
};

const RANGE_PRESETS: ReadonlyArray<PresetOption<RangePreset>> = [
  { value: "today", label: "Today", hint: "Only the current day", group: "Quick Select" },
  { value: "yesterday", label: "Yesterday", hint: "Previous completed day", group: "Quick Select" },
  { value: "3d", label: "Last 3 days", hint: "Short performance read", group: "Rolling Windows" },
  { value: "7d", label: "Last 7 days", hint: "Weekly read", group: "Rolling Windows" },
  { value: "14d", label: "Last 14 days", hint: "Bi-weekly stability", group: "Rolling Windows" },
  { value: "28d", label: "Last 28 days", hint: "Meta attribution window", group: "Rolling Windows" },
  { value: "30d", label: "Last 30 days", hint: "Balanced operating view", group: "Rolling Windows" },
  { value: "90d", label: "Last 90 days", hint: "Quarter-scale context", group: "Rolling Windows" },
  { value: "365d", label: "Last 365 days", hint: "Long-term trend", group: "Rolling Windows" },
  { value: "thisMonth", label: "This month", hint: "Month to date", group: "Calendar Periods" },
  { value: "lastMonth", label: "Last month", hint: "Previous full calendar month", group: "Calendar Periods" },
  { value: "custom", label: "Custom range", hint: "Pick exact dates", group: "Custom" },
];

/** The exact list the picker offers, exported so a test can hold it to it. */
export const COMPARISON_PRESET_VALUES = [
  "none",
  "custom",
  "previousPeriod",
  "previousYear",
] as const satisfies ReadonlyArray<ComparisonPreset>;

const COMPARISON_PRESETS: ReadonlyArray<PresetOption<ComparisonPreset>> = [
  { value: "none", label: "None", hint: "Keep the view focused on one period", group: "Compare" },
  { value: "custom", label: "Custom range", hint: "Pick exact comparison dates", group: "Compare" },
  { value: "previousPeriod", label: "Previous period", hint: "Same length immediately before", group: "Compare" },
  { value: "previousYear", label: "Previous year", hint: "Year-over-year comparison", group: "Compare" },
];

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

function addMonths(date: Date, amount: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
}

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
  options: { includeCurrentDay?: boolean } = {}
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
        start: toISO(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
        end: referenceDate,
      };
    case "lastMonth": {
      const year = today.getUTCFullYear();
      const month = today.getUTCMonth();
      const start = new Date(Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, 1));
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

export function getPresetDates(
  preset: RangePreset,
  customStart?: string,
  customEnd?: string,
  options: { includeCurrentDay?: boolean } = {}
): { start: string; end: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return getPresetDatesForReferenceDate(
    preset,
    getTodayIsoForTimeZone(timeZone),
    customStart,
    customEnd,
    options
  );
}

export function rangeValueToDateWindow(
  value: DateRangeValue,
  referenceDate?: string,
  options: { includeCurrentDay?: boolean } = {}
): DateWindowValue {
  const presetToWindow: Partial<Record<RangePreset, DateWindowKey>> = {
    today: "today",
    yesterday: "yesterday",
    "7d": "7d",
    "14d": "14d",
    "28d": "28d",
    "90d": "90d",
    thisMonth: "this_month",
    lastMonth: "last_month",
    custom: "custom",
  };
  const window = presetToWindow[value.rangePreset] ?? "custom";
  const range = referenceDate
    ? getPresetDatesForReferenceDate(
        value.rangePreset,
        referenceDate,
        value.customStart,
        value.customEnd,
        options
      )
    : getPresetDates(value.rangePreset, value.customStart, value.customEnd, options);

  return { window, start: range.start, end: range.end };
}

export function resolveRangePresetSelection(
  draft: DateRangeValue,
  preset: RangePreset,
  referenceDate?: string,
  options: { includeCurrentDay?: boolean } = {}
): { nextDraft: DateRangeValue; shouldApply: boolean } {
  const resolved = referenceDate
    ? getPresetDatesForReferenceDate(preset, referenceDate, draft.customStart, draft.customEnd, options)
    : getPresetDates(preset, draft.customStart, draft.customEnd, options);

  return {
    nextDraft: {
      ...draft,
      rangePreset: preset,
      customStart: resolved.start,
      customEnd: resolved.end,
    },
    shouldApply: preset !== "custom" && draft.rangePreset === preset,
  };
}

export function resolveRangeCalendarDateClick(
  draft: DateRangeValue,
  pickStep: "start" | "end",
  date: string
): { nextDraft: DateRangeValue; nextPickStep: "start" | "end"; shouldApply: boolean } {
  if (pickStep === "start" || draft.rangePreset !== "custom") {
    return {
      nextDraft: {
        ...draft,
        rangePreset: "custom",
        customStart: date,
        customEnd: date,
      },
      nextPickStep: "end",
      shouldApply: false,
    };
  }

  if (date === draft.customStart) {
    return {
      nextDraft: {
        ...draft,
        rangePreset: "custom",
        customStart: date,
        customEnd: date,
      },
      nextPickStep: "start",
      shouldApply: true,
    };
  }

  if (date < draft.customStart) {
    return {
      nextDraft: {
        ...draft,
        rangePreset: "custom",
        customStart: date,
        customEnd: draft.customStart,
      },
      nextPickStep: "start",
      shouldApply: false,
    };
  }

  return {
    nextDraft: {
      ...draft,
      rangePreset: "custom",
      customStart: draft.customStart,
      customEnd: date,
    },
    nextPickStep: "start",
    shouldApply: false,
  };
}

export function getPickerKeyboardAction(key: string): "apply" | "cancel" | null {
  if (key === "Enter") return "apply";
  if (key === "Escape") return "cancel";
  return null;
}

function formatShortDate(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(`${iso}T00:00:00`));
}

function formatLongDate(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${iso}T00:00:00`));
}

function formatDateRange(start: string, end: string): string {
  if (!start || !end) return "";
  return start === end ? formatShortDate(start) : `${formatShortDate(start)} - ${formatShortDate(end)}`;
}

function getRangeDays(start: string, end: string): number {
  if (!start || !end) return 0;
  const ms = parseISODate(end).getTime() - parseISODate(start).getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function getTriggerLabel(value: DateRangeValue, presets = RANGE_PRESETS): string {
  if (value.rangePreset === "custom") {
    return formatDateRange(value.customStart, value.customEnd) || "Custom range";
  }
  return presets.find((preset) => preset.value === value.rangePreset)?.label ?? "Date range";
}

function getTriggerLabelForReferenceDate(
  value: DateRangeValue,
  presets = RANGE_PRESETS,
  referenceDate?: string,
  options: { includeCurrentDay?: boolean } = {}
): string {
  if (value.rangePreset === "custom") {
    return formatDateRange(value.customStart, value.customEnd) || "Custom range";
  }
  if (!referenceDate) return getTriggerLabel(value, presets);

  const { start, end } = getPresetDatesForReferenceDate(
    value.rangePreset,
    referenceDate,
    value.customStart,
    value.customEnd,
    options
  );

  if (value.rangePreset === "today" || value.rangePreset === "yesterday") {
    return formatDateRange(start, end);
  }

  return presets.find((preset) => preset.value === value.rangePreset)?.label ?? "Date range";
}

const DAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function buildMonthGrid(year: number, month: number): Array<string | null> {
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: Array<string | null> = Array(firstDay).fill(null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }

  while (cells.length < 42) cells.push(null);
  return cells;
}

function getPresetSections<T extends { group: string }>(
  items: ReadonlyArray<T>
): Array<{ label: string; items: T[] }> {
  const sections = new Map<string, T[]>();
  for (const item of items) {
    if (!sections.has(item.group)) sections.set(item.group, []);
    sections.get(item.group)?.push(item);
  }
  return Array.from(sections.entries()).map(([label, sectionItems]) => ({ label, items: sectionItems }));
}

function getComparisonDescription(preset: ComparisonPreset): string {
  switch (preset) {
    case "none":
      return "Comparison is off. The charts and tables stay focused on the selected primary range only.";
    case "custom":
      return "Use an exact comparison range that you choose manually.";
    case "previousPeriod":
      return "Matches the selected range length and compares it against the immediately preceding window.";
    case "previousYear":
      return "A direct year-over-year lens for growth, efficiency, and seasonality.";
  }
}

function getResolvedPrimaryRange(
  draft: DateRangeValue,
  referenceDate?: string,
  options: { includeCurrentDay?: boolean } = {}
) {
  return referenceDate
    ? getPresetDatesForReferenceDate(
        draft.rangePreset,
        referenceDate,
        draft.customStart,
        draft.customEnd,
        options
      )
    : getPresetDates(draft.rangePreset, draft.customStart, draft.customEnd, options);
}

function shiftIsoDateByMonths(value: string, amount: number): string {
  const date = parseISODate(value);
  const day = date.getUTCDate();
  const targetMonthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1)
  );
  const lastDay = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return toISO(
    new Date(
      Date.UTC(
        targetMonthStart.getUTCFullYear(),
        targetMonthStart.getUTCMonth(),
        Math.min(day, lastDay)
      )
    )
  );
}

export function getDerivedComparisonRange(
  primaryStart: string,
  primaryEnd: string,
  preset: ComparisonPreset,
  customStart: string,
  customEnd: string
): { start: string; end: string } | null {
  if (preset === "none") return null;

  if (preset === "custom") {
    return {
      start: customStart || primaryStart,
      end: customEnd || primaryEnd,
    };
  }

  const days = getRangeDays(primaryStart, primaryEnd);

  if (preset === "previousPeriod") {
    const end = toISO(addDays(parseISODate(primaryStart), -1));
    const start = toISO(addDays(parseISODate(end), -(days - 1)));
    return { start, end };
  }

  // Only the comparisons the server can actually compute are offered, so this
  // resolver has nothing left to guess. The week/month/quarter and
  // weekday-matched windows it used to build were never requested from the
  // server: every one of them was collapsed to previous-period on the way out,
  // so the preview here disagreed with the numbers that came back.
  return {
    start: shiftIsoDateByMonths(primaryStart, -12),
    end: shiftIsoDateByMonths(primaryEnd, -12),
  };
}

function CalendarMonth({
  year,
  month,
  rangeStart,
  rangeEnd,
  hoverDate,
  pickStep,
  interactive,
  onDateClick,
  onDateHover,
  todayIso,
  minDate,
  maxDate,
}: {
  year: number;
  month: number;
  rangeStart: string;
  rangeEnd: string;
  hoverDate: string;
  pickStep: "start" | "end";
  interactive: boolean;
  onDateClick: (date: string) => void;
  onDateHover: (date: string) => void;
  todayIso: string;
  minDate?: string;
  maxDate?: string;
}) {
  const cells = buildMonthGrid(year, month);
  const effectiveEnd =
    interactive && pickStep === "end" && hoverDate && rangeStart && hoverDate > rangeStart ? hoverDate : rangeEnd;

  return (
    <section
      aria-label={`${MONTH_NAMES[month]} ${year} calendar`}
      className="rounded-[18px] border border-slate-200/80 bg-white/92 p-3 shadow-[0_8px_20px_rgba(15,23,42,0.05)]"
    >
      <div className="mb-1.5 grid grid-cols-7 gap-y-0.5">
        {DAYS_SHORT.map((label) => (
          <div
            key={label}
            className={cn(
              "flex h-7 items-center justify-center text-[12px] font-semibold uppercase tracking-[0.16em]",
              label === "Sa" ? "text-slate-900" : "text-slate-400"
            )}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((date, index) => {
          if (!date) return <div key={`empty-${index}`} className="h-8" />;

          const isStart = date === rangeStart;
          const isEnd = date === effectiveEnd;
          const isToday = date === todayIso;
          const inRange = Boolean(rangeStart && effectiveEnd && date > rangeStart && date < effectiveEnd);
          const isDisabled = Boolean((minDate && date < minDate) || (maxDate && date > maxDate));

          return (
            <div key={date} className="flex h-8 items-center justify-center">
              <button
                type="button"
                disabled={isDisabled}
                aria-label={formatLongDate(date)}
                aria-pressed={isStart || isEnd}
                aria-current={isToday ? "date" : undefined}
                onClick={() => interactive && !isDisabled && onDateClick(date)}
                onMouseEnter={() => interactive && !isDisabled && onDateHover(date)}
                className={cn(
                  "relative flex h-7 w-7 items-center justify-center rounded-xl text-xs font-medium transition-all",
                  interactive && !isDisabled ? "cursor-pointer" : "cursor-default",
                  isStart || isEnd
                    ? "bg-slate-900 text-white shadow-[0_8px_14px_rgba(15,23,42,0.2)]"
                    : inRange
                      ? "rounded-lg bg-blue-50 text-blue-700"
                      : "text-slate-700 hover:bg-slate-100",
                  isToday && !(isStart || isEnd) && "border border-blue-200 text-blue-700",
                  isDisabled && "opacity-30 hover:bg-transparent"
                )}
              >
                {Number.parseInt(date.slice(8), 10)}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CompactPanelHeader({
  title,
  summary,
  chips,
  onPrev,
  onNext,
}: {
  title: string;
  summary?: string;
  chips: string[];
  onPrev?: () => void;
  onNext?: () => void;
}) {
  return (
    <div className="rounded-[18px] border border-slate-200/80 bg-white/92 p-3 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Previous month"
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition-colors",
            onPrev ? "hover:border-slate-300 hover:bg-slate-50" : "pointer-events-none opacity-0"
          )}
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1 text-center">
          <div className="text-lg font-semibold text-slate-900">{title}</div>
          {summary ? <div className="mt-1 text-sm font-medium text-slate-700">{summary}</div> : null}
        </div>

        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next month"
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition-colors",
            onNext ? "hover:border-slate-300 hover:bg-slate-50" : "pointer-events-none opacity-0"
          )}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] font-medium text-slate-600"
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompactPanelFooter({
  onCancel,
  onApply,
}: {
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-slate-200/80 bg-white/92 px-3 py-2.5">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onApply}
        className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_10px_18px_rgba(15,23,42,0.18)] transition-opacity hover:opacity-90"
      >
        Apply
      </button>
    </div>
  );
}

function RangePanel({
  draft,
  onDraftChange,
  onApply,
  onCancel,
  rangePresets,
  referenceDate,
  timeZoneLabel,
  minDate,
  maxDate,
  includeCurrentDayInRollingRanges = false,
}: {
  draft: DateRangeValue;
  onDraftChange: (value: DateRangeValue) => void;
  onApply: (nextDraft?: DateRangeValue) => void;
  onCancel: () => void;
  rangePresets: ReadonlyArray<PresetOption<RangePreset>>;
  referenceDate?: string;
  timeZoneLabel?: string;
  minDate?: string;
  maxDate?: string;
  includeCurrentDayInRollingRanges?: boolean;
}) {
  const todayIso = referenceDate ?? getTodayIsoForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const rangeOptions = { includeCurrentDay: includeCurrentDayInRollingRanges };
  const resolvedRange = referenceDate
    ? getPresetDatesForReferenceDate(
        draft.rangePreset,
        referenceDate,
        draft.customStart,
        draft.customEnd,
        rangeOptions
      )
    : getPresetDates(draft.rangePreset, draft.customStart, draft.customEnd, rangeOptions);

  const [pickStep, setPickStep] = useState<"start" | "end">("start");
  const [hoverDate, setHoverDate] = useState("");
  const [visibleMonthDate, setVisibleMonthDate] = useState<Date>(() => parseISODate(resolvedRange.end));
  const previousPresetRef = useRef(draft.rangePreset);
  const previousReferenceDateRef = useRef(referenceDate);

  useEffect(() => {
    const presetChanged = previousPresetRef.current !== draft.rangePreset;
    const referenceChanged = previousReferenceDateRef.current !== referenceDate;
    previousPresetRef.current = draft.rangePreset;
    previousReferenceDateRef.current = referenceDate;

    if (!presetChanged && !referenceChanged) return;
    if (draft.rangePreset === "custom") return;

    setVisibleMonthDate(parseISODate(resolvedRange.end));
    setPickStep("start");
    setHoverDate("");
  }, [draft.rangePreset, referenceDate, resolvedRange.end]);

  const visibleYear = visibleMonthDate.getUTCFullYear();
  const visibleMonth = visibleMonthDate.getUTCMonth();
  const previousMonthDate = addMonths(visibleMonthDate, -1);
  const previousMonthYear = previousMonthDate.getUTCFullYear();
  const previousMonth = previousMonthDate.getUTCMonth();
  const presetSections = getPresetSections(rangePresets);
  const rangeDays = getRangeDays(resolvedRange.start, resolvedRange.end);
  const resolvedTimeZone = timeZoneLabel ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canMovePrevious = !minDate || toISO(previousMonthDate).slice(0, 7) > minDate.slice(0, 7);
  const canMoveNext = !maxDate || toISO(visibleMonthDate).slice(0, 7) < maxDate.slice(0, 7);
  const monthTitle =
    previousMonthYear === visibleYear
      ? `${MONTH_NAMES[previousMonth]} - ${MONTH_NAMES[visibleMonth]} ${visibleYear}`
      : `${MONTH_NAMES[previousMonth]} ${previousMonthYear} - ${MONTH_NAMES[visibleMonth]} ${visibleYear}`;

  function handleDateClick(date: string) {
    const selection = resolveRangeCalendarDateClick(draft, pickStep, date);
    onDraftChange(selection.nextDraft);
    setPickStep(selection.nextPickStep);
    if (selection.shouldApply) onApply(selection.nextDraft);
  }

  return (
    <div className="flex w-[min(96vw,820px)] flex-col overflow-hidden rounded-[22px] bg-[linear-gradient(180deg,#f8fbff_0%,#f7f8fb_100%)]">
      <div className="grid grid-cols-1 md:grid-cols-[196px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200/80 bg-white/92 p-3 md:border-b-0 md:border-r">
          <div className="mb-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-slate-400">Date Range</div>
          </div>

          <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1 md:max-h-[420px]">
            {presetSections.map((section) => (
              <div key={section.label} className="space-y-1">
                <div className="px-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {section.label}
                </div>
                {section.items.map((preset) => {
                  const selected = draft.rangePreset === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        const selection = resolveRangePresetSelection(
                          draft,
                          preset.value,
                          referenceDate,
                          rangeOptions
                        );
                        onDraftChange(selection.nextDraft);
                        setVisibleMonthDate(parseISODate(selection.nextDraft.customEnd));
                        setPickStep("start");
                        setHoverDate("");
                        if (selection.shouldApply) onApply(selection.nextDraft);
                      }}
                      className={cn(
                        "group flex w-full items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-all",
                        selected
                          ? "border-slate-900 bg-slate-900 text-white shadow-[0_10px_18px_rgba(15,23,42,0.18)]"
                          : "border-transparent bg-slate-50 text-slate-700 hover:border-slate-200 hover:bg-white"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                          selected
                            ? "border-white/30 bg-white/10 text-white"
                            : "border-slate-200 bg-white text-transparent group-hover:text-slate-400"
                        )}
                      >
                        <CheckIcon className="h-3 w-3" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">{preset.label}</span>
                        <span className={cn("mt-0.5 block text-[12px]", selected ? "text-white/75" : "text-slate-500")}>
                          {preset.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        <div className="p-3 md:p-3.5">
          <div className="space-y-3">
            <CompactPanelHeader
              title={monthTitle}
              summary={formatDateRange(resolvedRange.start, resolvedRange.end)}
              chips={[`${rangeDays}d`, resolvedTimeZone]}
              onPrev={canMovePrevious ? () => setVisibleMonthDate((current) => addMonths(current, -1)) : undefined}
              onNext={canMoveNext ? () => setVisibleMonthDate((current) => addMonths(current, 1)) : undefined}
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="hidden md:block">
                <CalendarMonth
                  year={previousMonthYear}
                  month={previousMonth}
                  rangeStart={resolvedRange.start}
                  rangeEnd={resolvedRange.end}
                  hoverDate={hoverDate}
                  pickStep={pickStep}
                  interactive
                  onDateClick={handleDateClick}
                  onDateHover={setHoverDate}
                  todayIso={todayIso}
                  minDate={minDate}
                  maxDate={maxDate}
                />
              </div>
              <CalendarMonth
                year={visibleYear}
                month={visibleMonth}
                rangeStart={resolvedRange.start}
                rangeEnd={resolvedRange.end}
                hoverDate={hoverDate}
                pickStep={pickStep}
                interactive
                onDateClick={handleDateClick}
                onDateHover={setHoverDate}
                todayIso={todayIso}
                minDate={minDate}
                maxDate={maxDate}
              />
            </div>
          </div>
        </div>
      </div>

      <CompactPanelFooter onCancel={onCancel} onApply={() => onApply()} />
    </div>
  );
}

function ComparisonPanel({
  draft,
  onDraftChange,
  onApply,
  onCancel,
  comparisonPresets,
  referenceDate,
  minDate,
  maxDate,
  includeCurrentDayInRollingRanges = false,
}: {
  draft: DateRangeValue;
  onDraftChange: (value: DateRangeValue) => void;
  onApply: (nextDraft?: DateRangeValue) => void;
  onCancel: () => void;
  comparisonPresets: ReadonlyArray<PresetOption<ComparisonPreset>>;
  referenceDate?: string;
  minDate?: string;
  maxDate?: string;
  includeCurrentDayInRollingRanges?: boolean;
}) {
  const presetSections = getPresetSections(comparisonPresets);
  const active = comparisonPresets.find((preset) => preset.value === draft.comparisonPreset) ?? comparisonPresets[0];
  const primaryRange = getResolvedPrimaryRange(draft, referenceDate, {
    includeCurrentDay: includeCurrentDayInRollingRanges,
  });
  const previewRange = getDerivedComparisonRange(
    primaryRange.start,
    primaryRange.end,
    draft.comparisonPreset,
    draft.comparisonStart,
    draft.comparisonEnd
  );
  const todayIso = referenceDate ?? getTodayIsoForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [pickStep, setPickStep] = useState<"start" | "end">("start");
  const [hoverDate, setHoverDate] = useState("");
  const [visibleMonthDate, setVisibleMonthDate] = useState<Date>(() => parseISODate(previewRange?.end ?? primaryRange.end));

  useEffect(() => {
    setVisibleMonthDate(parseISODate(previewRange?.end ?? primaryRange.end));
    setPickStep("start");
    setHoverDate("");
  }, [previewRange?.end, draft.comparisonPreset, primaryRange.end]);

  const visibleYear = visibleMonthDate.getUTCFullYear();
  const visibleMonth = visibleMonthDate.getUTCMonth();
  const previousMonthDate = addMonths(visibleMonthDate, -1);
  const previousMonthYear = previousMonthDate.getUTCFullYear();
  const previousMonth = previousMonthDate.getUTCMonth();
  const isCustomComparison = draft.comparisonPreset === "custom";
  const canMovePrevious = !minDate || toISO(previousMonthDate).slice(0, 7) > minDate.slice(0, 7);
  const canMoveNext = !maxDate || toISO(visibleMonthDate).slice(0, 7) < maxDate.slice(0, 7);
  const monthTitle =
    previousMonthYear === visibleYear
      ? `${MONTH_NAMES[previousMonth]} - ${MONTH_NAMES[visibleMonth]} ${visibleYear}`
      : `${MONTH_NAMES[previousMonth]} ${previousMonthYear} - ${MONTH_NAMES[visibleMonth]} ${visibleYear}`;

  function handleComparisonDateClick(date: string) {
    if (pickStep === "start" || !draft.comparisonStart || (draft.comparisonStart && draft.comparisonEnd)) {
      onDraftChange({
        ...draft,
        comparisonPreset: "custom",
        comparisonStart: date,
        comparisonEnd: date,
      });
      setPickStep("end");
      return;
    }

    if (date < draft.comparisonStart) {
      onDraftChange({
        ...draft,
        comparisonPreset: "custom",
        comparisonStart: date,
        comparisonEnd: draft.comparisonStart,
      });
    } else {
      onDraftChange({
        ...draft,
        comparisonPreset: "custom",
        comparisonStart: draft.comparisonStart,
        comparisonEnd: date,
      });
    }
    setPickStep("start");
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-[22px] bg-[linear-gradient(180deg,#f8fbff_0%,#f7f8fb_100%)]",
        isCustomComparison ? "w-[min(96vw,820px)]" : "w-[min(90vw,460px)]"
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-[196px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200/80 bg-white/92 p-3 md:border-b-0 md:border-r">
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.2em] text-slate-400">Compare To</div>

          <div className="max-h-[320px] overflow-y-auto pr-1 md:max-h-[380px]">
            {presetSections.map((section) => (
              <div key={section.label} className="mb-3 space-y-1">
                <div className="px-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {section.label}
                </div>
                {section.items.map((preset) => {
                  const selected = draft.comparisonPreset === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        if (preset.value === "custom") {
                          const nextStart = draft.comparisonStart || primaryRange.start;
                          const nextEnd = draft.comparisonEnd || primaryRange.end;
                          onDraftChange({
                            ...draft,
                            comparisonPreset: "custom",
                            comparisonStart: nextStart,
                            comparisonEnd: nextEnd,
                          });
                          setPickStep("start");
                          return;
                        }

                        onDraftChange({
                          ...draft,
                          comparisonPreset: preset.value,
                          comparisonStart: "",
                          comparisonEnd: "",
                        });
                      }}
                      className={cn(
                        "group flex w-full items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-all",
                        selected
                          ? "border-slate-900 bg-slate-900 text-white shadow-[0_10px_18px_rgba(15,23,42,0.18)]"
                          : "border-transparent bg-slate-50 text-slate-700 hover:border-slate-200 hover:bg-white"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                          selected
                            ? "border-white/30 bg-white/10 text-white"
                            : "border-slate-200 bg-white text-transparent group-hover:text-slate-400"
                        )}
                      >
                        <CheckIcon className="h-3 w-3" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">{preset.label}</span>
                        <span className={cn("mt-0.5 block text-[12px]", selected ? "text-white/75" : "text-slate-500")}>
                          {preset.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        <div className="p-3 md:p-3.5">
          <div className="space-y-3">
            <CompactPanelHeader
              title={isCustomComparison ? monthTitle : active.label}
              summary={
                previewRange
                  ? formatDateRange(previewRange.start, previewRange.end)
                  : "Comparison stays off until you pick a benchmark period."
              }
              chips={previewRange ? [active.label, `${getRangeDays(previewRange.start, previewRange.end)}d`] : [active.label]}
              onPrev={isCustomComparison && canMovePrevious ? () => setVisibleMonthDate((current) => addMonths(current, -1)) : undefined}
              onNext={isCustomComparison && canMoveNext ? () => setVisibleMonthDate((current) => addMonths(current, 1)) : undefined}
            />

            {isCustomComparison ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="hidden md:block">
                  <CalendarMonth
                    year={previousMonthYear}
                    month={previousMonth}
                    rangeStart={previewRange?.start ?? primaryRange.start}
                    rangeEnd={previewRange?.end ?? primaryRange.end}
                    hoverDate={hoverDate}
                    pickStep={pickStep}
                    interactive
                    onDateClick={handleComparisonDateClick}
                    onDateHover={setHoverDate}
                    todayIso={todayIso}
                    minDate={minDate}
                    maxDate={maxDate}
                  />
                </div>
                <CalendarMonth
                  year={visibleYear}
                  month={visibleMonth}
                  rangeStart={previewRange?.start ?? primaryRange.start}
                  rangeEnd={previewRange?.end ?? primaryRange.end}
                  hoverDate={hoverDate}
                  pickStep={pickStep}
                  interactive
                  onDateClick={handleComparisonDateClick}
                  onDateHover={setHoverDate}
                  todayIso={todayIso}
                  minDate={minDate}
                  maxDate={maxDate}
                />
              </div>
            ) : (
              <div className="rounded-[18px] border border-slate-200/80 bg-white/92 px-3 py-3 text-sm text-slate-600 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
                <div className="font-medium text-slate-900">{active.label}</div>
                <div className="mt-1 text-xs leading-relaxed text-slate-500">{getComparisonDescription(active.value)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <CompactPanelFooter onCancel={onCancel} onApply={() => onApply()} />
    </div>
  );
}

export const DATE_RANGE_PICKER_INTERNALS = {
  ComparisonPanel,
  RangePanel,
};

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  className?: string;
  label?: string;
  /**
   * One line explaining what the range actually changes.
   *
   * A range control implies the whole surface is scoped by it. Where that is
   * not true, the label alone cannot correct an operator who already believes
   * the usual meaning, so the surface can state the boundary here.
   */
  hint?: string;
  testId?: string;
  /** "v2" draws the design's shell trigger; default keeps the page form. */
  variant?: "default" | "v2";
  showComparisonTrigger?: boolean;
  comparisonPlaceholderLabel?: string;
  rangePresets?: RangePreset[];
  /** Narrow the offered comparisons to the ones this surface can carry. */
  comparisonPresets?: readonly ComparisonPreset[];
  referenceDate?: string;
  timeZoneLabel?: string;
  minDate?: string;
  maxDate?: string | null;
  includeCurrentDayInRollingRanges?: boolean;
  disabled?: boolean;
  align?: "start" | "center" | "end";
}

export function DateRangePicker({
  value,
  onChange,
  className,
  label = "Date range",
  hint,
  testId = "date-range-picker",
  variant = "default",
  showComparisonTrigger = true,
  comparisonPlaceholderLabel = "None",
  rangePresets,
  comparisonPresets,
  referenceDate,
  timeZoneLabel,
  minDate,
  maxDate,
  includeCurrentDayInRollingRanges = false,
  disabled = false,
  align = "start",
}: DateRangePickerProps) {
  const isV2 = variant === "v2";
  const [openMode, setOpenMode] = useState<"range" | "comparison" | null>(null);
  const [draft, setDraft] = useState<DateRangeValue>(value);
  const [hydrated, setHydrated] = useState(false);
  const [, startApplyTransition] = useTransition();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const localToday = getTodayIsoForTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const resolvedMaxDate = maxDate === null ? undefined : maxDate ?? referenceDate ?? localToday;
  const rangeOptions = { includeCurrentDay: includeCurrentDayInRollingRanges };

  useEffect(() => setHydrated(true), []);

  const availableRangePresets = useMemo(
    () =>
      rangePresets && rangePresets.length > 0
        ? RANGE_PRESETS.filter((preset) => rangePresets.includes(preset.value))
        : RANGE_PRESETS,
    [rangePresets]
  );

  const availableComparisonPresets = useMemo(
    () =>
      comparisonPresets && comparisonPresets.length > 0
        ? COMPARISON_PRESETS.filter((preset) => comparisonPresets.includes(preset.value))
        : COMPARISON_PRESETS,
    [comparisonPresets]
  );

  function resolveDraft(nextValue: DateRangeValue): DateRangeValue {
    if (nextValue.rangePreset === "custom") {
      const bounded = normalizeDateWindowBounds(
        {
          window: "custom",
          start: nextValue.customStart,
          end: nextValue.customEnd,
        },
        { minDate, maxDate: resolvedMaxDate },
      );
      return {
        ...nextValue,
        customStart: bounded.start,
        customEnd: bounded.end,
      };
    }
    if (!referenceDate) return { ...nextValue };

    const resolved = getPresetDatesForReferenceDate(
      nextValue.rangePreset,
      referenceDate,
      nextValue.customStart,
      nextValue.customEnd,
      rangeOptions
    );

    return {
      ...nextValue,
      customStart: resolved.start,
      customEnd: resolved.end,
    };
  }

  function openPanel(mode: "range" | "comparison") {
    setDraft(resolveDraft(value));
    setOpenMode(mode);
  }

  function handleApply(nextDraft?: DateRangeValue) {
    const appliedDraft = nextDraft ?? draft;
    setOpenMode(null);
    startApplyTransition(() => {
      onChange(appliedDraft);
    });
  }

  function handleCancel() {
    setDraft(resolveDraft(value));
    setOpenMode(null);
  }

  function handleV2ComparisonToggle() {
    startApplyTransition(() => {
      onChange(togglePreviousPeriodComparison(value));
    });
  }

  const presetRangeLabel = getTriggerLabelForReferenceDate(
    value,
    availableRangePresets,
    referenceDate,
    rangeOptions
  );
  const comparisonLabel =
    value.comparisonPreset === "none"
      ? comparisonPlaceholderLabel
      : value.comparisonPreset === "custom" && value.comparisonStart && value.comparisonEnd
        ? formatDateRange(value.comparisonStart, value.comparisonEnd)
      : availableComparisonPresets.find((preset) => preset.value === value.comparisonPreset)?.label ?? comparisonPlaceholderLabel;
  const resolvedRange =
    referenceDate && value.rangePreset !== "custom"
      ? getPresetDatesForReferenceDate(
          value.rangePreset,
          referenceDate,
          value.customStart,
          value.customEnd,
          rangeOptions
        )
      : getPresetDates(value.rangePreset, value.customStart, value.customEnd, rangeOptions);
  const resolvedRangeDays = getRangeDays(resolvedRange.start, resolvedRange.end);
  const rangeLabel = formatDateRange(resolvedRange.start, resolvedRange.end);
  const rangeMetaLabel =
    value.rangePreset === "custom"
      ? `${resolvedRangeDays} day${resolvedRangeDays === 1 ? "" : "s"}`
      : presetRangeLabel;

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const action = getPickerKeyboardAction(event.key);
    if (!action) return;
    if (action === "apply" && event.target !== event.currentTarget) return;
    event.preventDefault();
    if (action === "apply") handleApply();
    if (action === "cancel") handleCancel();
  }

  const controls = (
    <>
      <Popover.Root
        open={openMode === "range"}
        onOpenChange={(open) => {
          if (open) openPanel("range");
          else if (openMode === "range") handleCancel();
        }}
      >
        <Popover.Trigger asChild>
          {isV2 ? (
            <button
              type="button"
              disabled={disabled}
              aria-label={label}
              data-testid={`${testId}-trigger`}
              className="adv-date-range-trigger"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              >
                <path d="M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
              </svg>
              <span>{rangeMetaLabel}</span>
              <span data-topbar-secondary>{rangeLabel}</span>
              <ChevronDownIcon className="h-[13px] w-[13px] shrink-0 text-[#7a869e]" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              aria-label={label}
              data-testid={`${testId}-trigger`}
              className="group inline-flex min-h-8 items-center gap-2.5 rounded-[14px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-2.5 py-2 text-left shadow-[0_8px_18px_rgba(15,23,42,0.05)] transition-all hover:border-slate-300 hover:shadow-[0_10px_20px_rgba(15,23,42,0.08)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
                <CalendarIcon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
                <span className="block truncate text-xs font-semibold text-slate-900">{rangeLabel}</span>
                {hint ? (
                  <span
                    data-date-range-hint="true"
                    className="mt-0.5 block max-w-[42ch] text-[12px] font-normal normal-case tracking-normal text-slate-600"
                  >
                    {hint}
                  </span>
                ) : null}
              </span>
              <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-medium text-slate-600 sm:inline-flex">
                {rangeMetaLabel}
              </span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={10}
            align={align}
            collisionPadding={12}
            className="z-50 overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_26px_72px_rgba(15,23,42,0.22)]"
            onInteractOutside={handleCancel}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panelRef.current?.focus();
            }}
          >
            <div ref={panelRef} tabIndex={-1} onKeyDown={handlePanelKeyDown} className="outline-none">
              <RangePanel
                draft={draft}
                onDraftChange={setDraft}
                onApply={handleApply}
                onCancel={handleCancel}
                rangePresets={availableRangePresets}
                referenceDate={referenceDate}
                timeZoneLabel={timeZoneLabel}
                minDate={minDate}
                maxDate={resolvedMaxDate}
                includeCurrentDayInRollingRanges={includeCurrentDayInRollingRanges}
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {showComparisonTrigger && isV2 ? (
        <span
          title="Toggle comparison with the previous period"
          className="adv-date-comparison-trigger"
          data-active={value.comparisonPreset !== "none"}
          role="button"
          aria-pressed={value.comparisonPreset !== "none"}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onClick={disabled ? undefined : handleV2ComparisonToggle}
          onKeyDown={(event) => {
            if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            handleV2ComparisonToggle();
          }}
        >
          {value.comparisonPreset === "none" ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[11px] w-[11px] shrink-0"
              aria-hidden="true"
            >
              <path d="M8 12h8" />
            </svg>
          ) : (
            <CheckIcon
              className="h-[11px] w-[11px] shrink-0"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          )}
          <span>vs previous period</span>
        </span>
      ) : showComparisonTrigger ? (
        <Popover.Root
          open={openMode === "comparison"}
          onOpenChange={(open) => {
            if (open) openPanel("comparison");
            else if (openMode === "comparison") handleCancel();
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Comparison date range"
              className={cn(
                "group inline-flex min-h-8 items-center gap-2 rounded-[14px] border px-2.5 py-2 text-left shadow-[0_8px_18px_rgba(15,23,42,0.05)] transition-all disabled:cursor-not-allowed disabled:opacity-60",
                value.comparisonPreset === "none"
                  ? "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  : "border-blue-200 bg-blue-50 text-blue-800 hover:border-blue-300"
              )}
            >
              <span className="block">
                <span className="block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">Compare</span>
                <span className="block text-xs font-semibold">{comparisonLabel}</span>
              </span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={10}
              align={align}
              collisionPadding={12}
              className="z-50 overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_26px_72px_rgba(15,23,42,0.22)]"
              onInteractOutside={handleCancel}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                panelRef.current?.focus();
              }}
            >
              <div ref={panelRef} tabIndex={-1} onKeyDown={handlePanelKeyDown} className="outline-none">
                <ComparisonPanel
                  draft={draft}
                  onDraftChange={setDraft}
                  onApply={handleApply}
                  onCancel={handleCancel}
                  comparisonPresets={availableComparisonPresets}
                  referenceDate={referenceDate}
                  minDate={minDate}
                  maxDate={resolvedMaxDate}
                  includeCurrentDayInRollingRanges={includeCurrentDayInRollingRanges}
                />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </>
  );

  if (isV2) return controls;

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-testid={testId}
      data-hydrated={hydrated}
    >
      {controls}
    </div>
  );
}

export interface DatePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
  placeholder?: string;
  className?: string;
  testId?: string;
  referenceDate?: string;
  minDate?: string;
  maxDate?: string | null;
  allowClear?: boolean;
  disabled?: boolean;
  align?: "start" | "center" | "end";
}

export function DatePicker({
  value,
  onChange,
  label,
  placeholder = "Select date",
  className,
  testId = "date-picker",
  referenceDate,
  minDate,
  maxDate,
  allowClear = true,
  disabled = false,
  align = "start",
}: DatePickerProps) {
  const localToday = getTodayIsoForTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const todayIso = referenceDate ?? localToday;
  const initialDate = value || maxDate || referenceDate || localToday;
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [visibleMonthDate, setVisibleMonthDate] = useState(() => parseISODate(initialDate));
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setVisibleMonthDate(parseISODate(value || maxDate || referenceDate || localToday));
  }, [localToday, maxDate, open, referenceDate, value]);

  useEffect(() => setHydrated(true), []);

  const visibleYear = visibleMonthDate.getUTCFullYear();
  const visibleMonth = visibleMonthDate.getUTCMonth();
  const canMovePrevious =
    !minDate || toISO(visibleMonthDate).slice(0, 7) > minDate.slice(0, 7);
  const canMoveNext =
    !maxDate || toISO(visibleMonthDate).slice(0, 7) < maxDate.slice(0, 7);

  return (
    <div
      className={cn("inline-flex min-w-0", className)}
      data-testid={testId}
      data-hydrated={hydrated}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            data-testid={`${testId}-trigger`}
            className="group inline-flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CalendarIcon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                {label}
              </span>
              <span className={cn("block truncate text-xs font-semibold", value ? "text-slate-900" : "text-slate-500")}>
                {value ? formatLongDate(value) : placeholder}
              </span>
            </span>
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={8}
            align={align}
            collisionPadding={12}
            className="z-50 w-[min(92vw,340px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_24px_64px_rgba(15,23,42,0.2)]"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panelRef.current?.focus();
            }}
          >
            <div
              ref={panelRef}
              tabIndex={-1}
              className="outline-none"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setOpen(false);
              }}
            >
              <div className="p-3">
                <CompactPanelHeader
                  title={`${MONTH_NAMES[visibleMonth]} ${visibleYear}`}
                  chips={[]}
                  onPrev={
                    canMovePrevious
                      ? () => setVisibleMonthDate((current) => addMonths(current, -1))
                      : undefined
                  }
                  onNext={
                    canMoveNext
                      ? () => setVisibleMonthDate((current) => addMonths(current, 1))
                      : undefined
                  }
                />
                <div className="mt-3">
                  <CalendarMonth
                    year={visibleYear}
                    month={visibleMonth}
                    rangeStart={value ?? ""}
                    rangeEnd={value ?? ""}
                    hoverDate=""
                    pickStep="start"
                    interactive
                    onDateClick={(date) => {
                      onChange(date);
                      setOpen(false);
                    }}
                    onDateHover={() => undefined}
                    todayIso={todayIso}
                    minDate={minDate}
                    maxDate={maxDate ?? undefined}
                  />
                </div>
              </div>
              {allowClear && value ? (
                <div className="flex justify-end border-t border-slate-200 px-3 py-2.5">
                  <button
                    type="button"
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                  >
                    Clear date
                  </button>
                </div>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
