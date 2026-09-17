/**
 * Pure layout and draft helpers for the Overview KPI band.
 *
 * The band is a 12-track grid. Every full row holds the same number of equal
 * cards for its width tier; a short last row divides the width evenly so no
 * card is stranded next to empty space. Because 12 divides by 1, 2, 3 and 4,
 * every row of every tier sums to exactly 12 tracks.
 *
 * One exception: where a row holds three or more cards, a single leftover card
 * would stretch across the whole band and read as a second hero. That card
 * pulls one neighbour down instead, so the last two rows read N-1 and 2.
 */

export const KPI_GRID_TRACKS = 12;

/** Cards per full row, from widest to narrowest container tier. */
export const KPI_CARDS_PER_ROW = {
  wide: 4,
  medium: 3,
  small: 2,
  narrow: 1,
} as const;

export type KpiGridTier = keyof typeof KPI_CARDS_PER_ROW;

/** Cards in each visual row, in order, at a given cards-per-row count. */
export function kpiRowSizes(count: number, cardsPerRow: number): number[] {
  if (count <= 0) return [];
  // Row sizes stay within 1–4 so every size divides the 12 tracks exactly.
  const perRow = Math.max(1, Math.min(KPI_CARDS_PER_ROW.wide, Math.floor(cardsPerRow)));
  const rows = Array.from({ length: Math.floor(count / perRow) }, () => perRow);
  const remainder = count % perRow;
  if (remainder === 0) return rows;
  if (remainder === 1 && perRow >= 3 && rows.length > 0) {
    rows[rows.length - 1] = perRow - 1;
    rows.push(2);
    return rows;
  }
  rows.push(remainder);
  return rows;
}

/** Track span for each card, in order, at a given cards-per-row count. */
export function kpiRowSpans(count: number, cardsPerRow: number): number[] {
  return kpiRowSizes(count, cardsPerRow).flatMap((size) =>
    Array.from({ length: size }, () => KPI_GRID_TRACKS / size),
  );
}

/** Deduplicated, falsy-free metric keys, preserving first occurrence order. */
export function uniqueMetricKeys(keys: readonly string[]): string[] {
  return keys.filter((key, index) => Boolean(key) && keys.indexOf(key) === index);
}

export function addMetricKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? [...keys] : [...keys, key];
}

export function removeMetricKey(keys: readonly string[], key: string): string[] {
  return keys.filter((candidate) => candidate !== key);
}

/** Moves `key` to `toIndex` (clamped). Returns the same order when nothing moves. */
export function moveMetricKeyTo(keys: readonly string[], key: string, toIndex: number): string[] {
  const fromIndex = keys.indexOf(key);
  if (fromIndex < 0) return [...keys];
  const target = Math.max(0, Math.min(keys.length - 1, toIndex));
  if (target === fromIndex) return [...keys];
  const next = [...keys];
  next.splice(fromIndex, 1);
  next.splice(target, 0, key);
  return next;
}

export function sameMetricKeyOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
