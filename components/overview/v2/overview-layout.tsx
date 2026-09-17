"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import styles from "./overview-layout.module.css";

export type OverviewLayoutSize = "compact" | "half" | "wide" | "full";

export type OverviewLayoutId =
  | "trend"
  | "economics"
  | "attribution"
  | "meta-morning"
  | "ai-brief"
  | "meta-platform"
  | "google-platform"
  | "store-value"
  | "web-analytics";

export type OverviewLayoutContent = {
  id: OverviewLayoutId;
  content: ReactNode;
  dataElement?: string;
};

type LayoutDefinition = {
  id: OverviewLayoutId;
  label: string;
  defaultSize: OverviewLayoutSize;
  allowedSizes: readonly OverviewLayoutSize[];
  positionLocked?: boolean;
};

export type LayoutEntry = {
  id: OverviewLayoutId;
  size: OverviewLayoutSize;
};

export type PackedLayoutEntry = LayoutEntry & {
  span: number;
};

const LAYOUT_VERSION = 1;
export const OVERVIEW_LAYOUT_STORAGE_PREFIX = "adsecute:overview-layout:v1:";

const LAYOUT_DEFINITIONS: readonly LayoutDefinition[] = [
  {
    id: "trend",
    label: "Spend & ROAS",
    defaultSize: "wide",
    allowedSizes: ["half", "wide", "full"],
  },
  {
    id: "economics",
    label: "Economics context",
    defaultSize: "full",
    allowedSizes: ["half", "wide", "full"],
  },
  {
    id: "meta-morning",
    label: "Meta this morning",
    defaultSize: "half",
    allowedSizes: ["compact", "half", "full"],
  },
  {
    id: "ai-brief",
    label: "AI daily brief",
    defaultSize: "half",
    allowedSizes: ["compact", "half", "full"],
  },
  {
    id: "attribution",
    label: "Attribution by channel",
    defaultSize: "full",
    allowedSizes: ["wide", "full"],
  },
  {
    id: "meta-platform",
    label: "Meta Ads dashboard",
    defaultSize: "full",
    allowedSizes: ["full"],
  },
  {
    id: "google-platform",
    label: "Google Ads dashboard",
    defaultSize: "full",
    allowedSizes: ["full"],
  },
  {
    id: "store-value",
    label: "Store & customer value",
    defaultSize: "half",
    allowedSizes: ["half", "full"],
  },
  {
    id: "web-analytics",
    label: "Web analytics",
    defaultSize: "half",
    allowedSizes: ["half", "full"],
  },
] as const;

const DEFINITION_BY_ID = new Map(LAYOUT_DEFINITIONS.map((definition) => [definition.id, definition]));

const SIZE_LABELS: Record<OverviewLayoutSize, string> = {
  compact: "One third",
  half: "Half",
  wide: "Two thirds",
  full: "Full width",
};

const SIZE_SPANS: Record<OverviewLayoutSize, number> = {
  compact: 4,
  half: 6,
  wide: 8,
  full: 12,
};

export function defaultOverviewLayout(): LayoutEntry[] {
  return LAYOUT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    size: definition.defaultSize,
  }));
}

export function sameOverviewLayout(left: readonly LayoutEntry[], right: readonly LayoutEntry[]) {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.id === right[index]?.id && entry.size === right[index]?.size)
  );
}

function insertMissingDefinitions(entries: LayoutEntry[]) {
  const reconciled = [...entries];
  const present = new Set(reconciled.map((entry) => entry.id));

  for (let defaultIndex = 0; defaultIndex < LAYOUT_DEFINITIONS.length; defaultIndex += 1) {
    const definition = LAYOUT_DEFINITIONS[defaultIndex]!;
    if (present.has(definition.id)) continue;

    const nextKnownIndex = reconciled.findIndex((entry) => {
      const entryDefaultIndex = LAYOUT_DEFINITIONS.findIndex((candidate) => candidate.id === entry.id);
      return entryDefaultIndex > defaultIndex;
    });
    const missing = { id: definition.id, size: definition.defaultSize };
    if (nextKnownIndex < 0) reconciled.push(missing);
    else reconciled.splice(nextKnownIndex, 0, missing);
    present.add(definition.id);
  }

  return reconciled;
}

