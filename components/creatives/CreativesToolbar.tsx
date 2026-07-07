"use client";

import { Download, Share2 } from "lucide-react";
import { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  CREATIVE_FORMAT_OPTIONS,
  CREATIVE_GROUP_BY_OPTIONS,
  CREATIVE_PLATFORM_OPTIONS,
  CREATIVE_SORT_OPTIONS,
  CreativeFilterSelect,
  CreativeTagActionsRow,
  type CreativeFiltersState,
} from "@/components/creatives/filter-bar-shared";
import {
  DateRangePicker,
  DateRangeValue,
} from "@/components/date-range/DateRangePicker";

interface CreativesToolbarProps {
  rows: MetaCreativeRow[];
  value: CreativeFiltersState;
  onChange: (next: CreativeFiltersState) => void;
  dateRangeValue: DateRangeValue;
  onDateRangeChange: (next: DateRangeValue) => void;
  onComingSoon: () => void;
  selectedCount: number;
  onShareSelected: () => void;
}

export function CreativesToolbar({
  rows,
  value,
  onChange,
  dateRangeValue,
  onDateRangeChange,
  onComingSoon,
  selectedCount,
  onShareSelected,
}: CreativesToolbarProps) {
  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={dateRangeValue} onChange={onDateRangeChange} />

        <CreativeFilterSelect
          value={value.platform}
          onChange={(next) => onChange({ ...value, platform: next })}
          options={CREATIVE_PLATFORM_OPTIONS}
        />

        <CreativeFilterSelect
          value={value.groupBy}
          onChange={(next) => onChange({ ...value, groupBy: next })}
          options={CREATIVE_GROUP_BY_OPTIONS}
        />

        <CreativeFilterSelect
          value={value.format}
          onChange={(next) => onChange({ ...value, format: next })}
          options={CREATIVE_FORMAT_OPTIONS}
        />

        <CreativeFilterSelect
          value={value.sort}
          onChange={(next) => onChange({ ...value, sort: next })}
          options={CREATIVE_SORT_OPTIONS}
        />

        {selectedCount > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Selected: <span className="font-medium text-foreground">{selectedCount}</span>
            </span>

            <button
              type="button"
              onClick={onShareSelected}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share ({selectedCount})
            </button>

            <button
              type="button"
              onClick={onComingSoon}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        )}
      </div>

      <CreativeTagActionsRow
        rows={rows}
        value={value}
        onChange={onChange}
        tagDropdownId="toolbar-tags"
        filterDropdownId="toolbar-add-filter"
        actionSlot={
          <button
            type="button"
            onClick={onComingSoon}
            className="ml-auto rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
          >
            Analyze this report
          </button>
        }
      />
    </div>
  );
}
