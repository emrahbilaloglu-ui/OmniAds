/**
 * WHAT A MEDIA BUYER READS, AS OPPOSED TO WHAT THE ENGINE CALLS IT.
 *
 * Round 8, item 7. The Creatives surface was showing the server's own
 * vocabulary verbatim. `creativesNotice` returned `limitation.message`
 * unchanged, and the diagnostics rows printed the limitation CODE as their
 * label and the raw message as their value, so a buyer opening Decision Center
 * read sentences like:
 *
 *   "Legacy creative-grain decisions remain visible for continuity but cannot
 *    authorize Ad writes."
 *   "60 ACTIVE Ads have no exact Ad-grain decision yet, so they are not listed
 *    as decisions."
 *   "Legacy rows use creative-grain metrics and are review-only even when one
 *    exact Ad identity is displayed."
 *
 * Every one of those is true and none of them is usable. "Ad-grain", "creative
 * grain", "authorize Ad writes", "canonical", "resolver", "contract",
 * "provider scope" and "unauthorized" are names for internal structure. A buyer
 * cannot act on the distinction between an Ad-grain and a creative-grain
 * decision; they can act on "these ads are still being evaluated" and on
 * "this older guidance can't be applied to individual ads".
 *
 * ## The rule this module encodes
 *
 * The SERVER STATE is authoritative and unchanged — the codes, the counts and
 * the capability envelope keep their exact meanings and their exact contracts.
 * What changes is that a mounted surface renders a mapping OF that state
 * rather than the state's own name.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not soften a refusal into an availability. "Still being
 *    evaluated" and "can't be applied to individual ads" are both refusals; they
 *    are simply refusals in the buyer's terms. A message that made a blocked
 *    thing sound possible would be worse than jargon.
 *  - It does not invent a cause. An unrecognised code falls back to a generic
 *    but honest sentence rather than to the raw internal message, because a
 *    surface that cannot name the cause in the buyer's terms must not name it
 *    in the engine's instead.
 *
 * The engine's own vocabulary is not lost: it stays in the payload, and the
 * diagnostics disclosure still carries the machine code under its own label for
 * anyone who needs to trace it.
 */

/** Limitation codes the OS presentation emits. @see lib/meta/decisions-os-presentation.ts */
const LIMITATION_COPY: Readonly<Record<string, string>> = Object.freeze({
  /*
    The server sentence counts the ads and calls them "ACTIVE Ads with no exact
    Ad-grain decision". The count is the useful half and it is preserved by the
    caller; the cause is stated as what the buyer can expect to happen next.
  */
  active_ad_inventory_pending_native_decision:
    "still being evaluated. They will appear here when a decision is ready.",
  legacy_creative_review_only:
    "Earlier creative-level guidance is shown for reference and cannot be applied to individual ads.",
  ad_metrics_are_creative_context:
    "Those earlier rows describe a group of ads, not one ad, so their numbers cannot size a single ad's change.",
});

/** The sentence shown when a limitation code has no buyer mapping yet. */
export const BUYER_LIMITATION_FALLBACK =
  "Some ad-level guidance is unavailable right now." as const;

/**
 * The buyer-facing sentence for one served limitation.
 *
 * `count` is threaded because the pending-inventory limitation is only useful
 * WITH its number — "60 active ads are still being evaluated" tells a buyer how
 * much of their account is affected, which is the one quantitative fact in the
 * whole envelope.
 */
export function buyerLimitationCopy(
  code: string | null | undefined,
  count?: number | null,
): string {
  const key = (code ?? "").trim();
  if (key === "active_ad_inventory_pending_native_decision") {
    const ads = typeof count === "number" && Number.isFinite(count) && count > 0
      ? count
      : null;
    if (ads === null) {
      return "Some active ads are still being evaluated. They will appear here when a decision is ready.";
    }
    return `${ads.toLocaleString("en-US")} active ${ads === 1 ? "ad is" : "ads are"} ${LIMITATION_COPY[key]}`;
  }
  return LIMITATION_COPY[key] ?? BUYER_LIMITATION_FALLBACK;
}

/**
 * A short, non-technical name for one served limitation, for the diagnostics
 * row's LABEL.
 *
 * The raw code stays available beside it in the same panel, under its own
 * "Code" heading, so tracing is not lost — it simply is not the first thing a
 * buyer reads.
 */
const LIMITATION_TITLE: Readonly<Record<string, string>> = Object.freeze({
  active_ad_inventory_pending_native_decision: "Ads awaiting a decision",
  legacy_creative_review_only: "Older guidance, reference only",
  ad_metrics_are_creative_context: "Grouped numbers",
});

export function buyerLimitationTitle(code: string | null | undefined): string {
  return LIMITATION_TITLE[(code ?? "").trim()] ?? "Limited guidance";
}

/**
 * The one line at the top of the source panel.
 *
 * It joined the raw `authority` token and the raw `health` token with a middle
 * dot — "native_ad · healthy", or "legacy_creative_review_only · degraded" —
 * which is a database enum pair shown as a headline.
 */
