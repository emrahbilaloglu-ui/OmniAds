"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

export type DateRangePresetKey =
  | "today"
  | "yesterday"
  | "7d"
  | "14d"
  | "28d"
  | "90d"
  | "this_month"
  | "last_month"
  | "custom";

export interface DateRangeValue {
  preset: DateRangePresetKey;
  startDate: string;
  endDate: string;
}

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  className?: string;
  label?: string;
  testId?: string;
}

const PRESETS: ReadonlyArray<{
  key: Exclude<DateRangePresetKey, "custom">;
  label: string;
  spanDays?: number;
}> = [
  { key: "today", label: "Today", spanDays: 1 },
  { key: "yesterday", label: "Yesterday", spanDays: 1 },
  { key: "7d", label: "Last 7d", spanDays: 7 },
  { key: "14d", label: "Last 14d", spanDays: 14 },
  { key: "28d", label: "Last 28d", spanDays: 28 },
  { key: "90d", label: "Last 90d", spanDays: 90 },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const DAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

function toIso(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIso(iso: string): Date {
  const [yyyy, mm, dd] = iso.split("-").map(Number);
  return new Date(yyyy, (mm ?? 1) - 1, dd ?? 1);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatShortDate(iso: string): string {
  const d = parseIso(iso);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

export function computeRangeFromPreset(
  preset: Exclude<DateRangePresetKey, "custom">,
  reference: Date = new Date(),
): { startDate: string; endDate: string } {
  const today = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
  );
  if (preset === "today") {
    return { startDate: toIso(today), endDate: toIso(today) };
  }
  if (preset === "yesterday") {
    const y = addDays(today, -1);
    return { startDate: toIso(y), endDate: toIso(y) };
  }
  if (preset === "this_month") {
    return { startDate: toIso(startOfMonth(today)), endDate: toIso(today) };
  }
  if (preset === "last_month") {
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { startDate: toIso(startOfMonth(prev)), endDate: toIso(endOfMonth(prev)) };
  }
  const days =
    PRESETS.find((preset_) => preset_.key === preset)?.spanDays ?? 28;
  return { startDate: toIso(addDays(today, -(days - 1))), endDate: toIso(today) };
}

function rangeSpanDays(start: string, end: string): number {
  const s = parseIso(start).getTime();
  const e = parseIso(end).getTime();
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

export function DateRangePicker({
  value,
  onChange,
  className,
  label = "Date range",
  testId = "date-range-picker",
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<DateRangeValue>(value);
  const [activeMonth, setActiveMonth] = useState<Date>(() =>
    parseIso(value.endDate || toIso(new Date())),
  );
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);

  useEffect(() => {
    setPending(value);
    setActiveMonth(parseIso(value.endDate || toIso(new Date())));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onDocumentMouseDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const spanLabel = useMemo(() => {
    if (pending.preset && pending.preset !== "custom") {
      const named = PRESETS.find((preset_) => preset_.key === pending.preset);
      if (named) return named.label;
    }
    const days = rangeSpanDays(pending.startDate, pending.endDate);
    return `${days}d`;
  }, [pending]);

  const chipLabel = `${formatShortDate(value.startDate)} – ${formatShortDate(
    value.endDate,
  )}`;
  const chipSubtitle =
    value.preset && value.preset !== "custom"
      ? `· ${PRESETS.find((preset_) => preset_.key === value.preset)?.label ?? "Custom"}`
      : `· ${rangeSpanDays(value.startDate, value.endDate)}d`;

  function handlePresetClick(preset: Exclude<DateRangePresetKey, "custom">) {
    const range = computeRangeFromPreset(preset);
    setPending({ preset, ...range });
    setActiveMonth(parseIso(range.endDate));
    setPickAnchor(null);
  }

  function handleDayClick(iso: string) {
    if (!pickAnchor) {
      setPickAnchor(iso);
      setPending({ preset: "custom", startDate: iso, endDate: iso });
      return;
    }
    const [start, end] = pickAnchor < iso ? [pickAnchor, iso] : [iso, pickAnchor];
    setPending({ preset: "custom", startDate: start, endDate: end });
    setPickAnchor(null);
  }

  function handleApply() {
    onChange(pending);
    setOpen(false);
  }

  function handleCancel() {
    setPending(value);
    setOpen(false);
  }

  const left = activeMonth;
  const right = new Date(activeMonth.getFullYear(), activeMonth.getMonth() + 1, 1);

  return (
    <div
      ref={containerRef}
      className={"relative inline-block " + (className ?? "")}
      data-testid={testId}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((next) => !next)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        data-testid={`${testId}-trigger`}
      >
        <Calendar size={12} aria-hidden="true" className="text-slate-500" />
        <span className="font-mono tabular-nums">{chipLabel}</span>
        <span className="text-slate-500">{chipSubtitle}</span>
        <span aria-hidden="true" className="text-slate-400">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className="absolute right-0 top-full z-50 mt-1.5 w-[640px] max-w-[calc(100vw-32px)] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"
          data-testid={`${testId}-popover`}
        >
          <div className="grid grid-cols-[170px_minmax(0,1fr)] gap-4">
            <div className="flex flex-col gap-1 text-[12px]">
              <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Quick picks
              </div>
              {PRESETS.map((preset_) => {
                const isActive = pending.preset === preset_.key;
                return (
                  <button
                    key={preset_.key}
                    type="button"
                    onClick={() => handlePresetClick(preset_.key)}
                    aria-pressed={isActive}
                    className={
                      "rounded-md px-2 py-1.5 text-left " +
                      (isActive
                        ? "bg-indigo-50 font-semibold text-indigo-700"
                        : "text-slate-700 hover:bg-slate-50")
                    }
                  >
                    {preset_.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() =>
                  setPending((current) => ({ ...current, preset: "custom" }))
                }
                aria-pressed={pending.preset === "custom"}
                className={
                  "rounded-md px-2 py-1.5 text-left " +
                  (pending.preset === "custom"
                    ? "bg-indigo-50 font-semibold text-indigo-700"
                    : "text-slate-700 hover:bg-slate-50")
                }
              >
                Custom range
              </button>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-[12px] text-slate-700">
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() =>
                    setActiveMonth(
                      (current) =>
                        new Date(current.getFullYear(), current.getMonth() - 1, 1),
                    )
                  }
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  <ChevronLeft size={12} aria-hidden="true" />
                </button>
                <div className="flex items-center gap-6 font-semibold tracking-tight">
                  <span>
                    {MONTH_NAMES[left.getMonth()]} {left.getFullYear()}
                  </span>
                  <span>
                    {MONTH_NAMES[right.getMonth()]} {right.getFullYear()}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() =>
                    setActiveMonth(
                      (current) =>
                        new Date(current.getFullYear(), current.getMonth() + 1, 1),
                    )
                  }
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <CalendarMonth
                  monthDate={left}
                  range={{ startDate: pending.startDate, endDate: pending.endDate }}
                  onDayClick={handleDayClick}
                />
                <CalendarMonth
                  monthDate={right}
                  range={{ startDate: pending.startDate, endDate: pending.endDate }}
                  onDayClick={handleDayClick}
                />
              </div>
              <div className="mt-3 flex items-center gap-2 text-[11.5px] text-slate-600">
                <span>Selected:</span>
                <span className="font-mono tabular-nums">
                  {formatShortDate(pending.startDate)} – {formatShortDate(pending.endDate)}
                </span>
                <span>· {spanLabel}</span>
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-700"
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CalendarMonth({
  monthDate,
  range,
  onDayClick,
}: {
  monthDate: Date;
  range: { startDate: string; endDate: string };
  onDayClick: (iso: string) => void;
}) {
  const first = startOfMonth(monthDate);
  const startOffset = first.getDay();
  const daysInMonth = endOfMonth(monthDate).getDate();
  const cells: Array<{ iso?: string; day?: number }> = [];
  for (let i = 0; i < startOffset; i += 1) cells.push({});
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = toIso(new Date(monthDate.getFullYear(), monthDate.getMonth(), day));
    cells.push({ iso, day });
  }
  return (
    <div>
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {DAY_HEADERS.map((label, idx) => (
          <span key={`${label}-${idx}`}>{label}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[11.5px]">
        {cells.map((cell, idx) => {
          if (!cell.iso || cell.day == null) {
            return <span key={idx} aria-hidden="true" />;
          }
          const inRange = cell.iso >= range.startDate && cell.iso <= range.endDate;
          const isStart = cell.iso === range.startDate;
          const isEnd = cell.iso === range.endDate;
          const isEdge = isStart || isEnd;
          const cellClasses = [
            "inline-flex h-7 w-9 items-center justify-center font-mono tabular-nums",
            isEdge
              ? "bg-indigo-600 text-white font-semibold"
              : inRange
                ? "bg-indigo-50 text-indigo-700"
                : "text-slate-700 hover:bg-slate-100",
            isStart ? "rounded-l-md" : "",
            isEnd ? "rounded-r-md" : "",
            !inRange ? "rounded-md" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={cell.iso}
              type="button"
              onClick={() => onDayClick(cell.iso!)}
              aria-pressed={isEdge}
              aria-label={cell.iso}
              className={cellClasses}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
