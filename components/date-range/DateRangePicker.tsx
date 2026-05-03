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
  | "30d"
  | "90d"
  | "365d"
  | "lastMonth"
  | "custom";

export type ComparisonPreset =
  | "none"
  | "custom"
  | "previousPeriod"
  | "previousWeek"
  | "previousMonth"
  | "previousQuarter"
  | "previousYear"
  | "previousYearMatch";

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

type PresetOption<TValue extends string> = {
  value: TValue;
  label: string;
  hint: string;
  group: string;
};

const RANGE_PRESETS: ReadonlyArray<PresetOption<RangePreset>> = [
  { value: "today", label: "Today", hint: "Only the current day", group: "Quick Select" },
  { value: "yesterday", label: "Yesterday", hint: "Previous completed day", group: "Quick Select" },
  { value: "3d", label: "Last 3 days", hint: "Short performance pulse", group: "Rolling Windows" },
  { value: "7d", label: "Last 7 days", hint: "Weekly read", group: "Rolling Windows" },
  { value: "14d", label: "Last 14 days", hint: "Bi-weekly stability", group: "Rolling Windows" },
  { value: "30d", label: "Last 30 days", hint: "Balanced operating view", group: "Rolling Windows" },
  { value: "90d", label: "Last 90 days", hint: "Quarter-scale context", group: "Rolling Windows" },
  { value: "365d", label: "Last 365 days", hint: "Long-term trend", group: "Rolling Windows" },
  { value: "lastMonth", label: "Last month", hint: "Previous full calendar month", group: "Calendar Periods" },
  { value: "custom", label: "Custom range", hint: "Pick exact dates", group: "Custom" },
];

