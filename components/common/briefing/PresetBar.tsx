"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, Settings2, Share2 } from "lucide-react";

export interface AssetLibraryPreset {
  key: string;
  label: string;
  description: string;
  metricsCount: number;
  metricChips: string[];
  unavailable?: boolean;
  unavailableReason?: string;
}

interface PresetBarProps {
  presets: AssetLibraryPreset[];
  activePresetKey: string;
  onPresetChange: (key: string) => void;
  dateChip: ReactNode;
  labelFilter: ReactNode;
  countLabel: string;
  selectedCount?: number;
  onCustomize?: () => void;
  onCompare?: () => void;
  onExport?: () => void;
  onShareView?: () => void;
  testId?: string;
}

export function PresetBar({
  presets,
  activePresetKey,
  onPresetChange,
  dateChip,
  labelFilter,
  countLabel,
  selectedCount = 0,
  onCustomize,
  onCompare,
  onExport,
  onShareView,
  testId = "preset-bar",
}: PresetBarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const activePreset =
    presets.find((preset) => preset.key === activePresetKey) ?? presets[0];

  useEffect(() => {
    if (!popoverOpen) return;
    function onMouseDown(event: MouseEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(event.target as Node)) return;
      setPopoverOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(16,21,28,0.04)]"
      data-testid={testId}
    >
      <div ref={popoverRef} className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={popoverOpen}
          onClick={() => setPopoverOpen((next) => !next)}
          data-testid={`${testId}-preset-trigger`}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-100"
        >
          <span>{activePreset?.label ?? "Preset"}</span>
          <span className="text-blue-500">· {activePreset?.metricsCount ?? 0} KPIs</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {popoverOpen ? (
          <div
            role="listbox"
            aria-label="Choose preset"
            className="absolute left-0 top-full z-40 mt-1.5 w-[320px] rounded-xl border border-neutral-200 bg-white p-2 shadow-2xl"
          >
            {presets.map((preset) => {
              const active = preset.key === activePresetKey;
              return (
                <button
                  key={preset.key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={preset.unavailable}
                  onClick={() => {
                    if (preset.unavailable) return;
                    onPresetChange(preset.key);
                    setPopoverOpen(false);
                  }}
                  className={
                    "block w-full rounded-md px-3 py-2 text-left text-[12px] " +
                    (preset.unavailable
                      ? "cursor-not-allowed text-neutral-400"
                      : active
                        ? "bg-blue-50 text-blue-700"
                        : "text-neutral-700 hover:bg-neutral-50")
                  }
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span>{preset.label}</span>
                    {preset.unavailable ? (
                      <span className="rounded bg-neutral-100 px-1.5 py-px font-mono text-[12px] text-neutral-500">
                        backend-dep
                      </span>
                    ) : (
                      <span className="text-[12px] font-mono text-neutral-500">
                        · {preset.metricsCount} KPIs
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px] text-neutral-500">
                    {preset.description}
                  </div>
                  {preset.metricChips.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {preset.metricChips.slice(0, 5).map((chip) => (
                        <span
                          key={chip}
                          className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[12px] text-neutral-600"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {preset.unavailable && preset.unavailableReason ? (
                    <div className="mt-1 text-[12px] text-amber-700">
                      {preset.unavailableReason}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {onCustomize ? (
        <button
          type="button"
          onClick={onCustomize}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50"
          data-testid={`${testId}-customize`}
        >
          <Settings2 size={12} aria-hidden="true" />
          KPIs
        </button>
      ) : null}

      <div data-preset-bar-date>{dateChip}</div>

      <div className="ml-1 flex items-center gap-1.5">{labelFilter}</div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] text-neutral-500">
          {countLabel}
          {selectedCount > 0 ? ` · ${selectedCount} sel` : null}
        </span>
        {onCompare ? (
          <button
            type="button"
            onClick={onCompare}
            disabled={selectedCount === 0}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Compare
          </button>
        ) : null}
        {onExport ? (
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50"
          >
            <Download size={12} aria-hidden="true" />
            CSV
          </button>
        ) : null}
        {onShareView ? (
          <button
            type="button"
            onClick={onShareView}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700"
            data-testid={`${testId}-share-view`}
          >
            <Share2 size={12} aria-hidden="true" />
            Share view…
          </button>
        ) : null}
      </div>
    </div>
  );
}
