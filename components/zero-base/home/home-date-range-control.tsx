"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  DateRangePicker,
  getPresetDatesForReferenceDate,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";

export function HomeDateRangeControl({
  value,
  referenceDate,
  timeZone,
}: {
  value: DateRangeValue;
  referenceDate: string;
  timeZone: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selected, setSelected] = useState(value);

  useEffect(() => setSelected(value), [value]);

  function handleChange(next: DateRangeValue) {
    const resolved = getPresetDatesForReferenceDate(
      next.rangePreset,
      referenceDate,
      next.customStart,
      next.customEnd,
      { includeCurrentDay: true },
    );
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", next.rangePreset);
    params.set("startDate", resolved.start);
    params.set("endDate", resolved.end);
    setSelected({ ...next, customStart: resolved.start, customEnd: resolved.end });
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <DateRangePicker
      value={selected}
      onChange={handleChange}
      label="Date range"
      testId="home-date-range"
      referenceDate={referenceDate}
      timeZoneLabel={timeZone}
      includeCurrentDayInRollingRanges
      showComparisonTrigger={false}
      align="end"
    />
  );
}
