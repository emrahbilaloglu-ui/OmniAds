/**
 * What a Launchpad validation actually checked, and what it did not.
 *
 * §10 step 10 of `docs/meta-market-ready-master-plan-2026-08-22.md`: "Preflight
 * yaşı ve did not contact Meta açıklaması." The validate endpoint returned
 * `ok`, blockers and warnings and said nothing about when the answer was
 * produced or what it rests on — so a green validation read as "this launch is
 * cleared", which it is not.
 *
 * Two facts an operator needs and could not get:
 *
 * 1. **How old this answer is.** Validation reads live provider state (billing
 *    status, pixels). That state moves. A validation from twenty minutes ago is
 *    not a statement about now, and nothing on screen said so.
 * 2. **What it did NOT verify.** Validation does not read the selected
 *    creatives from Meta. That check — `preflightMetaLaunchCreatives`, a fresh
 *    GET per creative binding exact id and account — runs at execution time,
 *    immediately before the first create. A validation that looked complete
 *    while carrying no creative-identity proof invites the operator to treat it
 *    as one.
 *
 * The disclosure is deliberately specific about both directions. Saying only
 * "this did not contact Meta" would be **false** — validation does contact Meta
 * — and a false reassurance is worse than none.
 */

/** Provider reads a validation performs. Named, not summarised. */
export type ValidationProviderRead = "billing_status" | "pixels" | "target_account";

export interface ValidationPreflightDisclosure {
  /** When this validation ran. The operator's own staleness judgement. */
  readonly checkedAt: string;
  /** Live provider state this answer rests on. */
  readonly providerReads: readonly ValidationProviderRead[];
  /**
   * False here, always. Creative identity is proven at execution time and
   * never by validation, so this is a constant that documents a boundary
   * rather than a value that varies.
   */
  readonly creativeIdentityVerified: false;
  /** One sentence for the operator. */
  readonly disclosure: string;
}

export const VALIDATION_PREFLIGHT_DISCLOSURE =
  "This check read your Meta account's billing and pixel state just now. It did not verify the selected creatives against Meta — that happens at execution time, immediately before anything is created, and a launch can still be refused there.";

export function buildValidationPreflightDisclosure(input: {
  checkedAt: string;
  /** Omit a read that did not happen; an unread source is not a checked one. */
  providerReads: readonly ValidationProviderRead[];
}): ValidationPreflightDisclosure {
  return {
    checkedAt: input.checkedAt,
    providerReads: [...input.providerReads],
    creativeIdentityVerified: false,
    disclosure: VALIDATION_PREFLIGHT_DISCLOSURE,
  };
}

/**
 * How old a persisted preflight is, in whole seconds.
 *
 * Returns `null` for an absent or unparseable timestamp rather than 0. Zero
 * means "checked this instant", which is the single most misleading value to
 * invent for something we could not read.
 */
export function preflightAgeSeconds(
  checkedAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!checkedAt) return null;
  const parsed = Date.parse(checkedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 1000));
}
