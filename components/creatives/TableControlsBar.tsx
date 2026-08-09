"use client";

import { useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  METRIC_CONFIG,
  METRIC_OPTIONS,
  MetaMetricKey,
} from "@/components/creatives/metricConfig";
import { useDropdownBehavior } from "@/hooks/use-dropdown-behavior";
import { cn } from "@/lib/utils";

interface TableViewState {
  selectedMetrics: MetaMetricKey[];
  density: "compact" | "comfortable";
  heatmapIntensity: "low" | "medium" | "high";
}

interface TableControlsBarProps {
  value: TableViewState;
  onChange: (next: TableViewState) => void;
}

type SelectFieldProps<T extends string> = {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
};

const SELECT_CLASSNAME =
  "mt-1 h-8 w-full rounded border bg-background px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function TableControlsBar({ value, onChange }: TableControlsBarProps) {
  const [showMetrics, setShowMetrics] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const metricsWrapRef = useRef<HTMLDivElement>(null);
  const metricsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsWrapRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  useDropdownBehavior({
    id: "legacy-table-metrics",
    open: showMetrics,
    setOpen: setShowMetrics,
    containerRef: metricsWrapRef,
    triggerRef: metricsTriggerRef,
  });

  useDropdownBehavior({
    id: "legacy-table-settings",
    open: showSettings,
    setOpen: setShowSettings,
    containerRef: settingsWrapRef,
    triggerRef: settingsTriggerRef,
  });

  const selectedMetricSet = useMemo(() => new Set(value.selectedMetrics), [value.selectedMetrics]);

  const toggleMetric = (metric: MetaMetricKey) => {
    const exists = selectedMetricSet.has(metric);
    if (exists && value.selectedMetrics.length === 1) return;

    const selectedMetrics = exists
      ? value.selectedMetrics.filter((item) => item !== metric)
      : [...value.selectedMetrics, metric];

    onChange({ ...value, selectedMetrics });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2">
      <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1">
        <span className="text-xs">All tags</span>
        <Badge className="h-5 rounded-full px-2 text-[12px]">New</Badge>
      </div>

      {value.selectedMetrics.map((metric) => (
        <div key={metric} className="rounded-full border bg-muted/25 px-3 py-1 text-xs">
          {METRIC_CONFIG[metric].label}
        </div>
      ))}

      <div ref={metricsWrapRef} className="relative">
        <button
          ref={metricsTriggerRef}
          type="button"
          onClick={() => setShowMetrics((prev) => !prev)}
          className="rounded-full border px-3 py-1.5 text-xs"
        >
          + Add metric
        </button>

        {showMetrics && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-64 rounded-lg border bg-background p-3 shadow-md duration-150">
            <p className="mb-2 text-xs text-muted-foreground">Metrics</p>
            <div className="max-h-64 space-y-1 overflow-auto">
              {METRIC_OPTIONS.map((metric) => {
                const checked = selectedMetricSet.has(metric);
                return (
                  <label
                    key={metric}
                    className="flex cursor-pointer items-center justify-between rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/40"
                  >
                    <span>{METRIC_CONFIG[metric].label}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMetric(metric)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div ref={settingsWrapRef} className="relative ml-auto">
        <button
          ref={settingsTriggerRef}
          type="button"
          onClick={() => setShowSettings((prev) => !prev)}
          className="rounded-md border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Table settings"
        >
          <Settings2 className="h-4 w-4" />
        </button>

        {showSettings && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 absolute right-0 top-9 z-50 w-56 rounded-lg border bg-background p-3 shadow-md duration-150">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Table settings</p>

            <div className="space-y-2">
              <SelectField
                label="Density"
                value={value.density}
                onChange={(next) => onChange({ ...value, density: next })}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "comfortable", label: "Comfortable" },
                ]}
              />

              <SelectField
                label="Heatmap intensity"
                value={value.heatmapIntensity}
                onChange={(next) => onChange({ ...value, heatmapIntensity: next })}
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: SelectFieldProps<T>) {
  return (
    <label className="block text-xs">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className={cn(SELECT_CLASSNAME)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export type { TableViewState };
