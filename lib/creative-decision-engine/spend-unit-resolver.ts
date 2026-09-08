import type {
  MetaAovQuality,
  SpendUnitConfidence,
  SpendUnitEvidence,
  SpendUnitSource,
} from "./types";

export interface SpendUnitResolution {
  spendUnit: number | null;
  source: SpendUnitSource;
  confidence: SpendUnitConfidence;
  evidence: SpendUnitEvidence;
  hardEligibleByDefault: boolean;
}

export function classifyMetaAovQuality(purchaseCount: number): MetaAovQuality {
  if (!Number.isFinite(purchaseCount) || purchaseCount <= 0) {
    return "unavailable";
  }
  if (purchaseCount < 5) return "unstable";
  if (purchaseCount < 20) return "low_sample";
  return "ready";
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function baseEvidence(input: {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  observedShopifyAov?: number | null;
  observedShopifyAovOrderCount?: number;
  observedShopifyAovStatus?: string | null;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
}): SpendUnitEvidence {
  const warnings: string[] = [];

  const metaAovQuality = classifyMetaAovQuality(
    input.metaAttributedAovPurchaseCount90d,
  );
  /**
   * Can Meta's own attributed AOV stand in for a typed one? Same two
   * predicates the `meta_derived_aov` rung below divides by, so the warning
   * cannot claim a unit the ladder will not build.
   */
  const metaAovCanSupplyUnit =
    metaAovQuality !== "unavailable" &&
    positiveFinite(input.metaAttributedAovMean90d);

  if (!positiveFinite(input.targetCpa)) warnings.push("target_cpa_missing");
  if (!positiveFinite(input.targetRoas)) warnings.push("target_roas_missing");
  /*
    `operator_aov_missing` reports an AOV INVENTORY, not a missing anchor.

    It fires when no average order value is readable from either book the
    resolver is handed: the operator has typed no assumption AND Meta has
    attributed no usable purchase AOV. That is still worth naming on a surface,
    because it is the state in which supplying a Target ROAS would ALSO not
    complete the account.

    It is deliberately no longer a claim that typing an operator AOV would
    resolve anything. `operator_aov` is not a rung of the ladder below any more
    (see `resolveSpendUnit`): with a Target ROAS the unit is Meta's own
    attributed AOV over that ratio, and without one no AOV of any provenance can
    be divided. The commercial-anchor surface says which input is actually
    absent — `resolveMissingInputs` in `commercial-anchor.ts`.

    The store's own AOV deliberately does NOT suppress it. It did while
    `observed_shopify_aov` was a rung; it is no longer a rung at all, so letting
    it silence this warning would report an anchor the resolver cannot build.
  */
  if (
    !positiveFinite(input.operatorAovAssumption) &&
    !metaAovCanSupplyUnit
  ) {
    warnings.push("operator_aov_missing");
  }
  if (
    input.observedShopifyAovStatus &&
    input.observedShopifyAovStatus !== "observed"
  ) {
    warnings.push(`observed_shopify_aov_${input.observedShopifyAovStatus}`);
  }

  if (metaAovQuality === "unavailable") {
    warnings.push("meta_aov_unavailable");
  } else if (metaAovQuality === "unstable") {
    warnings.push("meta_aov_unstable");
  } else if (metaAovQuality === "low_sample") {
    warnings.push("meta_aov_low_sample");
  }

  if (input.accountCpaSampleCount < 20) {
    warnings.push("account_cpa_sample_low");
  }

  return {
    targetCpa: input.targetCpa,
    operatorAovAssumption: input.operatorAovAssumption,
    observedShopifyAov: input.observedShopifyAov ?? null,
    observedShopifyAovOrderCount: input.observedShopifyAovOrderCount ?? 0,
    observedShopifyAovStatus: input.observedShopifyAovStatus ?? null,
    metaAttributedAovMean90d: input.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d:
      input.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: input.metaAttributedRevenue90d,
    targetRoas: input.targetRoas,
    breakEvenRoas: input.breakEvenRoas,
    accountCpaP50: input.accountCpaP50,
    accountCpaSampleCount: input.accountCpaSampleCount,
    warnings,
  };
}

function resolved(input: {
  spendUnit: number | null;
  source: SpendUnitSource;
  confidence: SpendUnitConfidence;
  evidence: SpendUnitEvidence;
  hardEligibleByDefault: boolean;
}): SpendUnitResolution {
  return input;
}

export function resolveSpendUnit(input: {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  /**
   * Store AOV in MAJOR units, already proven usable by
   * `resolveObservedShopifyAov` — same currency as the ad account, enough
   * orders, a closed store-day window.
   *
   * CONTEXTUAL ONLY. It is copied into `evidence.observedShopifyAov` so a
   * withheld or Meta-derived unit can be read against what the merchant's own
   * books said, and it chooses no rung: see the ladder note in
   * `resolveSpendUnit` for why a Meta decision is not sized from it.
   */
  observedShopifyAov?: number | null;
  observedShopifyAovOrderCount?: number;
  observedShopifyAovStatus?: string | null;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  /**
   * ACCEPTED AND DELIBERATELY INERT. Pinned to 1 for every rung below.
   *
   * This account setting used to multiply Meta's attributed AOV before the
   * division, on both the `meta_derived_aov` rung and the `break_even_aov`
   * rung. That made it authoritative arithmetic: the same account, the same
   * Meta sample and the same Target ROAS produced a different spend unit, a
   * different maturity floor, different thresholds and a different decision
   * identity purely because an attribution knob had been typed.
   *
   * The canonical rule admits exactly one authoritative unit when a Target
   * ROAS exists — ready Meta platform-attributed AOV over that ratio — and no
   * adjustment factor is part of it. The field stays on the input because ~20
   * callers and several replay scripts pass it, and dropping it from the type
   * would silently change what those scripts believe they configured; it is
   * ignored here instead, which is the same outcome stated once.
   *
   * It is not written into `SpendUnitEvidence` either (see `baseEvidence`), so
   * it cannot reach a hash through the evidence door it never used.
   */
  attributionAovAdjustmentMultiplier?: number;
}): SpendUnitResolution {
  const evidence = baseEvidence(input);
  const metaAovQuality = classifyMetaAovQuality(
    input.metaAttributedAovPurchaseCount90d,
  );
  const targetRoas = input.targetRoas;
  const targetCpa = input.targetCpa;
  const metaAttributedAovMean90d = input.metaAttributedAovMean90d;
  /**
   * The one predicate that says WHICH CASE this account is in, because the two
   * cases have different first rungs and the difference is the whole rule.
   */
  const targetRoasAnchored = positiveFinite(targetRoas);
  /**
   * Same two predicates `baseEvidence` uses for `metaAovCanSupplyUnit`, so the
   * warnings cannot describe an AOV this ladder would refuse to divide.
   */
  const metaAovUsable =
    metaAovQuality !== "unavailable" && positiveFinite(metaAttributedAovMean90d);

  /*
    CASE 1 — A TARGET ROAS IS CONFIGURED.

    Meta's own attributed purchase AOV over that ratio is the canonical
    money-per-purchase unit for a Meta decision, and it is the ONLY hard basis
    this case has. An operator-typed Target CPA, an operator AOV assumption and
    the store's own AOV are all present in `evidence` and none of them chooses
    the rung.

    This is a REORDERING: `target_cpa` and `operator_aov` used to sit above this
    rung unconditionally, so an account that had configured both a Target ROAS
    and a legacy Target CPA was sized from the CPA, and the served Decision
    Center and the native producer in `jobs/ad-calibration-job.ts` had to be
    reordered together or they would answer "what is a purchase worth" with two
    different numbers for the same account — the exact class of disagreement
    that produced 117 `native_target_authority_mismatch` runs in 24h.

    When the Meta AOV is NOT usable this case HOLDS: it falls to the soft rungs
    below, which are never `hardEligibleByDefault`, and otherwise to
    `insufficient`. It deliberately does not reach for `targetCpa` here. Taking
    the CPA would mint `confidence: "high"` and a hard-action grant on an
    account where Meta attributed no purchases at all, which reports the absence
    as an anchor instead of as an absence — `evidence.warnings` already names it
    (`meta_aov_unavailable`), and the resolved source must not contradict that.
  */
  if (targetRoasAnchored) {
    /*
      READY OR NOTHING, AND NO FALL-THROUGH.

      Two holes were still open in this branch and both ended somewhere the
      canonical rule forbids.

      1. `metaAovUsable` accepted `unstable` and `low_sample`, so a five-
         purchase account still got `spendUnit = aov / targetRoas` — a real
         number, carried into `AccountDecisionProfile.spendUnit`, into the
         maturity/threshold ladder built from it in `resolveThresholds`, and
         into the canonical evaluation hash. `hardEligibleByDefault: false`
         only closed the ACTION gate; the arithmetic downstream was already
         sized from a sample the rule calls insufficient.
      2. When the AOV was not usable at all this branch simply fell out of the
         `if` and continued to the soft rungs below — `account_history`
         (the account's own median CPA) and then `break_even_aov`. Both are
         money-per-purchase units built from something other than ready Meta
         AOV, on an account whose Target ROAS says only ready Meta AOV may
         answer. `hardEligibleByDefault: false` again bounded the action and
         again left a number where there must be none.

      With a positive Target ROAS the answer is the READY unit or
      `insufficient`. `evidence.warnings` already names which of the three
      states the account is in (`meta_aov_unavailable` / `_unstable` /
      `_low_sample`), so the hold is reported rather than silent.
    */
    if (metaAovUsable && metaAovQuality === "ready") {
      // The platform AOV, UNADJUSTED. See the note on
      // `attributionAovAdjustmentMultiplier` in this function's input type:
      // the canonical unit is the ready Meta-attributed AOV over the target
      // ratio, and nothing scales it.
      return resolved({
        spendUnit: metaAttributedAovMean90d / targetRoas,
        source: "meta_derived_aov",
        confidence: "medium",
        evidence,
        hardEligibleByDefault: true,
      });
    }
    return resolved({
      spendUnit: null,
      source: "insufficient",
      confidence: "insufficient",
      evidence,
      hardEligibleByDefault: false,
    });
  } else if (positiveFinite(targetCpa)) {
    /*
      CASE 2 — NO TARGET ROAS.

      With no ratio to divide an average order value by, neither Meta's AOV nor
      an operator's assumption can build a unit at all, so a legacy explicitly
      configured Target CPA is the only anchor there is and it legitimately
      governs. This branch is unchanged, and it is the compatibility the
      reordering above is careful not to take away.
    */
    return resolved({
      spendUnit: targetCpa,
      source: "target_cpa",
      confidence: "high",
      evidence,
      hardEligibleByDefault: true,
    });
  }

  /*
    NEITHER `operator_aov` NOR `observed_shopify_aov` IS A RUNG ANY MORE, and
    they are absent here for two different reasons.

    `observed_shopify_aov` was retired first. It sat between the operator's
    assumption and Meta's own attributed AOV with `confidence: "high"` and
    `hardEligibleByDefault: true`, which — through `commercialThresholdEligible`
    in `account-decision-profile.ts`, whose high branch does not consult
    `metaAovQuality` — granted the commercial threshold on an account with no
    Meta purchase sample at all. It is not the canonical unit for a Meta
    decision: the merchant's settled orders are a different book, and dividing
    Meta spend by them sizes Meta money from revenue Meta never attributed. The
    native hard-decision path retired the same basis for the same reason — see
    `NativeAdSpendUnitAuthorityBasis` in
    `lib/creative-decision-engine/jobs/ad-calibration-job.ts` and the production
    incident recorded on it.

    `operator_aov` is retired by the reordering above rather than by a separate
    judgement about the number itself. It only ever built a unit as
    `operatorAovAssumption / targetRoas`, so it needed a Target ROAS to exist —
    and in CASE 1 the platform AOV now takes that ratio whenever Meta can supply
    an AOV, while a Meta AOV that cannot be supplied is a hold rather than a
    substitution. There is no remaining input shape that reaches it.

    Both members stay in `SpendUnitSource` (`types.ts`) so profiles persisted
    while they were rungs still parse and still render their own provenance.
    Neither is ever minted again. The store's number is additionally still
    CARRIED — `evidence.observedShopifyAov`, its order count and its status — as
    contextual evidence beside whatever unit was built.
  */

  /*
    THE SOFT RUNGS BELOW ARE THE NO-TARGET-ROAS COMPATIBILITY PATH ONLY.

    `targetRoasAnchored` returns above in every case, so nothing that reaches
    here has a positive Target ROAS. That is what makes `account_history` (the
    account's median CPA) and `break_even_aov` safe to keep: they are the
    legacy path for an account that never typed the ratio, and the rule the
    product enforces is about accounts that did.
  */
  if (positiveFinite(input.accountCpaP50) && input.accountCpaSampleCount >= 20) {
    return resolved({
      spendUnit: input.accountCpaP50,
      source: "account_history",
      confidence: positiveFinite(input.targetRoas) ? "medium" : "low",
      evidence,
      hardEligibleByDefault: false,
    });
  }

  if (
    positiveFinite(input.metaAttributedAovMean90d) &&
    positiveFinite(input.breakEvenRoas)
  ) {
    return resolved({
      // Unadjusted for the same reason as the rung above: this is the
      // commercial stop-loss basis, and an attribution knob must not move
      // where loss begins.
      spendUnit: input.metaAttributedAovMean90d / input.breakEvenRoas,
      source: "break_even_aov",
      confidence: "low",
      evidence,
      hardEligibleByDefault: false,
    });
  }

  return resolved({
    spendUnit: null,
    source: "insufficient",
    confidence: "insufficient",
    evidence,
    hardEligibleByDefault: false,
  });
}
