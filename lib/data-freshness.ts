/**
 * How old the numbers on a surface are.
 *
 * Only the Decisions header ever admitted its age. Everywhere else, data loaded
 * hours earlier looked identical to data loaded a moment ago, which is how a
 * budget decision gets made against a stalled sync.
 *
 * Age is never guessed: a surface that cannot establish when its data was
 * produced says so rather than implying it is current.
 */

export type FreshnessLevel = "fresh" | "aging" | "stale" | "unknown";

export interface FreshnessReading {
  level: FreshnessLevel;
  /** Short label for a chip, e.g. "3h ago". Null when age is unknown. */
  ageLabel: string | null;
  /** Full sentence for a title attribute or caption. */
  description: string;
  minutesOld: number | null;
}

const MINUTE = 60_000;

export interface FreshnessThresholds {
  /** Minutes after which data is aging rather than fresh. */
  agingAfterMinutes: number;
  /** Minutes after which data is stale. */
  staleAfterMinutes: number;
}

export const DEFAULT_FRESHNESS: FreshnessThresholds = {
  agingAfterMinutes: 90,
  staleAfterMinutes: 24 * 60,
};

function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  return `${Math.floor(days)}d ago`;
}

export function readFreshness(
  asOf: string | Date | null | undefined,
  now: Date = new Date(),
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS,
): FreshnessReading {
  if (!asOf) {
    return {
      level: "unknown",
      ageLabel: null,
      description: "This surface cannot say when its data was last updated.",
      minutesOld: null,
    };
  }

  const at = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(at.getTime())) {
    return {
      level: "unknown",
      ageLabel: null,
      description: "This surface cannot say when its data was last updated.",
      minutesOld: null,
    };
  }

  const minutesOld = (now.getTime() - at.getTime()) / MINUTE;

  // A timestamp in the future is not fresh data, it is a clock we cannot trust.
  if (minutesOld < -5) {
    return {
      level: "unknown",
      ageLabel: null,
      description: "The reported update time is in the future, so its age cannot be trusted.",
      minutesOld: null,
    };
  }

  const clamped = Math.max(0, minutesOld);
  const ageLabel = formatAge(clamped);

  if (clamped >= thresholds.staleAfterMinutes) {
    return {
      level: "stale",
      ageLabel,
      description: `Data is ${ageLabel} and may no longer reflect the account.`,
      minutesOld: clamped,
    };
  }
  if (clamped >= thresholds.agingAfterMinutes) {
    return {
      level: "aging",
      ageLabel,
      description: `Data is ${ageLabel}. Refresh before acting on close calls.`,
      minutesOld: clamped,
    };
  }
  return {
    level: "fresh",
    ageLabel,
    description: `Data is ${ageLabel}.`,
    minutesOld: clamped,
  };
}
