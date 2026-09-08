/**
 * ONE STRICT READING OF A COMMERCIAL-TARGET TIMESTAMP.
 *
 * Four places decided whether an operator's target pack carried a trustworthy
 * clock, and all four asked `Number.isFinite(Date.parse(value))`:
 *
 *   - `normalizeMetaCommercialTargets` (`lib/meta/commercial-targets.ts`)
 *   - `commercialTargetProvenanceState`
 *     (`lib/creative-decision-engine/commercial-semantic-projection.ts`)
 *   - `resolveSpendUnitProfile` / `resolveHardActionEligibility`
 *     (`lib/creative-decision-engine/account-decision-profile.ts`)
 *   - `resolveNativeAdTargetAuthority`'s `effectiveAt` / `recordedAt`
 *     (`lib/creative-decision-engine/jobs/ad-calibration-job.ts`)
 *
 * `Date.parse` is not a validator. Measured on this runtime:
 *
 *   Date.parse("2026-02-30")            -> 1772409600000  (silently 2026-03-02)
 *   Date.parse("2026-02-29T00:00:00Z")  -> 1772323200000  (2026 is not a leap
 *                                                          year; silently 03-01)
 *   Date.parse("2026-09-05")            -> a valid instant from a DATE, not an
 *                                          instant
 *   Date.parse("2026-09-05T03:00:00")   -> parsed in the HOST's local zone, so
 *                                          the same stored row means a
 *                                          different instant on two machines
 *   Date.parse("September 5, 2026")     -> accepted
 *   Date.parse("2026-9-5")              -> accepted
 *
 * Every one of those was accepted as proof that the operator's targets carry a
 * trustworthy timestamp, which is the fact that decides `freshness`,
 * `commercialTruthTimestampTrusted`, `commercialThresholdEligible`, the native
 * `cutoff_unsafe` verdict and — through
 * `commercialTargetProvenanceState` — three hash families. A rolled-over date
 * is worse than an absent one: it answers "trusted" while naming a day that
 * does not exist.
 *
 * SO THIS DOES NOT USE `Date.parse` TO DECIDE. The literal calendar fields are
 * read out of the string and checked against the real length of that month, and
 * the instant is then CONSTRUCTED from them with `Date.UTC`. A value that would
 * roll over cannot survive, because nothing is ever handed to a parser that
 * would roll it over.
 *
 * SCOPE. This is deliberately NOT the repository's point-in-time helper.
 * `normalizeAsOfCutoff` (`lib/business-commercial.ts`) accepts a bare
 * `YYYY-MM-DD` on purpose — a query cutoff is a DAY an operator or a scheduler
 * names, and it is widened to `T03:00:00.000Z` under its own documented rule.
 * That behaviour is intentional and untouched. What is validated here is a
 * different kind of value: a timestamp the DATABASE recorded, which is always a
 * full instant, and which is read as evidence rather than as a parameter.
 */

/**
 * A full RFC 3339 instant with an explicit offset.
 *
 * `Z` or a numeric `±HH:MM` — both denote one exact instant. A naked local
 * time (`2026-09-05T03:00:00`) is rejected because it denotes a different
 * instant on every host, and a stored fact must not mean two things.
 */
const COMMERCIAL_TARGET_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/;

function daysInUtcMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * The instant this value denotes, in epoch milliseconds, or null.
 *
 * Null is the ONLY failure signal: a malformed timestamp is an absence of
 * evidence, and every caller already has an "absent" branch that closes
 * authority. Throwing here would turn a bad row into an outage.
 */
export function commercialTargetInstantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = COMMERCIAL_TARGET_INSTANT_PATTERN.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  // Fractional seconds are truncated to milliseconds, never rounded: rounding
  // could move an instant ACROSS a cutoff, which is the one thing a cutoff
  // comparison must not depend on.
  const fraction = match[7] ?? "";
  const millisecond = fraction
    ? Number(fraction.slice(0, 3).padEnd(3, "0"))
    : 0;
  const zone = match[8]!;

  // THE ROLLOVER GUARD. Every field is checked against its real range before
  // any date arithmetic happens, so `2026-02-30` and `2026-02-29` are refused
  // rather than becoming March.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInUtcMonth(year, month)) return null;
  // 24:00:00 is legal in ISO 8601 as an end-of-day marker. It is refused
  // because it names the same instant as the next day's 00:00:00, and two
  // spellings of one instant would hash differently.
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(utcMs)) return null;
  // `Date.UTC` maps years 0–99 onto 1900–1999. The pattern already requires
  // four digits, so this only guards a two-digit year written as `0099`.
  if (year < 100) return null;
  return utcMs - offsetMinutes * 60_000;
}

/** Whether this value is a usable commercial-target instant at all. */
export function isCommercialTargetInstant(value: unknown): boolean {
  return commercialTargetInstantMs(value) !== null;
}

/**
 * Whether this value is a usable instant AT OR BEFORE the deterministic cutoff.
 *
 * A target pack timestamped after the cutoff is evidence the evaluation is not
 * allowed to have seen. It fails the same way a malformed one does — closed —
 * because "recorded in the future relative to this evaluation" and "not a
 * timestamp" are both "this cannot be used as proof of provenance here".
 */
export function isCommercialTargetInstantWithinCutoff(
  value: unknown,
  cutoffMs: number,
): boolean {
  const parsed = commercialTargetInstantMs(value);
  if (parsed === null) return false;
  if (!Number.isFinite(cutoffMs)) return false;
  return parsed <= cutoffMs;
}

/**
 * The deterministic cutoff instant an `asOf` DAY denotes.
 *
 * ── ROUND 9 ITEM 2 ─────────────────────────────────────────────────────────
 * `resolveAccountDecisionProfile` validated the target pack's `updatedAt` for
 * FORMAT only and passed no cutoff at all, so a pack saved after the day being
 * evaluated still made every hard action eligible. A point-in-time profile that
 * cannot say "this evidence is from after the moment I am reconstructing" is
 * not a point-in-time profile.
 *
 * The widening rule is deliberately the SAME one `normalizeAsOfCutoff`
 * (`lib/business-commercial.ts`) applies when it reads the historical pack:
 * a bare `YYYY-MM-DD` becomes `T03:00:00.000Z`. If the profile used a
 * different instant than the reader that fetched the pack, the two would
 * disagree about which pack was in force and the disagreement would be silent.
 *
 * A full instant is accepted as-is and read strictly. NOTHING here reads the
 * wall clock: an unusable `asOf` returns null and the caller fails closed.
 */
export function deterministicCommercialCutoffMs(
  asOf: string | null | undefined,
): number | null {
  if (typeof asOf !== "string") return null;
  const trimmed = asOf.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return commercialTargetInstantMs(`${trimmed}T03:00:00.000Z`);
  }
  return commercialTargetInstantMs(trimmed);
}
