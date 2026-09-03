/**
 * D085 Correction 9 — ONE point-in-time policy.
 *
 * WHY. r9 treated validity as ordering. Two leaks followed:
 *
 *   1. A `capturedAt` of `"not-an-instant"` previewed. It was non-empty, so
 *      provenance passed, and the ordering loop wrote
 *      `if (ms !== null && ms > knowledgeMs)` — an UNPARSEABLE value produced
 *      `ms === null` and was silently skipped. A clock that cannot be read is
 *      not a clock that is in order.
 *
 *   2. A fully VALID date-only raw intent dated `2026-09-01` previewed against
 *      an outer knowledge cutoff of `2026-08-31T23:59:59.000Z`. A later
 *      calendar day leaked across an earlier instant cutoff because the two
 *      were never compared: one was a day, the other an instant, and nothing
 *      said how to relate them.
 *
 * THE CANONICAL INTERPRETATION, stated once and used everywhere:
 *
 *   A value is compared AT ITS OWN GRANULARITY.
 *
 *   - An INSTANT (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) is compared instant-to-instant
 *     against the cutoff instant.
 *   - A DATE-ONLY value (`YYYY-MM-DD`) names a calendar day and carries no
 *     time-of-day claim, so it is compared DAY-to-DAY: its UTC day must not be
 *     LATER than the UTC day of the bound.
 *
 * This is the interpretation that is both sound and usable. Comparing a
 * date-only value at the END of its day would reject the ordinary same-day
 * case — a proposal originating 2026-09-01 with a 2026-09-01T00:00:00Z cutoff
 * is legitimate, and an end-of-day reading calls it a leak. Comparing at the
 * START of its day would admit a whole day of hindsight. Day-to-day comparison
 * does neither: it closes leak 2 (day 2026-09-01 is later than day 2026-08-31,
 * so it blocks) while admitting the same-day and boundary cases.
 *
 * A date-only value can therefore never leak a LATER CALENDAR DAY across an
 * earlier cutoff, which is exactly the guarantee required — and no more is
 * claimed, because a date-only stamp genuinely does not carry a time of day.
 */

import type { SchemaProblem } from "@/lib/meta/runtime-schema";

export const PIT_POLICY_VERSION = "meta.point-in-time-policy.v1" as const;

/** Documented for the artifact and for readers, not just for the code. */
export const PIT_POLICY = {
  version: PIT_POLICY_VERSION,
  dateOnlyInterpretation:
    "A value is compared at its own granularity: an instant instant-to-instant, a date-only YYYY-MM-DD value day-to-day in UTC. A date-only value may never name a LATER calendar day than the bound; it carries no time-of-day claim, so no finer comparison is asserted.",
  invalidTimestamps:
    "A non-empty value that cannot be parsed as a strict instant or calendar day BLOCKS. It is never skipped, and non-empty is never treated as valid provenance.",
  ordering:
    "Every clock the proposal rests on must be at or before BOTH the outer origin and the outer knowledge cutoff. Each comparison is made at the coarser of the two granularities: instant-to-instant only when both sides are instants, day-to-day whenever either side is date-only.",
} as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict instant. Rejects `Date.parse` rollover — `2026-02-30` is not
 * a real day and must not silently become March.
 */
export function strictInstantMs(value: string): number | null {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const ms = Date.UTC(y, m - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
    return ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null;
  const day = value.slice(0, 10);
  const [y, m, d] = day.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The instant a value denotes; date-only values denote the start of their day. */
export function upperBoundMs(value: string): number | null {
  return strictInstantMs(value);
}

/** The UTC day an instant or date-only value falls in, as a day-start instant. */
export function utcDayMs(value: string): number | null {
  const ms = strictInstantMs(value);
  if (ms === null) return null;
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Compare a clock value against a bound at the CLOCK's granularity.
 * Returns true when the value is strictly after the bound.
 */
function isAfter(value: string, boundValue: string): boolean | null {
  const valueMs = strictInstantMs(value);
  const boundMs = strictInstantMs(boundValue);
  if (valueMs === null || boundMs === null) return null;
  /*
    Compare at the COARSER of the two granularities.

    If EITHER side is date-only, neither carries a comparable time of day, so
    the only sound comparison is day-to-day. Comparing an instant against a
    date-only bound at instant precision treats the bound as midnight and
    wrongly calls 12:00 on the origin DAY "after the origin" — which is a real
    same-day observation being rejected, not a leak.
  */
  if (isDateOnly(value) || isDateOnly(boundValue)) {
    return utcDayMs(value)! > utcDayMs(boundValue)!;
  }
  return valueMs > boundMs;
}

export interface ClockUnderTest {
  /** Dotted path, used verbatim in the problem so a blocker names the field. */
  path: string;
  label: string;
  value: unknown;
  /** `null` is legitimate absence for some clocks and an error for others. */
  nullable: boolean;
}

export interface PitBounds {
  /** The outer origin DAY. */
  originDate: string;
  /** The outer knowledge cutoff INSTANT. */
  knowledgeAsOf: string;
}

export interface PitViolation extends SchemaProblem {
  kind: "unparseable" | "after_origin" | "after_knowledge" | "absent";
}

/**
 * Test every clock against both outer bounds.
 *
 * Returns one violation per offending clock, with the exact path, so a caller
 * can raise a specific blocker rather than a generic one.
 */
export function checkPointInTimeOrder(clocks: readonly ClockUnderTest[], bounds: PitBounds): PitViolation[] {
  const violations: PitViolation[] = [];
  const originMs = strictInstantMs(bounds.originDate);
  const knowledgeMs = strictInstantMs(bounds.knowledgeAsOf);

  if (originMs === null) {
    violations.push({ path: "originDate", kind: "unparseable", why: `the outer origin ${JSON.stringify(bounds.originDate)} is not a real calendar day` });
  }
  if (knowledgeMs === null) {
    violations.push({ path: "knowledgeAsOf", kind: "unparseable", why: `the outer knowledge cutoff ${JSON.stringify(bounds.knowledgeAsOf)} is not a strict instant` });
  }

  for (const clock of clocks) {
    if (clock.value === null || clock.value === undefined) {
      if (!clock.nullable) {
        violations.push({ path: clock.path, kind: "absent", why: `${clock.label} is absent, and this proposal cannot rest on an unstated clock` });
      }
      continue;
    }
    if (typeof clock.value !== "string" || clock.value.trim() === "") {
      violations.push({ path: clock.path, kind: "unparseable", why: `${clock.label} is ${JSON.stringify(clock.value)}, not a timestamp` });
      continue;
    }
    const ms = strictInstantMs(clock.value);
    if (ms === null) {
      // THE r9 LEAK: this case used to be skipped.
      violations.push({ path: clock.path, kind: "unparseable", why: `${clock.label} ${JSON.stringify(clock.value)} is non-empty but is not a strict instant or calendar day, so it proves nothing` });
      continue;
    }
    if (originMs !== null && isAfter(clock.value, bounds.originDate) === true) {
      violations.push({ path: clock.path, kind: "after_origin", why: `${clock.label} (${clock.value}) is after the ${bounds.originDate} origin` });
    }
    if (knowledgeMs !== null && isAfter(clock.value, bounds.knowledgeAsOf) === true) {
      violations.push({
        path: clock.path,
        kind: "after_knowledge",
        why: `${clock.label} (${clock.value}) is after the ${bounds.knowledgeAsOf} knowledge cutoff${isDateOnly(clock.value) ? " — its calendar day is later than the cutoff's day" : ""}`,
      });
    }
  }
  return violations;
}
