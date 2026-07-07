"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { useDropdownBehavior } from "@/hooks/use-dropdown-behavior";
import { cn } from "@/lib/utils";

export type PlatformOption = "meta" | "google" | "tiktok" | "pinterest" | "snapchat";

export interface CreativeFiltersState {
  groupBy: "adName" | "creative" | "adSet";
  selectedTags: string[];
  format: "all" | "image" | "video";
  sort: "roas" | "spend" | "ctrAll" | "purchaseValue";
  platform: PlatformOption;
}

type FilterSelectProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
};

interface CreativeTagActionsRowProps {
  rows: MetaCreativeRow[];
  value: CreativeFiltersState;
  onChange: (next: CreativeFiltersState) => void;
  tagDropdownId: string;
  filterDropdownId: string;
  actionSlot?: ReactNode;
}

const FILTER_SELECT_CLASSNAME =
  "h-8 rounded-lg border border-neutral-200 bg-white px-3 text-xs text-neutral-700 outline-none transition-colors hover:bg-neutral-50 focus-visible:border-neutral-400";

export const CREATIVE_PLATFORM_OPTIONS: Array<{ value: PlatformOption; label: string }> = [
  { value: "meta", label: "Meta" },
  { value: "google", label: "Google" },
  { value: "tiktok", label: "TikTok" },
  { value: "pinterest", label: "Pinterest" },
  { value: "snapchat", label: "Snapchat" },
];

export const CREATIVE_GROUP_BY_OPTIONS: Array<{
  value: CreativeFiltersState["groupBy"];
  label: string;
}> = [
  { value: "adName", label: "Group by Ad Name" },
  { value: "creative", label: "Group by Creative" },
  { value: "adSet", label: "Group by Ad Set" },
];

export const CREATIVE_FORMAT_OPTIONS: Array<{
  value: CreativeFiltersState["format"];
  label: string;
}> = [
  { value: "all", label: "All formats" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
];

export const CREATIVE_SORT_OPTIONS: Array<{
  value: CreativeFiltersState["sort"];
  label: string;
}> = [
  { value: "roas", label: "Sort by ROAS" },
  { value: "spend", label: "Sort by Spend" },
  { value: "ctrAll", label: "Sort by CTR" },
  { value: "purchaseValue", label: "Sort by Purchase value" },
];

export function CreativeFilterSelect<T extends string>({
  value,
  onChange,
  options,
  className,
}: FilterSelectProps<T>) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(FILTER_SELECT_CLASSNAME, className)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function CreativeTagActionsRow({
  rows,
  value,
  onChange,
  tagDropdownId,
  filterDropdownId,
  actionSlot,
}: CreativeTagActionsRowProps) {
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [showAddFilter, setShowAddFilter] = useState(false);

  const tagWrapRef = useRef<HTMLDivElement>(null);
  const tagTriggerRef = useRef<HTMLButtonElement>(null);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  useDropdownBehavior({
    id: tagDropdownId,
    open: showTagPicker,
    setOpen: setShowTagPicker,
    containerRef: tagWrapRef,
    triggerRef: tagTriggerRef,
  });

  useDropdownBehavior({
    id: filterDropdownId,
    open: showAddFilter,
    setOpen: setShowAddFilter,
    containerRef: filterWrapRef,
    triggerRef: filterTriggerRef,
  });

  const tagOptions = useMemo(() => {
    return Array.from(new Set(rows.flatMap((row) => row.tags || []))).sort((a, b) =>
      a.localeCompare(b)
    );
  }, [rows]);

  const selectedTagSet = useMemo(() => new Set(value.selectedTags), [value.selectedTags]);

  const toggleTag = (tag: string) => {
    const nextSelectedTags = selectedTagSet.has(tag)
      ? value.selectedTags.filter((item) => item !== tag)
      : [...value.selectedTags, tag];

    onChange({ ...value, selectedTags: nextSelectedTags });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={tagWrapRef} className="relative">
        <button
          ref={tagTriggerRef}
          type="button"
          onClick={() => setShowTagPicker((prev) => !prev)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          Tags {value.selectedTags.length > 0 ? `(${value.selectedTags.length})` : ""}
        </button>

        {showTagPicker && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-64 rounded-lg border border-neutral-200 bg-white p-3 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] duration-150">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Select tags</p>
              {value.selectedTags.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange({ ...value, selectedTags: [] })}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>

            {tagOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tags available.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-auto">
                {tagOptions.map((tag) => {
                  const checked = selectedTagSet.has(tag);
                  return (
                    <label
                      key={tag}
                      className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
                    >
                      <span className="truncate pr-3">{tag}</span>
                      <input type="checkbox" checked={checked} onChange={() => toggleTag(tag)} />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={filterWrapRef} className="relative">
        <button
          ref={filterTriggerRef}
          type="button"
          onClick={() => setShowAddFilter((prev) => !prev)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          + Add filter
        </button>

        {showAddFilter && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-56 rounded-lg border border-neutral-200 bg-white p-3 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] duration-150">
            <p className="text-xs text-muted-foreground">Advanced filter builder is coming soon.</p>
          </div>
        )}
      </div>

      {actionSlot}
    </div>
  );
}
