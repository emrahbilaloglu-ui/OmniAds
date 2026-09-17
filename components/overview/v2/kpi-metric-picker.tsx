"use client";

import { Plus, Search } from "lucide-react";
import { Popover } from "radix-ui";
import type { KeyboardEvent, ReactNode } from "react";
import { useId, useMemo, useRef, useState } from "react";
import type { OverviewMetricCatalogEntry } from "@/src/types/models";
import styles from "./kpi-band.module.css";

const SECTION_LABELS: Record<string, string> = {
  pins: "Overview",
  storeMetrics: "Shopify store",
  ltv: "Customer value",
  expenses: "Costs & profit",
  customMetrics: "Calculated metrics",
  webAnalytics: "Web analytics",
  "platform:meta": "Meta Ads",
  "platform:google": "Google Ads",
  "platform:google_ads": "Google Ads",
  unavailable: "Unavailable metrics",
};

export function kpiSectionLabel(section: string) {
  if (SECTION_LABELS[section]) return SECTION_LABELS[section];
  if (section.startsWith("platform:")) {
    const provider = section.slice("platform:".length).replaceAll("_", " ");
    return `${provider.replace(/\b\w/g, (letter) => letter.toUpperCase())} Ads`;
  }
  return section;
}

/** Accent- and case-insensitive, and safe for the Turkish dotted/dotless I. */
function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase();
}

/** Blended ROAS and MER read alike; their definitions travel with them. */
export function kpiEfficiencyDefinition(entry: OverviewMetricCatalogEntry) {
  return entry.metric.id === "pins-mer" || entry.metric.id === "pins-blended-roas"
    ? entry.metric.subtitle ?? null
    : null;
}

type PickerOption = {
  entry: OverviewMetricCatalogEntry;
  /** Why the option cannot be added right now; null when it can. */
  blockedReason: string | null;
};

/**
 * A searchable list of metrics that can be added to the KPI band.
 *
 * Adding only changes the caller's draft; nothing is saved here. Metrics that
 * are already on the band or have no data for this window stay listed with the
 * reason they cannot be added, so the catalog never looks like it lost them.
 */
export function KpiMetricPicker({
  catalog,
  selectedKeys,
  onAdd,
  children,
  align = "end",
}: {
  catalog: OverviewMetricCatalogEntry[];
  selectedKeys: readonly string[];
  onAdd: (entry: OverviewMetricCatalogEntry) => void;
  /** The trigger button. */
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // After an add the band moves focus to the new card; the trigger must not take it back.
  const addedRef = useRef(false);
  const titleId = useId();

  const groups = useMemo(() => {
    const normalizedQuery = normalizeSearch(query.trim());
    const grouped = new Map<string, PickerOption[]>();
    for (const entry of catalog) {
      if (normalizedQuery) {
        const haystack = normalizeSearch(
          `${entry.title} ${kpiSectionLabel(entry.section)} ${entry.metric.dataSource.label} ${entry.metric.subtitle ?? ""}`,
        );
        if (!haystack.includes(normalizedQuery)) continue;
      }
      const blockedReason = selectedKeys.includes(entry.key)
        ? "Already on the band"
        : entry.metric.status === "unavailable"
          ? entry.metric.helperText ?? "No data for this window"
          : null;
      const label = kpiSectionLabel(entry.section);
      grouped.set(label, [...(grouped.get(label) ?? []), { entry, blockedReason }]);
    }
    return Array.from(grouped.entries());
  }, [catalog, query, selectedKeys]);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-kpi-option]") ?? [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "ArrowDown"
        ? Math.min(options.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
    options[currentIndex < 0 ? 0 : nextIndex]?.focus();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.picker}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-labelledby={titleId}
          onKeyDown={moveFocus}
          onCloseAutoFocus={(event) => {
            if (!addedRef.current) return;
            addedRef.current = false;
            event.preventDefault();
          }}
        >
          <p id={titleId} className={styles.pickerTitle}>
            Add a KPI
          </p>
          <label className={styles.pickerSearch}>
            <Search aria-hidden="true" />
            <span className={styles.srOnly}>Search metrics</span>
            <input
              type="search"
              placeholder="Search metrics"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div ref={listRef} className={styles.pickerList}>
            {groups.map(([group, options]) => (
              <div key={group} role="group" aria-label={group} className={styles.pickerGroup}>
                <p className={styles.pickerGroupLabel} aria-hidden="true">
                  {group}
                </p>
                {options.map(({ entry, blockedReason }) => {
                  const definition = kpiEfficiencyDefinition(entry);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      data-kpi-option={entry.key}
                      className={styles.pickerOption}
                      aria-disabled={blockedReason ? true : undefined}
                      onClick={() => {
                        if (blockedReason) return;
                        addedRef.current = true;
                        onAdd(entry);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className={styles.pickerOptionCopy}>
                        <strong>{entry.title}</strong>
                        <small>
                          {blockedReason ?? `${entry.metric.dataSource.label}`}
                        </small>
                        {definition ? <small>{definition}</small> : null}
                      </span>
                      {blockedReason ? null : <Plus aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 ? (
              <p className={styles.pickerEmpty}>No metrics match “{query}”.</p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