/** Accept only the small, versioned layout vocabulary this surface owns. */
export function parseOverviewLayout(value: string | null): LayoutEntry[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      entries?: Array<{ id?: unknown; size?: unknown }>;
    };
    if (parsed.version !== LAYOUT_VERSION || !Array.isArray(parsed.entries)) return null;

    const seen = new Set<OverviewLayoutId>();
    const entries: LayoutEntry[] = [];
    for (const candidate of parsed.entries) {
      if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") continue;
      if (!DEFINITION_BY_ID.has(candidate.id as OverviewLayoutId)) continue;
      const id = candidate.id as OverviewLayoutId;
      const definition = DEFINITION_BY_ID.get(id)!;
      if (seen.has(id)) continue;
      const size =
        typeof candidate.size === "string" && definition.allowedSizes.includes(candidate.size as OverviewLayoutSize)
          ? (candidate.size as OverviewLayoutSize)
          : definition.defaultSize;
      seen.add(id);
      entries.push({ id, size });
    }

    return insertMissingDefinitions(entries);
  } catch {
    return null;
  }
}

/**
 * Preserve DOM order while closing every visual row. When the next requested
 * size cannot fit, the previous card temporarily fills the remaining tracks.
 */
export function packOverviewLayout(entries: readonly LayoutEntry[]): PackedLayoutEntry[] {
  const packed: PackedLayoutEntry[] = [];
  let used = 0;

  const closeRow = () => {
    if (used <= 0 || packed.length === 0) return;
    packed[packed.length - 1]!.span += 12 - used;
    used = 0;
  };

  for (const entry of entries) {
    const span = SIZE_SPANS[entry.size];
    if (used > 0 && used + span > 12) closeRow();
    packed.push({ ...entry, span });
    used += span;
    if (used === 12) used = 0;
  }

  closeRow();
  return packed;
}


function storageKeyFor(businessId: string) {
  return `${OVERVIEW_LAYOUT_STORAGE_PREFIX}${businessId || "unscoped"}`;
}

function serializeLayout(entries: readonly LayoutEntry[]) {
  return JSON.stringify({ version: LAYOUT_VERSION, entries });
}

/**
 * The saved section layout for one business, read from this browser.
 *
 * Saving the default layout removes the stored entry, so later default changes
 * reach this business too.
 */
export function useOverviewLayoutPreference(businessId: string) {
  const storageKey = storageKeyFor(businessId);
  const [saved, setSaved] = useState<{ storageKey: string; layout: LayoutEntry[] }>(() => ({
    storageKey,
    layout: defaultOverviewLayout(),
  }));

  useLayoutEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Storage is a convenience. The deterministic default remains usable.
    }
    setSaved({ storageKey, layout: parseOverviewLayout(stored) ?? defaultOverviewLayout() });
  }, [storageKey]);

  const layout = saved.storageKey === storageKey ? saved.layout : defaultOverviewLayout();

  const saveLayout = useCallback(
    (next: LayoutEntry[]) => {
      setSaved({ storageKey, layout: next });
      try {
        if (sameOverviewLayout(next, defaultOverviewLayout())) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, serializeLayout(next));
      } catch {
        // The layout still applies for this session without storage.
      }
    },
    [storageKey],
  );

  return { layout, saveLayout };
}

/**
 * Overview sections on a 12-track grid.
 *
 * Controlled: while `editing`, moves, width changes and a restore go to
 * `onLayoutChange` as a draft. Nothing is stored here; the page saves or
 * discards the draft as a whole.
 */
