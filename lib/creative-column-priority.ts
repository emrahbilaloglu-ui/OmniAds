/**
 * Column priority for the creative table on narrow viewports.
 *
 * The table lays itself out from the sum of its column widths, which at a
 * typical column set is roughly a thousand pixels. On a phone that becomes a
 * horizontal scroller: the creative name is visible, and spend and ROAS — the
 * numbers the buyer opened the table for — sit off-screen behind a scroll
 * affordance most people never find.
 *
 * Rather than shrinking a desktop table, this decides which columns earn the
 * space available. Identity always stays. Then the economic columns, in the
 * order a buyer reads them. Everything else is dropped and reported as dropped,
 * so a narrow screen shows fewer columns rather than a wrong impression of the
 * account.
 */

export interface PrioritizableColumn {
  key: string;
  /** Width this column wants when shown. */
  preferredWidth: number;
  minWidth?: number;
}

/**
 * The economic columns, most important first.
 *
 * Spend leads because exposure is what makes any other number worth reading;
 * ROAS and purchases answer whether that exposure worked.
 */
export const TIER_0_METRIC_PRIORITY = [
  "spend",
  "roas",
  "purchases",
  "cpa",
  "purchaseValue",
] as const;

export interface ColumnPriorityResult {
  /** Column keys to render, in order, identity first. */
  visibleKeys: string[];
  /** Keys withheld because they did not fit. */
  droppedKeys: string[];
  /** Total width of the visible set. */
  totalWidth: number;
  /** True when the visible set fits without horizontal scrolling. */
  fits: boolean;
}

/**
 * Choose the columns that fit a viewport.
 *
 * The identity column is never dropped — a row without a name is not a row.
 * When even identity plus one metric cannot fit, identity alone is returned and
 * the caller is told nothing else fitted, rather than being handed a set that
 * silently overflows.
 */
export function resolveCreativeColumnPriority(input: {
  viewportWidth: number;
  identityWidth: number;
  columns: PrioritizableColumn[];
  /** Space taken by padding, checkbox, and any sticky affordance. */
  chromeWidth?: number;
  priority?: readonly string[];
}): ColumnPriorityResult {
  const chromeWidth = input.chromeWidth ?? 0;
  const available = input.viewportWidth - chromeWidth;
  const byKey = new Map(input.columns.map((column) => [column.key, column]));
  const priority = input.priority ?? TIER_0_METRIC_PRIORITY;

  const visibleKeys: string[] = ["creativeName"];
  let totalWidth = input.identityWidth;

  const widthOf = (column: PrioritizableColumn) =>
    Math.max(column.minWidth ?? column.preferredWidth, 0) || column.preferredWidth;

  // Priority order first, then whatever else still fits, so a caller's custom
  // column choice is honored once the economics are covered.
  const ordered = [
    ...priority.filter((key) => byKey.has(key)),
    ...input.columns.map((column) => column.key).filter((key) => !priority.includes(key)),
  ];

  for (const key of ordered) {
    const column = byKey.get(key);
    if (!column) continue;
    const width = widthOf(column);
    if (totalWidth + width > available) continue;
    visibleKeys.push(key);
    totalWidth += width;
  }

  const droppedKeys = input.columns
    .map((column) => column.key)
    .filter((key) => !visibleKeys.includes(key));

  return {
    visibleKeys,
    droppedKeys,
    totalWidth,
    fits: totalWidth <= available,
  };
}

/** Below this width a desktop column set cannot be read without scrolling. */
export const NARROW_VIEWPORT_BREAKPOINT = 768;

export function isNarrowViewport(width: number): boolean {
  return Number.isFinite(width) && width < NARROW_VIEWPORT_BREAKPOINT;
}
