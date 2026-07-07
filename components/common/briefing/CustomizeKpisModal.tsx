"use client";

import { useEffect, useMemo, useState } from "react";
import { GripVertical, X } from "lucide-react";

export interface KpiCatalogEntry {
  key: string;
  label: string;
  group: string;
  description: string;
  unavailable?: boolean;
  unavailableReason?: string;
}

interface CustomizeKpisModalProps {
  open: boolean;
  catalog: KpiCatalogEntry[];
  selectedKeys: string[];
  presetLabel?: string;
  onClose: () => void;
  onApply: (nextSelectedKeys: string[]) => void;
  onSaveAsNewPreset?: (name: string, nextSelectedKeys: string[]) => void;
  onUpdatePreset?: (nextSelectedKeys: string[]) => void;
  testId?: string;
}

export function CustomizeKpisModal({
  open,
  catalog,
  selectedKeys,
  presetLabel,
  onClose,
  onApply,
  onSaveAsNewPreset,
  onUpdatePreset,
  testId = "customize-kpis-modal",
}: CustomizeKpisModalProps) {
  const [draftKeys, setDraftKeys] = useState<string[]>(selectedKeys);
  const [activeKey, setActiveKey] = useState<string | null>(
    selectedKeys[0] ?? catalog[0]?.key ?? null,
  );
  const [newPresetName, setNewPresetName] = useState("");

  useEffect(() => {
    if (open) {
      setDraftKeys(selectedKeys);
      setActiveKey(selectedKeys[0] ?? catalog[0]?.key ?? null);
      setNewPresetName("");
    }
  }, [open, selectedKeys, catalog]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groupedCatalog = useMemo(() => {
    const groups = new Map<string, KpiCatalogEntry[]>();
    for (const entry of catalog) {
      const arr = groups.get(entry.group) ?? [];
      arr.push(entry);
      groups.set(entry.group, arr);
    }
    return Array.from(groups.entries());
  }, [catalog]);

  const activeEntry = useMemo(
    () => catalog.find((entry) => entry.key === activeKey) ?? null,
    [catalog, activeKey],
  );

  if (!open) return null;

  function toggle(key: string) {
    setDraftKeys((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key],
    );
    setActiveKey(key);
  }

  function move(key: string, direction: -1 | 1) {
    setDraftKeys((current) => {
      const index = current.indexOf(key);
      if (index === -1) return current;
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      copy.splice(index, 1);
      copy.splice(target, 0, key);
      return copy;
    });
  }

  function handleApply() {
    onApply(draftKeys);
    onClose();
  }

  function handleSaveAsNewPreset() {
    if (!onSaveAsNewPreset || !newPresetName.trim()) return;
    onSaveAsNewPreset(newPresetName.trim(), draftKeys);
    setNewPresetName("");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid={testId}>
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/40"
        aria-label="Close customize KPIs"
        onClick={onClose}
      />
      <div className="relative z-10 grid w-full max-w-[920px] grid-cols-1 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl md:grid-cols-[260px_1fr_260px]">
        <div className="col-span-full flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-[14px] font-bold tracking-tight text-neutral-900">
              Customize KPIs
            </h2>
            {presetLabel ? (
              <div className="text-[11.5px] text-neutral-500">
                preset · {presetLabel}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-50"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="border-r border-neutral-200 px-3 py-3">
          <div className="px-1 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
            Selected ({draftKeys.length})
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {draftKeys.map((key) => {
              const entry = catalog.find((item) => item.key === key);
              if (!entry) return null;
              return (
                <li
                  key={key}
                  className={
                    "flex items-center gap-1 rounded-md border px-2 py-1.5 text-[12px] " +
                    (activeKey === key
                      ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-neutral-200 bg-white text-neutral-700")
                  }
                >
                  <button
                    type="button"
                    aria-label={`Reorder ${entry.label}`}
                    className="cursor-grab text-neutral-400 hover:text-neutral-600"
                  >
                    <GripVertical size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveKey(key)}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    {entry.label}
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`Move ${entry.label} up`}
                      className="px-1 text-neutral-400 hover:text-neutral-700"
                      onClick={() => move(key, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${entry.label} down`}
                      className="px-1 text-neutral-400 hover:text-neutral-700"
                      onClick={() => move(key, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${entry.label}`}
                      className="px-1 text-neutral-400 hover:text-rose-600"
                      onClick={() => toggle(key)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
            {draftKeys.length === 0 ? (
              <li className="rounded-md border border-dashed border-neutral-200 px-2 py-3 text-center text-[11.5px] text-neutral-500">
                Pick KPIs from the catalog →
              </li>
            ) : null}
          </ul>
        </div>

        <div className="max-h-[480px] overflow-y-auto px-4 py-3">
          {groupedCatalog.map(([group, entries]) => (
            <section key={group} className="mb-4">
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
                {group}
              </h3>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {entries.map((entry) => {
                  const selected = draftKeys.includes(entry.key);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        if (entry.unavailable) return;
                        toggle(entry.key);
                      }}
                      disabled={entry.unavailable}
                      className={
                        "flex items-start gap-2 rounded-md border px-3 py-2 text-left text-[12px] " +
                        (entry.unavailable
                          ? "cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-400"
                          : selected
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")
                      }
                    >
                      <span
                        className={
                          "mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border " +
                          (selected
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-neutral-300 bg-white")
                        }
                        aria-hidden="true"
                      >
                        {selected ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{entry.label}</span>
                        {entry.unavailable ? (
                          <span className="mt-0.5 block text-[10.5px] text-amber-700">
                            {entry.unavailableReason ?? "Backend-dependent"}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="border-l border-neutral-200 bg-neutral-50/60 px-4 py-3">
          <div className="px-1 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
            About
          </div>
          {activeEntry ? (
            <>
              <div className="mt-1.5 text-[13px] font-semibold text-neutral-900">
                {activeEntry.label}
              </div>
              <div className="mt-1 text-[12px] leading-snug text-neutral-600">
                {activeEntry.description}
              </div>
              {activeEntry.unavailable ? (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                  {activeEntry.unavailableReason ?? "Requires backend support."}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-2 text-[11.5px] text-neutral-500">
              Click a KPI to see what it measures.
            </div>
          )}
        </div>

        <div className="col-span-full flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          {onSaveAsNewPreset ? (
            <span className="mr-auto flex items-center gap-1">
              <input
                type="text"
                placeholder="New preset name"
                value={newPresetName}
                onChange={(event) => setNewPresetName(event.currentTarget.value)}
                className="w-44 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleSaveAsNewPreset}
                disabled={!newPresetName.trim()}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save as new preset
              </button>
            </span>
          ) : null}
          {onUpdatePreset ? (
            <button
              type="button"
              onClick={() => onUpdatePreset(draftKeys)}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Update preset
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