export function OverviewLayout({
  layout,
  editing,
  items,
  onLayoutChange,
}: {
  layout: readonly LayoutEntry[];
  editing: boolean;
  items: readonly OverviewLayoutContent[];
  onLayoutChange: (next: LayoutEntry[]) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ id: OverviewLayoutId; direction: -1 | 1 } | null>(null);
  const contentById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const atDefault = sameOverviewLayout(layout, defaultOverviewLayout());

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const control = rootRef.current?.querySelector<HTMLButtonElement>(
      `[data-layout-id="${pending.id}"] [data-move-direction="${pending.direction}"]`,
    );
    control?.focus({ preventScroll: true });
    control?.scrollIntoView?.({ block: "nearest" });
  }, [layout]);

  const move = (id: OverviewLayoutId, direction: -1 | 1) => {
    const currentIndex = layout.findIndex((entry) => entry.id === id);
    const definition = DEFINITION_BY_ID.get(id);
    if (currentIndex < 0 || !definition || definition.positionLocked) return;

    const visibleMovableIds = layout
      .filter((entry) => contentById.has(entry.id) && !DEFINITION_BY_ID.get(entry.id)?.positionLocked)
      .map((entry) => entry.id);
    const visibleIndex = visibleMovableIds.indexOf(id);
    const neighbourId = visibleMovableIds[visibleIndex + direction];
    if (!neighbourId) {
      setAnnouncement(`${definition.label} is already ${direction < 0 ? "first" : "last"}.`);
      return;
    }
    const neighbourIndex = layout.findIndex((entry) => entry.id === neighbourId);
    if (neighbourIndex < 0) return;

    const next = [...layout];
    [next[currentIndex], next[neighbourIndex]] = [next[neighbourIndex]!, next[currentIndex]!];
    pendingFocus.current = { id, direction };
    onLayoutChange(next);
    setAnnouncement(`${definition.label} moved ${direction < 0 ? "earlier" : "later"}.`);
  };

  const resize = (id: OverviewLayoutId, size: OverviewLayoutSize) => {
    const definition = DEFINITION_BY_ID.get(id);
    if (!definition?.allowedSizes.includes(size)) return;
    onLayoutChange(layout.map((entry) => (entry.id === id ? { ...entry, size } : entry)));
    setAnnouncement(`${definition.label} width set to ${SIZE_LABELS[size].toLowerCase()}.`);
  };

  const restoreDefault = () => {
    if (atDefault) return;
    onLayoutChange(defaultOverviewLayout());
    setAnnouncement("Default section layout restored. Save to keep it.");
  };

  const visibleEntries = layout.filter((entry) => contentById.has(entry.id));
  const packedEntries = packOverviewLayout(visibleEntries);
  const movableIds = visibleEntries
    .filter((entry) => !DEFINITION_BY_ID.get(entry.id)?.positionLocked)
    .map((entry) => entry.id);

  return (
    <div ref={rootRef}>
      {editing ? (
        <div className={styles.editorBar} role="region" aria-label="Section layout">
          <div>
            <strong>Sections</strong>
            <span> Move sections and set their width.</span>
          </div>
          <button
            type="button"
            className="adv-btn adv-btn--sm"
            aria-disabled={atDefault || undefined}
            onClick={restoreDefault}
          >
            Restore default layout
          </button>
        </div>
      ) : null}

      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>

      <div className={styles.layoutGrid} data-overview-layout={editing ? "editing" : "ready"}>
        {packedEntries.map((entry) => {
          const item = contentById.get(entry.id)!;
          const definition = DEFINITION_BY_ID.get(entry.id)!;
          const movableIndex = movableIds.indexOf(entry.id);
          const canMoveEarlier = !definition.positionLocked && movableIndex > 0;
          const canMoveLater = !definition.positionLocked && movableIndex >= 0 && movableIndex < movableIds.length - 1;
          const fillsRow = entry.span !== SIZE_SPANS[entry.size];
          const itemStyle = { "--overview-layout-span": entry.span } as CSSProperties;

          return (
            <section
              key={entry.id}
              className={`${styles.layoutItem}${editing ? ` ${styles.layoutItemEditing}` : ""}`}
              data-layout-id={entry.id}
              data-layout-size={entry.size}
              data-layout-effective-span={entry.span}
              data-overview-section={entry.id}
              data-el={item.dataElement}
              style={itemStyle}
            >
              {editing ? (
                <div
                  className={styles.itemToolbar}
                  role="group"
                  aria-label={`${definition.label} layout controls`}
                >
                  <strong>{definition.label}</strong>
                  <span className={styles.toolbarActions}>
                    {!definition.positionLocked ? (
                      <>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Move ${definition.label} earlier`}
                          aria-disabled={!canMoveEarlier}
                          data-move-direction="-1"
                          onClick={() => move(entry.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className={styles.iconButton}
                          aria-label={`Move ${definition.label} later`}
                          aria-disabled={!canMoveLater}
                          data-move-direction="1"
                          onClick={() => move(entry.id, 1)}
                        >
                          ↓
                        </button>
                      </>
                    ) : (
                      <span className={styles.pinnedLabel}>Pinned first</span>
                    )}
                    {definition.allowedSizes.length > 1 ? (
                      <>
                        <select
                          className={styles.sizeSelect}
                          aria-label={`${definition.label} width`}
                          value={entry.size}
                          onChange={(event) => resize(entry.id, event.target.value as OverviewLayoutSize)}
                        >
                          {definition.allowedSizes.map((size) => (
                            <option key={size} value={size}>
                              {SIZE_LABELS[size]}
                            </option>
                          ))}
                        </select>
                        <span className={styles.widthHint}>Widths apply on wider screens</span>
                      </>
                    ) : (
                      <span className={styles.fixedWidthLabel}>{SIZE_LABELS[definition.allowedSizes[0]!]}</span>
                    )}
                    {fillsRow ? <span className={styles.fillLabel}>Fills row</span> : null}
                  </span>
                </div>
              ) : null}
              {item.content}
            </section>
          );
        })}
      </div>
    </div>
  );
}
