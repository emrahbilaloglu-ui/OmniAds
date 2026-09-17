"use client";

import { ArrowLeft, ArrowRight, GripVertical, Plus, RotateCcw, X } from "lucide-react";
import type { CSSProperties, DragEvent } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { unavailableCatalogEntry } from "@/lib/overview-metric-catalog";
import type { OverviewMetricCatalogEntry } from "@/src/types/models";
import {
  KPI_CARDS_PER_ROW,
  addMetricKey,
  kpiRowSpans,
  moveMetricKeyTo,
  removeMetricKey,
  sameMetricKeyOrder,
  uniqueMetricKeys,
} from "./kpi-grid";
import { KpiMetricPicker } from "./kpi-metric-picker";
import { HeroMetricCard, HeroTile } from "./metric-band";
import styles from "./kpi-band.module.css";

const SKELETON_COUNT = 4;

type CardControl = "earlier" | "later" | "remove";
type PendingFocus = { key: string; control: CardControl } | { addTile: true };

/**
 * Per-tier spans for one grid item. Customize mode drops the two-up phone tier
 * to one card per row so every card keeps full-size move and remove targets.
 */
function spanStyle(index: number, count: number, editing: boolean): CSSProperties {
  return {
    "--kpi-span-wide": kpiRowSpans(count, KPI_CARDS_PER_ROW.wide)[index],
    "--kpi-span-medium": kpiRowSpans(count, KPI_CARDS_PER_ROW.medium)[index],
    "--kpi-span-small": kpiRowSpans(count, editing ? KPI_CARDS_PER_ROW.narrow : KPI_CARDS_PER_ROW.small)[index],
    "--kpi-span-narrow": kpiRowSpans(count, KPI_CARDS_PER_ROW.narrow)[index],
  } as CSSProperties;
}

/**
 * The Overview headline KPIs.
 *
 * Reading mode shows equal cards on a predictable grid. The page's Customize
 * session turns on editing, where each card has exactly one control per
 * action — move earlier, move later, remove — plus drag as a pointer
 * shortcut for the same move, and the grid ends in the single Add metric tile.
 * Every change goes to the caller's draft through `onKeysChange`; this
 * component never persists anything, so Cancel on the page discards it all.
 */
