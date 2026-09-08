/**
 * Commercial spend-unit anchor explainability (slice: anchor capture +
 * eligibility explainability).
 *
 * The engine already decides hard-action eligibility correctly and
 * fail-closed: an explicit Target CPA, or an operator AOV assumption together
 * with a Target ROAS, is high-confidence; a sufficiently sampled
 * Meta-attributed AOV is medium and eligible only when the sample is `ready`;
 * account history and the break-even fallback are never hard-action eligible.
 * That policy is NOT changed here.
 *
 * What was missing is a stable machine-readable answer to "why is this
 * withheld, and what exactly would unblock it". The only signal the profile
 * produced was one prose string —
 * `threshold baseline account_history has low confidence (meta AOV ready)` —
 * which cannot distinguish "the owner never supplied an economic anchor" from
 * "the anchor exists but its provenance is unverifiable". Operators cannot act
 * on that, and no surface can key copy off it safely.
 *
 * This module derives a discriminated taxonomy from exactly the same
 * predicates the eligibility resolver uses, so the codes can never disagree
 * with the booleans. It reads inputs only; it decides nothing new.
 */
import type {
  CommercialTargetFreshness,
  MetaAovQuality,
  SpendUnitConfidence,
  SpendUnitSource,
} from "./types";
import { classifyMetaAovQuality } from "./spend-unit-resolver";

export const COMMERCIAL_ANCHOR_CONTRACT_VERSION =
  "creative-decision-engine.commercial-anchor.v1" as const;

/** Why the commercial-threshold gate withholds a hard action. Stable wire
 * value: surfaces key copy off this, never off the prose reason. */
export type CommercialAnchorBlockerCode =
  /** The account is shadow-only; no hard action is offered at all. */
  | "shadow_only"
  /** No owner-supplied economic anchor exists and no usable Meta-derived AOV
   * stands in for one. This is the "missing owner input" case. */
  | "commercial_anchor_missing"
  /** A Meta-derived AOV is the only available anchor and its 90-day purchase
   * sample is below the `ready` bar. */
  | "commercial_anchor_sample_insufficient"
  /** A target pack exists and supplies a commercial threshold, but its
   * timestamp provenance cannot be trusted, so it is demoted. */
  | "commercial_anchor_provenance_unverified"
  /** The anchor is fine; Scale additionally needs an explicit Target ROAS. */
  | "target_roas_missing"
  /**
   * The anchor is fine; Cut has NO commercial ratio to bound a loss with.
   *
   * The code name predates D091 and is kept because persisted rows carry it.
   * Its meaning narrowed: `cutAnchorEligible` is now
   * `breakEvenAnchored || targetRoasAnchored`, so this fires only when NEITHER
   * is present — not, as the name suggests, whenever a break-even is absent.
   */
  | "break_even_roas_missing"
  /** The anchor is fine; Scale additionally needs a calibration sample. */
  | "scale_calibration_below_floor";

/** Owner-supplied (or sampled) inputs that can establish a trusted anchor. */
export type CommercialAnchorInputCode =
  | "target_cpa"
  | "operator_aov_assumption"
  | "target_roas"
  | "break_even_roas"
  | "meta_attributed_purchase_sample"
  | "commercial_target_provenance";

export type CommercialAnchorStatus =
  /**
   * The legacy Target CPA rung. Reachable ONLY on an account with no Target
   * ROAS, which is the one case where nothing can divide an average order
   * value and the CPA is the only anchor there is.
   */
  | "eligible_target_cpa"
  /**
   * RETIRED, like `eligible_observed_shopify_aov` below: readable, never
   * minted.
   *
   * `operator_aov` only ever built `operatorAovAssumption / targetRoas`, so it
   * needed a Target ROAS — and with one, `resolveSpendUnit` now sizes the unit
   * from Meta's own attributed AOV over that ratio instead, holding rather than
   * substituting when Meta has no usable AOV. No input shape reaches this rung.
   * The member stays so persisted explanations that name it still parse.
   */
  | "eligible_operator_aov"
  /**
   * The anchor is the STORE's own settled average order value divided by the
   * configured Target ROAS.
   *
   * Named separately from `eligible_meta_derived_aov` because it is a different
   * fact with different provenance: the merchant's own orders, not Meta's
   * attributed view of them, and no operator input at all. Reporting it as the
   * Meta-derived rung — which is what happened while this value did not exist —
   * told an operator the anchor came from a sampled attribution estimate on an
   * account where the number was read out of Shopify.
   */
  | "eligible_observed_shopify_aov"
  | "eligible_meta_derived_aov"
  | "blocked_missing_owner_anchor"
  | "blocked_meta_aov_sample_insufficient"
  | "blocked_provenance_unverified"
  | "blocked_shadow_only";

