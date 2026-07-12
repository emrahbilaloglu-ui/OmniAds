"use client";

import {
  DateRangePicker as AdvancedDateRangePicker,
  dateWindowToRangeValue,
  rangeValueToDateWindow,
  type DateWindowKey,
  type DateWindowValue,
  type RangePreset,
} from "@/components/date-range/DateRangePicker";

export type DateRangePresetKey = DateWindowKey;

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

const PRESET_TO_RANGE: Record<DateRangePresetKey, RangePreset> = {
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

function toIso(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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
    const yesterday = addDays(today, -1);
    return { startDate: toIso(yesterday), endDate: toIso(yesterday) };
  }
  if (preset === "this_month") {
    return {
      startDate: toIso(new Date(today.getFullYear(), today.getMonth(), 1)),
      endDate: toIso(today),
    };
  }
  if (preset === "last_month") {
    return {
      startDate: toIso(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      endDate: toIso(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  }
  const days = preset === "90d" ? 90 : preset === "28d" ? 28 : preset === "14d" ? 14 : 7;
  return { startDate: toIso(addDays(today, -(days - 1))), endDate: toIso(today) };
}

function toWindowValue(value: DateRangeValue): DateWindowValue {
  return {
    window: value.preset,
    start: value.startDate,
    end: value.endDate,
  };
}

export function DateRangePicker({
  value,
  onChange,
  className,
  label = "Date range",
  testId = "date-range-picker",
}: DateRangePickerProps) {
  return (
    <AdvancedDateRangePicker
      value={dateWindowToRangeValue(toWindowValue(value))}
      onChange={(next) => {
        const resolved = rangeValueToDateWindow(next, undefined, {
          includeCurrentDay: true,
        });
        onChange({
          preset: resolved.window,
          startDate: resolved.start,
          endDate: resolved.end,
        });
      }}
      className={className}
      label={label}
      testId={testId}
      showComparisonTrigger={false}
      rangePresets={Object.values(PRESET_TO_RANGE)}
      referenceDate={value.endDate}
      includeCurrentDayInRollingRanges
    />
  );
}