export function CustomizableKpiBand({
  catalog,
  keys,
  defaultKeys,
  currencySymbol,
  loading = false,
  editing = false,
  onKeysChange,
  onRestoreDefaults,
}: {
  catalog: OverviewMetricCatalogEntry[];
  /** The saved keys while reading; the draft while customizing. */
  keys: readonly string[];
  defaultKeys: readonly string[];
  currencySymbol: string;
  loading?: boolean;
  editing?: boolean;
  onKeysChange: (keys: string[]) => void;
  /** Defaults to `onKeysChange(defaultKeys)`. */
  onRestoreDefaults?: () => void;
}) {
  const bandRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const orderedKeys = useMemo(() => uniqueMetricKeys(keys), [keys]);
  const catalogByKey = useMemo(() => new Map(catalog.map((entry) => [entry.key, entry])), [catalog]);
  const entries = useMemo(
    () => orderedKeys.map((key) => catalogByKey.get(key) ?? unavailableCatalogEntry(key)),
    [catalogByKey, orderedKeys],
  );
  // Reading mode keeps the loading skeleton. Customize mode can still expose
  // the honest unavailable catalog so layout work is not blocked by a slow
  // data read; the draft hook already protects against refetch changes.
  const showSkeleton = loading && !editing;
  const skeletonCount = Math.max(SKELETON_COUNT, orderedKeys.length);
  const atDefaults = sameMetricKeyOrder(orderedKeys, uniqueMetricKeys(defaultKeys));
  // While customizing, the add tile takes a grid slot and joins the row balance.
  const gridCount = entries.length + (editing ? 1 : 0);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    const band = bandRef.current;
    if (!pending || !band) return;
    pendingFocus.current = null;
    let target: HTMLElement | null | undefined;
    if ("addTile" in pending) {
      target = band.querySelector<HTMLElement>("[data-kpi-add-tile]");
    } else {
      const item = Array.from(band.querySelectorAll<HTMLElement>("[data-kpi-key]")).find(
        (node) => node.dataset.kpiKey === pending.key,
      );
      target = item?.querySelector<HTMLElement>(`[data-kpi-control="${pending.control}"]`);
    }
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
  });

  const titleOf = (key: string) => (catalogByKey.get(key) ?? unavailableCatalogEntry(key)).title;

  const move = (key: string, toIndex: number, control: CardControl | null) => {
    const fromIndex = orderedKeys.indexOf(key);
    if (fromIndex < 0) return;
    const target = Math.max(0, Math.min(orderedKeys.length - 1, toIndex));
    if (target === fromIndex) {
      if (control) setAnnouncement(`${titleOf(key)} is already ${fromIndex === 0 ? "first" : "last"}.`);
      return;
    }
    if (control) pendingFocus.current = { key, control };
    onKeysChange(moveMetricKeyTo(orderedKeys, key, target));
    setAnnouncement(`${titleOf(key)} moved to position ${target + 1} of ${orderedKeys.length}.`);
  };

  const remove = (key: string) => {
    const index = orderedKeys.indexOf(key);
    const next = removeMetricKey(orderedKeys, key);
    const neighbour = next[Math.min(index, next.length - 1)];
    pendingFocus.current = neighbour ? { key: neighbour, control: "remove" } : { addTile: true };
    onKeysChange(next);
    setAnnouncement(`${titleOf(key)} removed. ${next.length} KPI${next.length === 1 ? "" : "s"} left.`);
  };

  const add = (entry: OverviewMetricCatalogEntry) => {
    const next = addMetricKey(orderedKeys, entry.key);
    // A new card lands last, so its useful next move is earlier.
    pendingFocus.current = { key: entry.key, control: "earlier" };
    onKeysChange(next);
    setAnnouncement(`${entry.title} added at position ${next.length}.`);
  };

  const restoreDefaults = () => {
    if (atDefaults) return;
    if (onRestoreDefaults) onRestoreDefaults();
    else onKeysChange(uniqueMetricKeys(defaultKeys));
    setAnnouncement("Default KPIs restored. Save to keep them.");
  };

  const onDragStart = (event: DragEvent<HTMLElement>, key: string) => {
    setDraggingKey(key);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };

  const onDragOver = (event: DragEvent<HTMLElement>, index: number) => {
    if (!draggingKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropIndex !== index) setDropIndex(index);
  };

  const finishDrag = () => {
    setDraggingKey(null);
    setDropIndex(null);
  };

  const onDrop = (event: DragEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    const key = draggingKey ?? event.dataTransfer.getData("text/plain");
    finishDrag();
    if (key && orderedKeys.includes(key)) move(key, index, null);
  };

  const countLabel = showSkeleton
    ? "Loading"
    : `${entries.length} ${entries.length === 1 ? "metric" : "metrics"}`;

  return (
    <section
      data-overview-section="headline"
      data-kpi-mode={editing ? "customize" : "read"}
      className={styles.shell}
      aria-labelledby="overview-kpis-heading"
    >
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <h2 id="overview-kpis-heading">KPIs</h2>
          <span>{countLabel}</span>
        </div>
        {editing ? (
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.textButton}
              aria-disabled={atDefaults || undefined}
              onClick={restoreDefaults}
            >
              <RotateCcw aria-hidden="true" />
              Restore defaults
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <p className={styles.editHint}>Drag a card or use its arrow buttons to reorder.</p>
      ) : null}

      <div
        ref={bandRef}
        data-el="home-kpis"
        className={styles.band}
        aria-busy={showSkeleton || undefined}
        role={editing ? "list" : undefined}
        aria-label={editing ? "KPI order" : undefined}
      >
        {showSkeleton
          ? Array.from({ length: skeletonCount }, (_, index) => (
              <div
                key={`skeleton-${index}`}
                className={`${styles.item} ${styles.skeleton}`}
                style={spanStyle(index, skeletonCount, false)}
                aria-hidden="true"
              />
            ))
          : entries.map((entry, index) => (
              <div
                key={entry.key}
                role={editing ? "listitem" : undefined}
                className={styles.item}
                data-kpi-key={entry.key}
                data-overview-kpi-slot={index === 0 ? "primary" : "supporting"}
                data-editing={editing || undefined}
                data-dragging={(editing && draggingKey === entry.key) || undefined}
                data-drop-target={(editing && dropIndex === index && draggingKey !== entry.key) || undefined}
                style={spanStyle(index, gridCount, editing)}
                draggable={editing || undefined}
                onDragStart={editing ? (event) => onDragStart(event, entry.key) : undefined}
                onDragOver={editing ? (event) => onDragOver(event, index) : undefined}
                onDrop={editing ? (event) => onDrop(event, index) : undefined}
                onDragEnd={editing ? finishDrag : undefined}
              >
                {editing ? (
                  <div className={styles.controls} role="group" aria-label={`${entry.title}, position ${index + 1} of ${entries.length}`}>
                    {/* Drag affordance only; the buttons beside it are the keyboard path. */}
                    <span className={styles.handle} aria-hidden="true">
                      <GripVertical />
                      {index + 1}
                    </span>
                    <span className={styles.controlGroup}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        data-kpi-control="earlier"
                        aria-label={`Move ${entry.title} earlier`}
                        aria-disabled={index === 0 || undefined}
                        onClick={() => move(entry.key, index - 1, "earlier")}
                      >
                        <ArrowLeft aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconButton}
                        data-kpi-control="later"
                        aria-label={`Move ${entry.title} later`}
                        aria-disabled={index === entries.length - 1 || undefined}
                        onClick={() => move(entry.key, index + 1, "later")}
                      >
                        <ArrowRight aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconButton} ${styles.removeButton}`}
                        data-kpi-control="remove"
                        aria-label={`Remove ${entry.title}`}
                        onClick={() => remove(entry.key)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                ) : null}
                {index === 0 ? (
                  <HeroMetricCard metric={entry.metric} currencySymbol={currencySymbol} />
                ) : (
                  <HeroTile metric={entry.metric} currencySymbol={currencySymbol} index={index - 1} />
                )}
              </div>
            ))}

        {!showSkeleton && editing ? (
          <div
            role="listitem"
            className={`${styles.item} ${styles.addItem}`}
            data-kpi-add-item=""
            style={spanStyle(entries.length, gridCount, editing)}
            onDragOver={(event) => onDragOver(event, entries.length - 1)}
            onDrop={(event) => onDrop(event, entries.length - 1)}
          >
            <KpiMetricPicker catalog={catalog} selectedKeys={orderedKeys} onAdd={add} align="start">
              <button type="button" className={styles.addTile} data-kpi-add-tile="">
                <Plus aria-hidden="true" />
                <span>Add metric</span>
              </button>
            </KpiMetricPicker>
          </div>
        ) : null}

        {!showSkeleton && !editing && entries.length === 0 ? (
          <div className={styles.empty}>
            <strong>No headline KPIs selected</strong>
            <span>Use Customize above to choose metrics.</span>
          </div>
        ) : null}
      </div>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
