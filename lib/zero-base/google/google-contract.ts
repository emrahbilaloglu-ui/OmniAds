/**
 * Google read surfaces (H29–H31, read half of Flow F).
 *
 * Google is a different product from Meta with a different vocabulary, and the
 * two must not bleed. A Meta lane word on a Google surface implies a shared
 * decision model that does not exist; an owner or due date implies a workflow
 * Google has none of; `pause_ad`, repair-gap and Launchpad imply write paths
 * that are Meta-only. The forbidden list below is checked in tests against the
 * rendered text, not merely intended.
 *
 * The other rule that shapes everything here: **scope is explicit**. A figure
 * from one account and a figure summed across a portfolio are different facts,
 * and a portfolio whose accounts disagree on currency or timezone cannot be
 * summed at all. So the scope is stated, and where a sum would be dishonest the
 * surface refuses to produce one.
 */

/** Vocabulary that must never appear on a Google surface. */
export const FORBIDDEN_GOOGLE_VOCABULARY = [
  "action now",
  "needs resolution",
  "watching",
  "non-sales",
  "owner",
  "due date",
  "pause_ad",
  "repair gap",
  "repair-gap",
  "launchpad",
] as const;

export function containsForbiddenVocabulary(text: string): string[] {
  const lowered = text.toLowerCase();
  return FORBIDDEN_GOOGLE_VOCABULARY.filter((word) => lowered.includes(word));
}

/* ----------------------------------------------------------- account scope */

export interface GoogleAccount {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export type GoogleScope =
  | { kind: "none"; reason: string }
  | { kind: "single"; account: GoogleAccount; label: string }
  | {
      kind: "portfolio";
      accounts: GoogleAccount[];
      label: string;
      /** True only when every account agrees, so a sum would be meaningful. */
      summable: boolean;
      /** Why a sum is withheld. Null when it is not. */
      unsummableReason: string | null;
    };

/**
 * Resolve the account scope and decide whether totals may be added at all.
 *
 * Two accounts in different currencies cannot be summed into one number, and
 * two in different timezones do not share a "yesterday". Producing a total
 * anyway is the silent sum this refuses.
 */
export function resolveGoogleScope(accounts: readonly GoogleAccount[]): GoogleScope {
  if (accounts.length === 0) {
    return { kind: "none", reason: "No Google Ads account is assigned to this business." };
  }
  if (accounts.length === 1) {
    const account = accounts[0];
    return {
      kind: "single",
      account,
      label: `${account.name ?? account.id} · ${account.currency ?? "currency not served"} · ${
        account.timezone ?? "timezone not served"
      }`,
    };
  }
  const currencies = new Set(accounts.map((a) => a.currency ?? "unknown"));
  const timezones = new Set(accounts.map((a) => a.timezone ?? "unknown"));
  const problems: string[] = [];
  if (currencies.size > 1) problems.push(`${currencies.size} currencies`);
  if (timezones.size > 1) problems.push(`${timezones.size} time zones`);
  const summable = problems.length === 0;
  return {
    kind: "portfolio",
    accounts: [...accounts],
    label: `${accounts.length} accounts`,
    summable,
    unsummableReason: summable
      ? null
      : `These accounts span ${problems.join(" and ")}, so their figures are shown per account rather than added together.`,
  };
}

/* ------------------------------------------------------------ source state */

export type GoogleSourceState =
  | { kind: "serving"; observedAt: string | null }
  | { kind: "partial"; reason: string; observedAt: string | null }
  | { kind: "rate_limited"; reason: string; retryAfterSeconds: number | null }
  | { kind: "unavailable"; reason: string };

/**
 * A served value, or an explicit absence.
 *
 * `unavailable` and `0` are different facts. A source that could not be read
 * renders as unavailable with its reason; only a measured zero renders as zero.
 */
export type GoogleValue =
  | { available: true; display: string; raw: number }
  | { available: false; reason: string };

export function googleValue(
  raw: number | null | undefined,
  format: (value: number) => string,
  reason = "Not served by Google for this window.",
): GoogleValue {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return { available: false, reason };
  }
  return { available: true, display: format(raw), raw };
}

/* ---------------------------------------------------------------- advisor */

export type AdvisorHorizon = "do_now" | "next" | "later";

export const ADVISOR_HORIZONS: readonly AdvisorHorizon[] = ["do_now", "next", "later"];

export const ADVISOR_HORIZON_LABEL: Record<AdvisorHorizon, string> = {
  do_now: "Do now",
  next: "Next",
  later: "Later",
};

export interface ServedAdvisorItem {
  id: string;
  title: string;
  rationale: string | null;
  /** The server's own urgency. Never re-derived from a metric here. */
  urgency?: string | null;
}

export interface AdvisorGroup {
  horizon: AdvisorHorizon;
  label: string;
  items: ServedAdvisorItem[];
}

/**
 * Group served advisor items by the horizon the server assigned.
 *
 * An item with no urgency goes to `later` rather than being promoted: guessing
 * upward manufactures urgency the engine never expressed.
 */
export function groupAdvisor(items: readonly ServedAdvisorItem[]): AdvisorGroup[] {
  const buckets: Record<AdvisorHorizon, ServedAdvisorItem[]> = { do_now: [], next: [], later: [] };
  for (const item of items) {
    const urgency = item.urgency?.trim().toLowerCase();
    if (urgency === "do_now" || urgency === "now" || urgency === "high") buckets.do_now.push(item);
    else if (urgency === "next" || urgency === "medium") buckets.next.push(item);
    else buckets.later.push(item);
  }
  return ADVISOR_HORIZONS.map((horizon) => ({
    horizon,
    label: ADVISOR_HORIZON_LABEL[horizon],
    items: buckets[horizon],
  }));
}

/* -------------------------------------------------- default-off reference */

/**
 * The reference card shown for a write Google could accept but this product
 * will not perform.
 *
 * Every field is required. A default-off card that omits its dependency or its
 * stabilization window looks like a feature waiting for a switch, rather than
 * a proposal whose evidence is not yet good enough to act on.
 */
export interface ReferenceCard {
  id: string;
  title: string;
  /** Why this is off. Never "coming soon". */
  reason: string;
  /** Identity of the exact proposal, so two runs can be compared. */
  fingerprint: string;
  /** What it would depend on. */
  dependency: string;
  /** How long the signal must hold before it could be trusted. */
  stabilization: string;
  /** What has NOT been verified. Present even when short. */
  unverified: string;
}

export const REFERENCE_CARD_FIELDS = [
  "reason",
  "fingerprint",
  "dependency",
  "stabilization",
  "unverified",
] as const;

/** A card missing any required field is not rendered as a card. */
export function referenceCardComplete(card: Partial<ReferenceCard>): boolean {
  return REFERENCE_CARD_FIELDS.every((field) => Boolean(card[field]?.toString().trim()));
}