const COMPARISON_PRESETS: ReadonlyArray<PresetOption<ComparisonPreset>> = [
  { value: "none", label: "None", hint: "Keep the view focused on one period", group: "Compare" },
  { value: "custom", label: "Custom range", hint: "Pick exact comparison dates", group: "Compare" },
  { value: "previousPeriod", label: "Previous period", hint: "Same length immediately before", group: "Compare" },
  { value: "previousWeek", label: "Previous week", hint: "Useful for weekly pacing", group: "Compare" },
  { value: "previousMonth", label: "Previous month", hint: "Month-over-month check", group: "Compare" },
  { value: "previousQuarter", label: "Previous quarter", hint: "Quarter-level benchmark", group: "Compare" },
  { value: "previousYear", label: "Previous year", hint: "Year-over-year comparison", group: "Compare" },
  { value: "previousYearMatch", label: "Previous year (match)", hint: "Calendar-matched year-over-year", group: "Compare" },
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function getPresetDatesForReferenceDate(
  preset: RangePreset,
  referenceDate: string,
  customStart?: string,
  customEnd?: string
): { start: string; end: string } {
  const today = parseISODate(referenceDate);
  const completedRollingWindow = (days: number) => {
    const end = addDays(today, -1);
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
    case "30d":
      return completedRollingWindow(30);
    case "90d":
      return completedRollingWindow(90);
    case "365d":
      return completedRollingWindow(365);
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
  customEnd?: string
): { start: string; end: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return getPresetDatesForReferenceDate(
    preset,
    getTodayIsoForTimeZone(timeZone),
    customStart,
    customEnd
  );
}

export function resolveRangePresetSelection(
  draft: DateRangeValue,
  preset: RangePreset,
  referenceDate?: string
): { nextDraft: DateRangeValue; shouldApply: boolean } {
  const resolved = referenceDate
    ? getPresetDatesForReferenceDate(preset, referenceDate, draft.customStart, draft.customEnd)
    : getPresetDates(preset, draft.customStart, draft.customEnd);

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
  referenceDate?: string
): string {
  if (value.rangePreset === "custom") {
    return formatDateRange(value.customStart, value.customEnd) || "Custom range";
  }
  if (!referenceDate) return getTriggerLabel(value, presets);

  const { start, end } = getPresetDatesForReferenceDate(
    value.rangePreset,
    referenceDate,
    value.customStart,
    value.customEnd
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
    case "previousWeek":
      return "Useful for weekly pacing, traffic quality shifts, and recent operational checks.";
    case "previousMonth":
      return "Helps you benchmark the current period against the prior calendar month.";
    case "previousQuarter":
      return "Best when you want a broader benchmark for seasonal or strategic movement.";
    case "previousYear":
      return "A direct year-over-year lens for growth, efficiency, and seasonality.";
    case "previousYearMatch":
      return "Aligns this period with a calendar-matched version from the previous year.";
  }
}

function getResolvedPrimaryRange(draft: DateRangeValue, referenceDate?: string) {
  return referenceDate
    ? getPresetDatesForReferenceDate(draft.rangePreset, referenceDate, draft.customStart, draft.customEnd)
    : getPresetDates(draft.rangePreset, draft.customStart, draft.customEnd);
}

function getDerivedComparisonRange(
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

  if (customStart && customEnd) {
    return { start: customStart, end: customEnd };
  }

  const days = getRangeDays(primaryStart, primaryEnd);

  if (preset === "previousPeriod") {
    const end = toISO(addDays(parseISODate(primaryStart), -1));
    const start = toISO(addDays(parseISODate(end), -(days - 1)));
    return { start, end };
  }

  if (preset === "previousWeek") {
    return {
      start: toISO(addDays(parseISODate(primaryStart), -7)),
      end: toISO(addDays(parseISODate(primaryEnd), -7)),
    };
  }

  if (preset === "previousMonth") {
    return {
      start: toISO(addDays(parseISODate(primaryStart), -30)),
      end: toISO(addDays(parseISODate(primaryEnd), -30)),
    };
  }

  if (preset === "previousQuarter") {
    return {
      start: toISO(addDays(parseISODate(primaryStart), -90)),
      end: toISO(addDays(parseISODate(primaryEnd), -90)),
    };
  }

  return {
    start: toISO(addDays(parseISODate(primaryStart), -365)),
    end: toISO(addDays(parseISODate(primaryEnd), -365)),
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
              "flex h-7 items-center justify-center text-[10px] font-semibold uppercase tracking-[0.16em]",
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

          return (
            <div key={date} className="flex h-8 items-center justify-center">
              <button
                type="button"
                onClick={() => interactive && onDateClick(date)}
                onMouseEnter={() => interactive && onDateHover(date)}
                className={cn(
                  "relative flex h-7 w-7 items-center justify-center rounded-xl text-xs font-medium transition-all",
                  interactive ? "cursor-pointer" : "cursor-default",
                  isStart || isEnd
                    ? "bg-slate-900 text-white shadow-[0_8px_14px_rgba(15,23,42,0.2)]"
                    : inRange
                      ? "rounded-lg bg-blue-50 text-blue-700"
                      : "text-slate-700 hover:bg-slate-100",
                  isToday && !(isStart || isEnd) && "border border-blue-200 text-blue-700"
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
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-medium text-slate-600"
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
}: {
  draft: DateRangeValue;
  onDraftChange: (value: DateRangeValue) => void;
  onApply: (nextDraft?: DateRangeValue) => void;
  onCancel: () => void;
  rangePresets: ReadonlyArray<PresetOption<RangePreset>>;
  referenceDate?: string;
  timeZoneLabel?: string;
}) {
  const todayIso = referenceDate ?? getTodayIsoForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const resolvedRange = referenceDate
    ? getPresetDatesForReferenceDate(draft.rangePreset, referenceDate, draft.customStart, draft.customEnd)
    : getPresetDates(draft.rangePreset, draft.customStart, draft.customEnd);

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
  const presetSections = getPresetSections(rangePresets);
  const rangeDays = getRangeDays(resolvedRange.start, resolvedRange.end);
  const resolvedTimeZone = timeZoneLabel ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function handleDateClick(date: string) {
    const selection = resolveRangeCalendarDateClick(draft, pickStep, date);
    onDraftChange(selection.nextDraft);
    setPickStep(selection.nextPickStep);
    if (selection.shouldApply) onApply(selection.nextDraft);
  }

  return (
    <div className="flex w-[min(94vw,620px)] flex-col overflow-hidden rounded-[22px] bg-[linear-gradient(180deg,#f8fbff_0%,#f7f8fb_100%)]">
      <div className="grid grid-cols-1 md:grid-cols-[196px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200/80 bg-white/92 p-3 md:border-b-0 md:border-r">
          <div className="mb-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Date Range</div>
            <div className="mt-1 text-xs text-slate-500">One standard picker for every Adsecute surface.</div>
          </div>

          <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1 md:max-h-[420px]">
            {presetSections.map((section) => (
              <div key={section.label} className="space-y-1">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {section.label}
                </div>
                {section.items.map((preset) => {
                  const selected = draft.rangePreset === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        const selection = resolveRangePresetSelection(draft, preset.value, referenceDate);
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
                        <span className={cn("mt-0.5 block text-[10px]", selected ? "text-white/75" : "text-slate-500")}>
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
              title={`${MONTH_NAMES[visibleMonth]} ${visibleYear}`}
              summary={formatDateRange(resolvedRange.start, resolvedRange.end)}
              chips={[`${rangeDays}d`, resolvedTimeZone]}
              onPrev={() => setVisibleMonthDate((current) => addMonths(current, -1))}
              onNext={() => setVisibleMonthDate((current) => addMonths(current, 1))}
            />
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
            />
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
}: {
  draft: DateRangeValue;
  onDraftChange: (value: DateRangeValue) => void;
  onApply: (nextDraft?: DateRangeValue) => void;
  onCancel: () => void;
  comparisonPresets: ReadonlyArray<PresetOption<ComparisonPreset>>;
  referenceDate?: string;
}) {
  const presetSections = getPresetSections(comparisonPresets);
  const active = comparisonPresets.find((preset) => preset.value === draft.comparisonPreset) ?? comparisonPresets[0];
  const primaryRange = getResolvedPrimaryRange(draft, referenceDate);
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
  const isCustomComparison = draft.comparisonPreset === "custom";

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
        isCustomComparison ? "w-[min(94vw,620px)]" : "w-[min(90vw,460px)]"
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-[196px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200/80 bg-white/92 p-3 md:border-b-0 md:border-r">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Compare To</div>

          <div className="max-h-[320px] overflow-y-auto pr-1 md:max-h-[380px]">
            {presetSections.map((section) => (
              <div key={section.label} className="mb-3 space-y-1">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
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
                        <span className={cn("mt-0.5 block text-[10px]", selected ? "text-white/75" : "text-slate-500")}>
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
              title={isCustomComparison ? `${MONTH_NAMES[visibleMonth]} ${visibleYear}` : active.label}
              summary={
                previewRange
                  ? formatDateRange(previewRange.start, previewRange.end)
                  : "Comparison stays off until you pick a benchmark period."
              }
              chips={previewRange ? [active.label, `${getRangeDays(previewRange.start, previewRange.end)}d`] : [active.label]}
              onPrev={isCustomComparison ? () => setVisibleMonthDate((current) => addMonths(current, -1)) : undefined}
              onNext={isCustomComparison ? () => setVisibleMonthDate((current) => addMonths(current, 1)) : undefined}
            />

            {isCustomComparison ? (
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
              />
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
  showComparisonTrigger?: boolean;
  comparisonPlaceholderLabel?: string;
  rangePresets?: RangePreset[];
  comparisonPresets?: ComparisonPreset[];
  referenceDate?: string;
  timeZoneLabel?: string;
}

export function DateRangePicker({
  value,
  onChange,
  className,
  showComparisonTrigger = true,
  comparisonPlaceholderLabel = "None",
  rangePresets,
  comparisonPresets,
  referenceDate,
  timeZoneLabel,
}: DateRangePickerProps) {
  const [openMode, setOpenMode] = useState<"range" | "comparison" | null>(null);
  const [draft, setDraft] = useState<DateRangeValue>(value);
  const [, startApplyTransition] = useTransition();
  const panelRef = useRef<HTMLDivElement | null>(null);

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
    if (!referenceDate || nextValue.rangePreset === "custom") return { ...nextValue };

    const resolved = getPresetDatesForReferenceDate(
      nextValue.rangePreset,
      referenceDate,
      nextValue.customStart,
      nextValue.customEnd
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

  const rangeLabel = getTriggerLabelForReferenceDate(value, availableRangePresets, referenceDate);
  const comparisonLabel =
    value.comparisonPreset === "none"
      ? comparisonPlaceholderLabel
      : value.comparisonPreset === "custom" && value.comparisonStart && value.comparisonEnd
        ? formatDateRange(value.comparisonStart, value.comparisonEnd)
      : availableComparisonPresets.find((preset) => preset.value === value.comparisonPreset)?.label ?? comparisonPlaceholderLabel;
  const resolvedRange =
    referenceDate && value.rangePreset !== "custom"
      ? getPresetDatesForReferenceDate(value.rangePreset, referenceDate, value.customStart, value.customEnd)
      : getPresetDates(value.rangePreset, value.customStart, value.customEnd);
  const rangeMetaLabel = `${getRangeDays(resolvedRange.start, resolvedRange.end)} day${
    getRangeDays(resolvedRange.start, resolvedRange.end) === 1 ? "" : "s"
  }`;

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const action = getPickerKeyboardAction(event.key);
    if (!action) return;
    event.preventDefault();
    if (action === "apply") handleApply();
    if (action === "cancel") handleCancel();
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <Popover.Root
        open={openMode === "range"}
        onOpenChange={(open) => {
          if (open) openPanel("range");
          else if (openMode === "range") handleCancel();
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="group inline-flex min-h-8 items-center gap-2.5 rounded-[14px] border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-2.5 py-2 text-left shadow-[0_8px_18px_rgba(15,23,42,0.05)] transition-all hover:border-slate-300 hover:shadow-[0_10px_20px_rgba(15,23,42,0.08)]"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <CalendarIcon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Date range</span>
              <span className="block truncate text-xs font-semibold text-slate-900">{rangeLabel}</span>
            </span>
            <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 sm:inline-flex">
              {rangeMetaLabel}
            </span>
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={10}
            align="start"
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
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {showComparisonTrigger ? (
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
              className={cn(
                "group inline-flex min-h-8 items-center gap-2 rounded-[14px] border px-2.5 py-2 text-left shadow-[0_8px_18px_rgba(15,23,42,0.05)] transition-all",
                value.comparisonPreset === "none"
                  ? "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  : "border-blue-200 bg-blue-50 text-blue-800 hover:border-blue-300"
              )}
            >
              <span className="block">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Compare</span>
                <span className="block text-xs font-semibold">{comparisonLabel}</span>
              </span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={10}
              align="start"
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
                />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}
