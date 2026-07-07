"use client";

import { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  CREATIVE_FORMAT_OPTIONS,
  CREATIVE_GROUP_BY_OPTIONS,
  CREATIVE_PLATFORM_OPTIONS,
  CREATIVE_SORT_OPTIONS,
  CreativeFilterSelect,
  CreativeTagActionsRow,
  type CreativeFiltersState,
  type PlatformOption,
} from "@/components/creatives/filter-bar-shared";

interface CreativeFiltersBarProps {
  rows: MetaCreativeRow[];
  value: CreativeFiltersState;
  onChange: (next: CreativeFiltersState) => void;
  onComingSoon: () => void;
}

export function CreativeFiltersBar({
  rows,
  value,
  onChange,
  onComingSoon,
}: CreativeFiltersBarProps) {
  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <CreativeTagActionsRow
        rows={rows}
        value={value}
        onChange={onChange}
        tagDropdownId="legacy-creative-tags"
        filterDropdownId="legacy-creative-add-filter"
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
export type { CreativeFiltersState, PlatformOption };