export type CommercialAnchorAction = "scale" | "cut" | "refresh";

export interface CommercialAnchorActionExplanation {
  eligible: boolean;
  blockerCode: CommercialAnchorBlockerCode | null;
  /** Operator-facing sentence. Derived from the code, never parsed by code. */
  operatorCopy: string | null;
}

export interface CommercialAnchorLineage {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  /** The sampled Meta-attributed AOV rung and the sample behind it. */
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  /** Scales the Meta-derived spend unit; null when not supplied. */
  attributionAovAdjustmentMultiplier: number | null;
  /** The account-history rung, which is never hard-action eligible on its own. */
  accountCpaP50?: number | null;
  accountCpaSampleCount?: number;
}

export interface CommercialAnchorExplanation {
  contractVersion: typeof COMMERCIAL_ANCHOR_CONTRACT_VERSION;
  status: CommercialAnchorStatus;
  /** True only when the commercial threshold gate itself is satisfied. Per
   * action eligibility can still be false for an independent reason. */
  thresholdEligible: boolean;
  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  /** Business currency for `spendUnit`, when the serving layer knows it.
   * Null renders as "account currency"; it must never default to USD. */
  currency: string | null;
  targetPackFreshness: CommercialTargetFreshness | null;
  targetPackUpdatedAt: string | null;
  metaAovQuality: MetaAovQuality;
  lineage: CommercialAnchorLineage;
  /** Exactly what to supply, in the order that would unblock fastest.
   * Empty when the threshold gate is satisfied. */
  missingInputs: CommercialAnchorInputCode[];
  actions: Record<CommercialAnchorAction, CommercialAnchorActionExplanation>;
}

const BLOCKER_COPY: Record<CommercialAnchorBlockerCode, string> = {
  shadow_only:
    "This account is in shadow mode, so no hard action is offered.",
  commercial_anchor_missing:
    "No commercial anchor is available. Set a Target ROAS in Commercial Truth; the average order value it divides is Meta's own attributed purchase value for this account, so no CPA or AOV needs to be typed — it resolves once Meta has attributed purchases here.",
  commercial_anchor_sample_insufficient:
    "The anchor is a Meta-attributed average order value whose 90-day purchase sample is too small to trust. It resolves as this account accumulates attributed purchases; no CPA or AOV needs to be typed.",
  commercial_anchor_provenance_unverified:
    "The configured commercial target has no verifiable update timestamp, so it cannot carry threshold authority. Re-save it in Commercial Truth to stamp its provenance.",
  target_roas_missing:
    "Scale needs an explicit Target ROAS in Commercial Truth.",
  // NOT "Cut needs an explicit break-even ROAS": since D091 a Target ROAS
  // anchors a Cut on its own, and this code is emitted only when neither ratio
  // is configured. Telling an operator to enter a break-even they do not need
  // is the same defect class as naming the wrong missing input.
  break_even_roas_missing:
    "Cut needs a Target ROAS or a break-even ROAS in Commercial Truth.",
  scale_calibration_below_floor:
    "Scale is withheld because the account calibration sample is below the quality floor.",
};

export function describeCommercialAnchorBlocker(
  code: CommercialAnchorBlockerCode,
): string {
  return BLOCKER_COPY[code];
}

function positiveFinite(value: number | null | undefined): value is number {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
  );
}

/**
 * Derives the anchor status and the per-action blocker taxonomy.
 *
 * Every boolean this receives is computed by the eligibility resolver; nothing
 * here re-derives eligibility. `thresholdEligible`,
 * `provenanceUnverified`, `scaleAnchorEligible`, `cutAnchorEligible` and
 * `calibrationReady` are passed in precisely so the codes cannot drift from
 * the decision.
 */
