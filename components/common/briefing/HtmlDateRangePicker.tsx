"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type HtmlDateWindowKey = "today" | "yesterday" | "7d" | "14d" | "28d" | "90d" | "this_month" | "last_month" | "custom";

export interface HtmlDateRangeValue {
  window: HtmlDateWindowKey;
  start: string;
  end: string;
}

interface HtmlDateRangePickerProps {
  value: HtmlDateRangeValue;
  onApply: (value: HtmlDateRangeValue) => void;
}

const QUICK_OPTIONS: Array<{ key: HtmlDateWindowKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7d" },
  { key: "14d", label: "Last 14d" },
  { key: "28d", label: "Last 28d" },
  { key: "90d", label: "Last 90d" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom range" },
];

export function HtmlDateRangePicker({ value, onApply }: HtmlDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const label = windowLabel(value.window);
  const detail = value.start === value.end ? value.start : `${value.start} - ${value.end}`;
  const months = useMemo(() => {
    const end = parseIsoDate(draft.end) ?? new Date();
    return [addMonths(end, -1), end];
  }, [draft.end]);

  const applyQuick = (key: HtmlDateWindowKey) => {
    setDraft(rangeForWindow(key));
  };

  const selectDay = (iso: string) => {
    if (draft.window !== "custom" || draft.start !== draft.end) {
      setDraft({ window: "custom", start: iso, end: iso });
      return;
    }
    const [start, end] = iso < draft.start ? [iso, draft.start] : [draft.start, iso];
    setDraft({ window: "custom", start, end });
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="date-picker-wrap" ref={wrapRef}>
      <button type="button" className="date-chip" aria-expanded={open} aria-haspopup="dialog" onClick={() => { setDraft(value); setOpen((next) => !next); }}>
        <span className="ico">◷</span>
        <span>{label}</span>
        <span className="range">{detail}</span>
        <span className="chev">▾</span>
      </button>
      {open ? (
        <div className="cal-popover" role="dialog" aria-label="Select date range">
          <div className="quick-list">
            {QUICK_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`q ${draft.window === option.key ? "on" : ""} ${option.key === "custom" ? "cust" : ""}`}
                onClick={() => applyQuick(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="cal-grid">
            {months.map((month) => (
              <CalendarMonth key={`${month.getFullYear()}-${month.getMonth()}`} month={month} start={draft.start} end={draft.end} onSelectDay={selectDay} />
            ))}
          </div>
          <div className="cal-foot">
            <span>{draft.start} - {draft.end}</span>
            <span className="right-buttons">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn--primary" onClick={() => { onApply(draft); setOpen(false); }}>Apply</button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CalendarMonth({
  month,
  start,
  end,
  onSelectDay,
}: {
  month: Date;
  start: string;
  end: string;
  onSelectDay: (iso: string) => void;
}) {
  const days = calendarCells(month);
  const title = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="cal-month">
      <div className="cal-h"><span />{title}<span /></div>
      <div className="cal-grid-days">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`} className="dh">{day}</span>)}
        {days.map((day) => {
          const iso = toIso(day.date);
          const inRange = iso >= start && iso <= end;
          const edge = iso === start ? "start" : iso === end ? "end" : "";
          return (
            <button
              key={iso}
              type="button"
              className={`d ${day.inMonth ? "" : "dim"} ${inRange ? "in-range" : ""} ${edge}`}
              onClick={() => onSelectDay(iso)}
            >
              {day.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function rangeForWindow(window: HtmlDateWindowKey, base = new Date()): HtmlDateRangeValue {
  const today = stripTime(base);
  if (window === "today") return { window, start: toIso(today), end: toIso(today) };
  if (window === "yesterday") {
    const day = addDays(today, -1);
    return { window, start: toIso(day), end: toIso(day) };
  }
  if (window === "this_month") {
    return { window, start: toIso(new Date(today.getFullYear(), today.getMonth(), 1)), end: toIso(today) };
  }
  if (window === "last_month") {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { window, start: toIso(start), end: toIso(end) };
  }
  const days = window === "90d" ? 90 : window === "28d" ? 28 : window === "14d" ? 14 : 7;
  return { window, start: toIso(addDays(today, -(days - 1))), end: toIso(today) };
}

export function windowLabel(window: HtmlDateWindowKey) {
  return QUICK_OPTIONS.find((option) => option.key === window)?.label ?? "Custom range";
}

function calendarCells(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstDay = (first.getDay() + 6) % 7;
  const start = addDays(first, -firstDay);
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return { date, inMonth: date.getMonth() === month.getMonth() };
  });
}

function parseIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function stripTime(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(value: Date, months: number) {
  return new Date(value.getFullYear(), value.getMonth() + months, 1);
}

function toIso(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