export function buyerSourceHeadline(input: {
  adLevelReady: boolean;
  healthy: boolean;
  served: boolean;
}): string {
  if (!input.served) return "Ad-level guidance status unavailable";
  if (!input.adLevelReady) return "Ad-level decisions are not available yet";
  return input.healthy
    ? "Ad-level decisions are up to date"
    : "Ad-level decisions are running behind";
}

/**
 * The same line for the STRUCTURE scope, which is a different subject.
 *
 * That headline joined `structureSource` and the read model's raw `status`
 * token — "meta_recommendations · available". It is about campaigns and ad
 * sets, not about ads, so it gets its own sentence rather than borrowing the
 * ad-level one.
 */
export function buyerStructureHeadline(input: {
  served: boolean;
  ready: boolean;
}): string {
  if (!input.served) return "Campaign and ad set guidance status unavailable";
  return input.ready
    ? "Campaign and ad set guidance is up to date"
    : "Campaign and ad set guidance is limited right now";
}

/**
 * Why an individual decision could not be turned into an action.
 *
 * The engine's explanations name the layer that refused
 * ("The account profile did not meet the evidence requirements for a hard
 * provider action", "Exact Ad-grain metrics were unavailable, so the hard
 * verdict cannot authorize a provider action"). A buyer needs the same refusal
 * expressed as what is missing and what would change it.
 */
const AUTHORITY_BLOCKER_COPY: Readonly<Record<string, string>> = Object.freeze({
  profile_hard_action_ineligible:
    "Confirm the missing information, then review this recommendation again.",
  source_freshness:
    "Waiting for today's numbers. This will be reviewed again after the next update.",
  campaign_context:
    "Confirm what this campaign is for, then review this recommendation again.",
  native_metrics_unavailable:
    "This ad's own numbers are not in yet, so the change cannot be sized.",
  native_profile_unavailable:
    "Not enough account history yet to act on this one.",
  recent_recovery_unverifiable:
    "Recent spend is too light to be sure this has not recovered. Give it a few more days.",
});

/** The sentence shown when a blocker has no buyer mapping yet. */
export const BUYER_BLOCKER_FALLBACK =
  "This recommendation cannot be applied yet." as const;

export function buyerAuthorityBlockerCopy(
  blocker: string | null | undefined,
): string {
  return AUTHORITY_BLOCKER_COPY[(blocker ?? "").trim()] ?? BUYER_BLOCKER_FALLBACK;
}

/**
 * Plain names for the eight served capability slots.
 *
 * "Provider account scope", "Stable decision identity", "Classification
 * overlay", "Promotion basis producer" and "Response attribution" are the
 * contract's own field names in title case. They named the mechanism; these
 * name what the buyer loses when the slot is not available.
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  providerAccountScope: "Account this applies to",
  stableDecisionIdentity: "Tracking a decision over time",
  stableEpisodeIdentity: "Grouping repeated decisions",
  classificationOverlay: "Campaign roles",
  riskTierProducer: "Risk level",
  promotionBasisProducer: "Why a winner was picked",
  responseAttribution: "Linking your action to the result",
  providerWriteLinkage: "Confirming a change reached Meta",
});

export function buyerCapabilityLabel(key: string): string {
  return CAPABILITY_LABELS[key] ?? key;
}

/**
 * Every word a mounted Creatives surface must not show a buyer.
 *
 * Exported so the DOM tests assert against ONE list rather than each restating
 * their own — a term added here is immediately enforced everywhere those tests
 * render.
 *
 * `authority` and `source` appear only in their engine senses ("source
 * authority", "provider scope"); the tests match case-insensitively on whole
 * words, so this list is deliberately limited to terms that have no ordinary
 * buyer meaning on this surface.
 */
export const INTERNAL_VOCABULARY: readonly string[] = Object.freeze([
  "ad-grain",
  "creative-grain",
  "authorize ad writes",
  "authorize",
  "unauthorized",
  "canonical",
  "resolver",
  "contract",
  "provider scope",
  "provider account scope",
  "native_ad",
  "legacy_creative_review_only",
  "active_ad_inventory_pending_native_decision",
  "ad_metrics_are_creative_context",
  "profile_hard_action_ineligible",
  "native_metrics_unavailable",
  "native_profile_unavailable",
  "recent_recovery_unverifiable",
  "hard action",
  "hard verdict",
  "engine",
  /*
    ── ROUND 9 ITEM 7 ──────────────────────────────────────────────────────
    `heldCreativeVerdict` emitted all three of these in one sentence — "Held
    verdict: Refresh creative" and "The engine's Refresh creative verdict stays
    unauthorized until then" — and they rendered on the MAIN creative row, in
    the structure inspector and in the creative drawer, on desktop and (once
    mobile started drawing the field) on mobile.
  */
  "held verdict",
  "held verdicts",
  "grain",
  "verdict",
  "authorized",
  "withheld",
]);
