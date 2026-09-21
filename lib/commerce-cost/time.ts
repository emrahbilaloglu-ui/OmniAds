/**
 * One way to read a timestamp, for the whole cost slice.
 *
 * Two properties the accounting depends on:
 *  - The same string always means the same instant. A bare `2026-09-16T00:00`
 *    with no offset is read as UTC, so a window re-derived on a host in
 *    another timezone cannot produce a different amount under the same event
 *    id.
 *  - An unreadable timestamp is `null`, never a silent epoch. Collapsing a
 *    malformed date to 0 made a component effective for every order that ever
 *    happened.
 */

export const DAY_MS = 86_400_000;

const OFFSETLESS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const normalized = OFFSETLESS_DATETIME.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/** First instant of a `YYYY-MM-DD` day, in UTC. Also accepts a full instant. */
export function startOfUtcDay(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return Date.parse(`${trimmed}T00:00:00.000Z`);
  return parseInstant(trimmed);
}

/** Thrown when a caller asks for a replay it cannot pin to an instant. */
export class InvalidCostInstantError extends Error {
  constructor(field: string, value: string) {
    super(`commerce-cost: ${field} is not a readable instant: ${JSON.stringify(value)}`);
    this.name = "InvalidCostInstantError";
  }
}

/**
 * Parses an as-of instant, refusing rather than guessing.
 *
 * A replay that cannot be pinned must not quietly answer as a live read (which
 * would show today's costs as history) or as an empty one (which would claim
 * nothing was known). Both happened before this existed, in different files.
 */
export function parseAsOfInstant(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseInstant(value);
  if (parsed === null) throw new InvalidCostInstantError("asOfRecordedAt", String(value));
  return parsed;
}

function monthStartUtc(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonthStartUtc(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function yearStartUtc(ms: number): number {
  return Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
}

function nextYearStartUtc(ms: number): number {
  return Date.UTC(new Date(ms).getUTCFullYear() + 1, 0, 1);
}

/**
 * The share of a recurring period a range covers, in period units.
 *
 * Calendar-aware for months and years, so a full calendar month charges the
 * amount the operator typed — the figure they can reconcile against the
 * invoice — instead of 27,616 in February and 30,575 in March for the same
 * rent. Days and weeks are fixed-length, so they need no calendar.
 */
export function periodFractionForRange(
  period: "day" | "week" | "month" | "year",
  startMs: number,
  endExclusiveMs: number,
): number | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endExclusiveMs)) return null;
  if (endExclusiveMs <= startMs) return 0;

  if (period === "day") return (endExclusiveMs - startMs) / DAY_MS;
  if (period === "week") return (endExclusiveMs - startMs) / (7 * DAY_MS);

  const stepStart = period === "month" ? monthStartUtc : yearStartUtc;
  const stepNext = period === "month" ? nextMonthStartUtc : nextYearStartUtc;

  let fraction = 0;
  let cursor = stepStart(startMs);
  // Bounded by construction: each step advances one calendar period.
  while (cursor < endExclusiveMs) {
    const next = stepNext(cursor);
    const overlapStart = Math.max(cursor, startMs);
    const overlapEnd = Math.min(next, endExclusiveMs);
    if (overlapEnd > overlapStart) fraction += (overlapEnd - overlapStart) / (next - cursor);
    cursor = next;
  }
  return fraction;
}