export function resolveCommercialAnchorExplanation(input: {
  shadowOnly: boolean;
  thresholdEligible: boolean;
  provenanceUnverified: boolean;
  scaleAnchorEligible: boolean;
  cutAnchorEligible: boolean;
  calibrationReady: boolean;
  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  metaAovQuality: MetaAovQuality;
  currency?: string | null;
  targetPackFreshness?: CommercialTargetFreshness | null;
  targetPackUpdatedAt?: string | null;
  lineage: CommercialAnchorLineage;
}): CommercialAnchorExplanation {
  const status = resolveStatus(input);
  const anchorBlocker = anchorBlockerFor(status);
  const missingInputs = resolveMissingInputs({ status, lineage: input.lineage });

  // Shadow-only withholds every hard action outright, exactly as the
  // eligibility resolver's own short-circuit does; no anchor can override it.
  const scaleEligible =
    !input.shadowOnly &&
    input.thresholdEligible &&
    input.calibrationReady &&
    input.scaleAnchorEligible;
  const cutEligible =
    !input.shadowOnly && input.thresholdEligible && input.cutAnchorEligible;
  const refreshEligible = !input.shadowOnly && input.thresholdEligible;

  const scaleBlocker: CommercialAnchorBlockerCode | null = scaleEligible
    ? null
    : anchorBlocker !== null
      ? anchorBlocker
      : !input.scaleAnchorEligible
        ? "target_roas_missing"
        : "scale_calibration_below_floor";
  const cutBlocker: CommercialAnchorBlockerCode | null = cutEligible
    ? null
    : anchorBlocker !== null
      ? anchorBlocker
      : "break_even_roas_missing";
  const refreshBlocker: CommercialAnchorBlockerCode | null = refreshEligible
    ? null
    : anchorBlocker;

  return {
    contractVersion: COMMERCIAL_ANCHOR_CONTRACT_VERSION,
    status,
    thresholdEligible: input.thresholdEligible,
    spendUnit: input.spendUnit,
    spendUnitSource: input.spendUnitSource,
    spendUnitConfidence: input.spendUnitConfidence,
    currency: input.currency ?? null,
    targetPackFreshness: input.targetPackFreshness ?? null,
    targetPackUpdatedAt: input.targetPackUpdatedAt ?? null,
    metaAovQuality: input.metaAovQuality,
    lineage: input.lineage,
    missingInputs,
    actions: {
      scale: explainAction(scaleEligible, scaleBlocker),
      cut: explainAction(cutEligible, cutBlocker),
      refresh: explainAction(refreshEligible, refreshBlocker),
    },
  };
}

function explainAction(
  eligible: boolean,
  blockerCode: CommercialAnchorBlockerCode | null,
): CommercialAnchorActionExplanation {
  return {
    eligible,
    blockerCode,
    operatorCopy: blockerCode ? describeCommercialAnchorBlocker(blockerCode) : null,
  };
}

function resolveStatus(input: {
  shadowOnly: boolean;
  thresholdEligible: boolean;
  provenanceUnverified: boolean;
  spendUnitSource: SpendUnitSource;
  metaAovQuality: MetaAovQuality;
  lineage: CommercialAnchorLineage;
}): CommercialAnchorStatus {
  if (input.shadowOnly) return "blocked_shadow_only";
  if (input.thresholdEligible) {
    if (input.spendUnitSource === "target_cpa") return "eligible_target_cpa";
    if (input.spendUnitSource === "operator_aov") return "eligible_operator_aov";
    if (input.spendUnitSource === "observed_shopify_aov") {
      return "eligible_observed_shopify_aov";
    }
    return "eligible_meta_derived_aov";
  }
  // Provenance demotion is reported ahead of the source, because re-saving the
  // existing target is a different (and cheaper) operator act than supplying a
  // new economic anchor.
  if (input.provenanceUnverified) return "blocked_provenance_unverified";
  // Keyed off the resolver's OWN judgement, never off the stored
  // `metaAovQuality` label, which arrives from the account calibration and can
  // disagree with the resolution (a stored `ready` beside a purchase count the
  // ladder judged unusable); trusting it here let a real sample-insufficiency
  // be reported as a missing owner anchor.
  if (input.spendUnitSource === "meta_derived_aov") {
    return "blocked_meta_aov_sample_insufficient";
  }
  /*
    ROUND 6: THE SOURCE ALONE NO LONGER TELLS THIN FROM ABSENT.

    `resolveSpendUnit` used to mint a low-confidence `meta_derived_aov` for a
    thin sample under a Target ROAS; it now answers `insufficient` for every
    non-`ready` tier, so both "a sample too small to divide" and "no Meta
    evidence at all" arrive here with the same source. Reporting the thin case
    as `blocked_missing_owner_anchor` would tell an operator to supply an
    anchor they have already supplied.

    So the ladder's own predicate is re-applied to the SAME two lineage facts
    it divides by — the attributed mean and its purchase count — rather than to
    the calibration's stored label. `classifyMetaAovQuality` is the shared
    classifier, so this cannot describe a sample the resolver would judge
    differently.
  */
  if (
    positiveFinite(input.lineage.targetRoas) &&
    positiveFinite(input.lineage.metaAttributedAovMean90d) &&
    classifyMetaAovQuality(
      input.lineage.metaAttributedAovPurchaseCount90d,
    ) !== "unavailable"
  ) {
    return "blocked_meta_aov_sample_insufficient";
  }
  return "blocked_missing_owner_anchor";
}

function anchorBlockerFor(
  status: CommercialAnchorStatus,
): CommercialAnchorBlockerCode | null {
  switch (status) {
    case "blocked_shadow_only":
      return "shadow_only";
    case "blocked_provenance_unverified":
      return "commercial_anchor_provenance_unverified";
    case "blocked_meta_aov_sample_insufficient":
      return "commercial_anchor_sample_insufficient";
    case "blocked_missing_owner_anchor":
      return "commercial_anchor_missing";
    default:
      return null;
  }
}

function resolveMissingInputs(input: {
  status: CommercialAnchorStatus;
  lineage: CommercialAnchorLineage;
}): CommercialAnchorInputCode[] {
  if (
    input.status === "eligible_target_cpa" ||
    input.status === "eligible_operator_aov" ||
    input.status === "eligible_observed_shopify_aov" ||
    input.status === "eligible_meta_derived_aov" ||
    input.status === "blocked_shadow_only"
  ) {
    return [];
  }
  if (input.status === "blocked_provenance_unverified") {
    return ["commercial_target_provenance"];
  }
  const { lineage } = input;
  /*
    WITH A TARGET ROAS, the canonical spend unit is Meta's own attributed
    purchase AOV divided by it, so the Meta purchase sample is the ONLY input
    that is actually absent — and the only one this hold may name.

    What it named before was `target_cpa` and `operator_aov_assumption`. Those
    two are the ladder's high rungs in `resolveSpendUnit`, so listing them was
    not meaningless; it was wrong about which absence is real. An account with a
    Target ROAS and no Meta purchases was told to go and type a CPA or an AOV —
    numbers this product deliberately does not require once a ROAS is set — while
    the fact that Meta had attributed no purchases to this account, which is what
    the resolver actually stopped on, was never mentioned at all. Both statuses
    reachable here behave the same way for the same reason: with no usable
    sample the ladder falls through (`blocked_missing_owner_anchor`), and with a
    sample below the `ready` bar it stops on the sampled rung
    (`blocked_meta_aov_sample_insufficient`). More sample is the answer to both.

    `meta_attributed_purchase_sample` is not an operator field, and naming it is
    not an instruction to type one — it is the input the engine reads
    (`metaAttributedAovPurchaseCount90d`), and `BLOCKER_COPY` above is what says
    to the operator that it accrues rather than gets configured.
  */
  if (positiveFinite(lineage.targetRoas)) {
    return ["meta_attributed_purchase_sample"];
  }
  /*
    WITHOUT A TARGET ROAS nothing can divide an average order value, so the
    legacy shape is preserved: an explicitly configured Target CPA still
    resolves an anchor on its own, and supplying the Target ROAS is the other
    way out — it makes Meta's own attributed AOV divisible.

    `operator_aov_assumption` IS NOT LISTED, and its absence is the point.
    It stopped being a way out when `operator_aov` was retired as a rung of
    `resolveSpendUnit`: an AOV assumption plus a Target ROAS now resolves the
    PLATFORM AOV, not the operator's, and without a Target ROAS an AOV divides
    by nothing at all. So on this branch it resolves nothing in either
    direction, and an operator who typed one on the strength of this list would
    watch the hold stay exactly where it was. A missing-input list is a list of
    things that WOULD work; naming an input that cannot is the same defect as
    naming the wrong cause.

    The code stays in `CommercialAnchorInputCode` so a persisted hold that named
    it still parses and still renders its sentence.
  */
  const missing: CommercialAnchorInputCode[] = [];
  if (!positiveFinite(lineage.targetCpa)) missing.push("target_cpa");
  // Reached unconditionally here, because the branch above already returned for
  // every lineage that carries a Target ROAS.
  missing.push("target_roas");
  if (input.status === "blocked_meta_aov_sample_insufficient") {
    missing.push("meta_attributed_purchase_sample");
  }
  return missing;
}
