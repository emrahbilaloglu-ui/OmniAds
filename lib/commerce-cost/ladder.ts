import type {
  CommerceCostStructure,
  CostAmountState,
  CostBase,
  CostCoverageSummary,
  CostDecisionClass,
  CostDecisionClassKey,
  CostDecisionGate,
  CostDecisionReadiness,
  CostFamily,
  CostFamilyRollup,
  CostLadderState,
  CostLayer,
  CostLedgerEvent,
  CostResolutionResult,
  CostStructureIssue,
  CostTaxTreatment,
  CostTruthGrade,
  CostUnavailableReason,
  EconomicsLadder,
  EconomicsLadderRung,
} from "@/src/types/commerce-cost";
import { roundMoney } from "./money";
import {
  CONTRIBUTION_COST_FAMILIES,
  PRODUCT_COST_FAMILIES,
  costFamilyLayer,
  familiesInLayer,
} from "./taxonomy";

/**
 * From resolved costs to the numbers a decision is allowed to use.
 *
 * The ladder refuses to state a rung whose inputs are incomplete. A
 * contribution figure computed by treating an unknown cost as zero is the most
 * expensive kind of wrong, because it reads as profit and gets scaled. Missing
 * families are named instead, and the per-family breakdown still shows
 * everything that IS known.
 */

const MISSING_STATES: readonly CostAmountState[] = ["unknown", "conflict", "unavailable"];

/** Bases that carry tax, so a cost net of tax is not comparable with them. */
const TAX_INCLUSIVE_BASES: readonly CostBase[] = ["order_total_incl_tax", "order_payment_captured"];
const NUMERIC_STATES: readonly CostAmountState[] = ["value", "zero"];

/** Coverage is revenue-weighted: a cheap SKU cannot mask an expensive gap. */
export function summarizeCostCoverage(args: {
  resolutions: readonly CostResolutionResult[];
  structure: CommerceCostStructure;
}): CostCoverageSummary {
  const { resolutions, structure } = args;

  let totalNetSales = 0;
  let costedNetSales = 0;
  let lineCount = 0;
  let costedLineCount = 0;
  let resolvedAmount = 0;
  let estimatedAmount = 0;

  const unknownFamilies = new Set<CostFamily>();
  const conflictFamilies = new Set<CostFamily>();
  const unavailableFamilies = new Map<CostFamily, CostUnavailableReason>();
  const familyNetSales = new Map<CostFamily, { covered: number; total: number }>();

  for (const resolution of resolutions) {
    const entriesByLine = new Map<string, typeof resolution.entries>();
    for (const entry of resolution.entries) {
      entriesByLine.set(entry.lineId, [...(entriesByLine.get(entry.lineId) ?? []), entry]);
    }

    for (const line of resolution.lines) {
      const netSales = line.netSales ?? 0;
      lineCount += 1;
      totalNetSales += netSales;
      const entries = entriesByLine.get(line.lineId) ?? [];
      const numericById = new Map(
        entries
          .filter((entry) => NUMERIC_STATES.includes(entry.state))
          .map((entry) => [entry.ownerComponentId ?? entry.family, entry]),
      );

      const productEntries = entries.filter((entry) =>
        PRODUCT_COST_FAMILIES.includes(entry.family),
      );
      // A line that cannot carry a product cost at all — a gift card, a
      // digital good — is not an uncovered line. Counting it as one made a
      // complete structure look half-known.
      const productApplicable = productEntries.some(
        (entry) => entry.state !== "not_applicable" && entry.state !== "not_tracked",
      );
      const productCosted = productEntries.some((entry) => {
        if (NUMERIC_STATES.includes(entry.state)) return true;
        // Embedded product cost counts when its host carries a real number.
        return entry.state === "embedded" && numericById.has(entry.ownerComponentId ?? "");
      });
      if (!productApplicable) {
        lineCount -= 1;
        totalNetSales -= netSales;
      } else if (productCosted) {
        costedLineCount += 1;
        costedNetSales += netSales;
      }

      // One line counts once per family, however many slots that family has.
      const familiesCountedForLine = new Set<CostFamily>();
      const familiesCoveredForLine = new Set<CostFamily>();
      for (const entry of entries) {
        if (entry.state !== "not_applicable" && entry.state !== "not_tracked") {
          familiesCountedForLine.add(entry.family);
        }
        if (
          NUMERIC_STATES.includes(entry.state) ||
          (entry.state === "embedded" && numericById.has(entry.ownerComponentId ?? ""))
        ) {
          familiesCoveredForLine.add(entry.family);
        }
      }
      for (const family of new Set([...familiesCountedForLine, ...familiesCoveredForLine])) {
        const bucket = familyNetSales.get(family) ?? { covered: 0, total: 0 };
        familyNetSales.set(family, {
          covered: bucket.covered + (familiesCoveredForLine.has(family) ? netSales : 0),
          total: bucket.total + (familiesCountedForLine.has(family) ? netSales : 0),
        });
      }

      for (const entry of entries) {
        if (entry.state === "unknown") unknownFamilies.add(entry.family);
        if (entry.state === "conflict") conflictFamilies.add(entry.family);
        if (entry.state === "unavailable" && entry.unavailableReason) {
          unavailableFamilies.set(entry.family, entry.unavailableReason);
        }
        if (entry.state === "value" && entry.amount !== null) {
          resolvedAmount += Math.abs(entry.amount);
          if (entry.estimated) estimatedAmount += Math.abs(entry.amount);
        }
      }
    }
  }

  const familyCoverage: Partial<Record<CostFamily, number | null>> = {};
  for (const [family, bucket] of familyNetSales) {
    familyCoverage[family] = bucket.total > 0 ? bucket.covered / bucket.total : null;
  }

  return {
    // Revenue-weighted, so a cheap SKU cannot mask an expensive gap. A window
    // with no revenue at all (an all-free-gift order) still knows how many of
    // its lines carry a cost, so it falls back to counting them rather than
    // claiming to know nothing.
    productCostCoverage:
      totalNetSales > 0
        ? costedNetSales / totalNetSales
        : lineCount > 0
          ? costedLineCount / lineCount
          : null,
    costedNetSales: roundMoney(costedNetSales),
    totalNetSales: roundMoney(totalNetSales),
    lineCount,
    costedLineCount,
    estimatedShare: resolvedAmount > 0 ? estimatedAmount / resolvedAmount : null,
    unknownFamilies: [...unknownFamilies].sort(),
    conflictFamilies: [...conflictFamilies].sort(),
    unavailableFamilies: [...unavailableFamilies.entries()]
      .map(([family, reason]) => ({ family, reason }))
      .sort((left, right) => left.family.localeCompare(right.family)),
    notTrackedFamilies: [...(structure.notTracked ?? [])].sort(),
    familyCoverage,
  };
}

function rollupFamilies(
  events: readonly CostLedgerEvent[],
  coverage: CostCoverageSummary,
): CostFamilyRollup[] {
  // Window-level costs never reach a line, so their reason is on the event.
  const bucketReasons = new Map<CostFamily, CostUnavailableReason>();
  for (const event of events) {
    if (event.unavailableReason) bucketReasons.set(event.family, event.unavailableReason);
  }
  const totals = new Map<
    CostFamily,
    { amount: number | null; estimated: number; states: Set<CostAmountState> }
  >();

  for (const event of events) {
    const bucket = totals.get(event.family) ?? { amount: null, estimated: 0, states: new Set() };
    bucket.states.add(event.state);
    if (NUMERIC_STATES.includes(event.state) && event.amount !== null) {
      bucket.amount = (bucket.amount ?? 0) + event.amount;
      if (event.estimated) bucket.estimated += Math.abs(event.amount);
    }
    totals.set(event.family, bucket);
  }

  return [...totals.entries()]
    .map(([family, bucket]) => {
      const worst = MISSING_STATES.find((state) => bucket.states.has(state));
      const unavailable = coverage.unavailableFamilies.find((entry) => entry.family === family);
      // A family whose events are all stateful non-values reports that state,
      // not "unknown": embedded money sits in a host, and not-applicable or
      // not-tracked are answers rather than gaps.
      const declared = (["embedded", "not_applicable", "not_tracked"] as const).find((state) =>
        bucket.states.has(state),
      );
      return {
        family,
        layer: costFamilyLayer(family),
        amount: bucket.amount === null ? null : roundMoney(bucket.amount),
        estimatedAmount: roundMoney(bucket.estimated),
        state:
          worst ??
          (bucket.amount === null
            ? declared ?? "unknown"
            : bucket.amount === 0
              ? "zero"
              : "value"),
        coverage: coverage.familyCoverage?.[family] ?? null,
        unavailableReason: unavailable?.reason ?? bucketReasons.get(family) ?? null,
      } satisfies CostFamilyRollup;
    })
    .sort((left, right) => left.family.localeCompare(right.family));
}

interface ClassBucket {
  amount: number | null;
  estimated: number;
  states: Set<CostAmountState>;
  /** Tax treatments stated by configuration, which the grade depends on. */
  taxTreatments: Set<CostTaxTreatment>;
  /** A measured amount whose importer did not state a tax treatment. */
  observedTaxUnspecified: boolean;
  /** Families holding this one's money, when its events are `embedded`. */
  hostFamilies: Set<CostFamily>;
  unavailableReason: CostUnavailableReason | null;
}

const CONTRIBUTION_CLASS: ReadonlySet<CostDecisionClass> = new Set(["contribution"]);
const OPERATING_CLASS: ReadonlySet<CostDecisionClass> = new Set(["operating"]);
const OPERATING_OR_CONTRIBUTION: ReadonlySet<CostDecisionClass> = new Set([
  "contribution",
  "operating",
]);

/**
 * Costs bucketed by family AND by the decision class they were declared with.
 *
 * The class is part of the contract: a cost the owner marked `operating` must
 * not move a marginal break-even, and an `informational` one must not reach a
 * rung at all. Summing by family alone silently ignored both.
 */
function bucketEvents(
  events: readonly CostLedgerEvent[],
): Map<string, ClassBucket & { family: CostFamily; decisionClass: CostDecisionClass }> {
  const buckets = new Map<
    string,
    ClassBucket & { family: CostFamily; decisionClass: CostDecisionClass }
  >();
  for (const event of events) {
    const key = `${event.family}::${event.decisionClass}`;
    const bucket = buckets.get(key) ?? {
      family: event.family,
      decisionClass: event.decisionClass,
      amount: null,
      estimated: 0,
      states: new Set<CostAmountState>(),
      taxTreatments: new Set<CostTaxTreatment>(),
      observedTaxUnspecified: false,
      hostFamilies: new Set<CostFamily>(),
      unavailableReason: null,
    };
    bucket.states.add(event.state);
    if (event.hostFamily) bucket.hostFamilies.add(event.hostFamily);
    if (event.unavailableReason) bucket.unavailableReason = event.unavailableReason;
    if (NUMERIC_STATES.includes(event.state) && event.amount !== null) {
      bucket.amount = (bucket.amount ?? 0) + event.amount;
      // Signed, so a reversal reduces the estimated portion instead of
      // inflating it past the amount it is a portion of.
      if (event.estimated) bucket.estimated += event.amount;
      const measured = event.evidence === "observed_exact" || event.evidence === "observed_allocated";
      if (measured && (event.taxTreatment ?? "unknown") === "unknown") {
        bucket.observedTaxUnspecified = true;
      } else {
        bucket.taxTreatments.add(event.taxTreatment ?? "unknown");
      }
    }
    buckets.set(key, bucket);
  }
  return buckets;
}

function rungFromBuckets(
  families: readonly CostFamily[],
  buckets: ReturnType<typeof bucketEvents>,
  allowedClasses: ReadonlySet<CostDecisionClass>,
): { cost: number | null; estimated: number; included: CostFamily[]; missing: CostFamily[] } {
  const included: CostFamily[] = [];
  const missing: CostFamily[] = [];
  let cost = 0;
  let estimated = 0;
  let seen = false;

  for (const bucket of buckets.values()) {
    if (!families.includes(bucket.family)) continue;
    if (!allowedClasses.has(bucket.decisionClass)) continue;

    const missingState = MISSING_STATES.find((state) => bucket.states.has(state));
    // A family the owner does not track is an acknowledged gap, not a zero:
    // summing it as 0 understated the rate at the top grade. Saying a family
    // genuinely costs nothing is done with a component whose amount is 0.
    const acknowledgedGap = bucket.states.has("not_tracked");
    // Embedded money sits in another family. That only accounts for this rung
    // if the holder is inside this rung too; otherwise the rung is short of it.
    const embeddedElsewhere =
      bucket.states.has("embedded") &&
      ![...bucket.hostFamilies].some((host) => families.includes(host));

    if (missingState || acknowledgedGap || embeddedElsewhere) {
      seen = true;
      if (!missing.includes(bucket.family)) missing.push(bucket.family);
      continue;
    }
    // Nothing but `not_applicable` (or embedded money already counted inside
    // this rung's host) carries no number and leaves nothing missing.
    if (bucket.amount === null) {
      if (bucket.states.has("embedded")) seen = true;
      continue;
    }
    seen = true;
    if (!included.includes(bucket.family)) included.push(bucket.family);
    cost += bucket.amount;
    estimated += bucket.estimated;
  }

  return {
    cost: seen && missing.length === 0 ? roundMoney(cost) : null,
    // Never more than the amount it is a portion of, and never negative.
    estimated: Math.min(Math.max(0, roundMoney(estimated)), Math.abs(roundMoney(cost))),
    included: included.sort(),
    missing: missing.sort(),
  };
}

function rungState(
  amount: number | null,
  missing: readonly CostFamily[],
  estimated: number,
): CostLadderState {
  if (missing.length > 0) return "partial";
  if (amount === null) return "unavailable";
  if (estimated > 0) return "estimated";
  return "complete";
}

function gate(allowed: boolean, ceiling: CostDecisionGate["ceiling"], reason: string): CostDecisionGate {
  return { allowed, ceiling, reason };
}

export interface EconomicsLadderRequest {
  window: { startDate: string; endDate: string; days: number };
  reportingCurrency: string;
  structure: CommerceCostStructure;
  /** Sale, refund and period events for the window. */
  events: readonly CostLedgerEvent[];
  coverage: CostCoverageSummary;
  revenue: { netProductSales: number | null; rateBase?: CostBase | null };
  adSpend?: number | null;
  /** The operator's confirmed target. Authoritative whenever present. */
  targetRoas?: number | null;
  /** Optional. Its absence must never block a decision. */
  aovAssumption?: number | null;
  structureIssues?: readonly CostStructureIssue[];
}

export function buildEconomicsLadder(request: EconomicsLadderRequest): EconomicsLadder {
  const { window, reportingCurrency, structure, events, coverage, revenue } = request;
  const diagnostics: string[] = [];
  const rollups = rollupFamilies(events, coverage);
  const buckets = bucketEvents(events);

  const productRung = rungFromBuckets(PRODUCT_COST_FAMILIES, buckets, CONTRIBUTION_CLASS);
  const contributionRung = rungFromBuckets(
    CONTRIBUTION_COST_FAMILIES,
    buckets,
    CONTRIBUTION_CLASS,
  );
  const marketingOther = rungFromBuckets(
    familiesInLayer("marketing"),
    buckets,
    OPERATING_OR_CONTRIBUTION,
  );
  const fixedRung = rungFromBuckets(familiesInLayer("fixed"), buckets, OPERATING_OR_CONTRIBUTION);
  // A variable cost the owner declared `operating` still belongs in operating
  // profit; the class only keeps it out of the marginal rate.
  const operatingExtras = rungFromBuckets(CONTRIBUTION_COST_FAMILIES, buckets, OPERATING_CLASS);
  const informationalFamilies = [
    ...new Set(
      [...buckets.values()]
        .filter((bucket) => bucket.decisionClass === "informational")
        .map((bucket) => bucket.family),
    ),
  ].sort();
  if (informationalFamilies.length > 0) {
    diagnostics.push(`informational_excluded:${informationalFamilies.join(",")}`);
  }

  const netProductSales =
    typeof revenue.netProductSales === "number" && Number.isFinite(revenue.netProductSales)
      ? revenue.netProductSales
      : null;
  const adSpend =
    typeof request.adSpend === "number" && Number.isFinite(request.adSpend)
      ? request.adSpend
      : null;

  const preMarketingAmount =
    netProductSales !== null && contributionRung.cost !== null
      ? roundMoney(netProductSales - contributionRung.cost)
      : null;
  if (contributionRung.missing.length > 0) {
    diagnostics.push(`contribution_missing_families:${contributionRung.missing.join(",")}`);
  }
  if (netProductSales === null) diagnostics.push("net_product_sales_unavailable");

  const postMarketingAmount =
    preMarketingAmount !== null && adSpend !== null && marketingOther.missing.length === 0
      ? roundMoney(preMarketingAmount - adSpend - (marketingOther.cost ?? 0))
      : null;
  if (adSpend === null) diagnostics.push("ad_spend_unavailable");

  // Nothing here turns an unquantified cost into a zero: to say overheads are
  // genuinely nil, state a component whose amount is 0.
  const fixedCost = fixedRung.cost;
  const operatingAmount =
    postMarketingAmount !== null && fixedCost !== null && operatingExtras.missing.length === 0
      ? roundMoney(postMarketingAmount - fixedCost - (operatingExtras.cost ?? 0))
      : null;
  if (fixedCost === null) diagnostics.push("fixed_costs_unavailable");
  if (fixedRung.missing.length > 0) {
    diagnostics.push(`fixed_missing_families:${fixedRung.missing.join(",")}`);
  }

  const rungs: EconomicsLadder["rungs"] = {
    productCost: {
      amount: productRung.cost,
      state: rungState(productRung.cost, productRung.missing, productRung.estimated),
      estimatedAmount: productRung.estimated,
      includedFamilies: productRung.included,
      missingFamilies: productRung.missing,
    },
    preMarketingContribution: {
      amount: preMarketingAmount,
      state: rungState(preMarketingAmount, contributionRung.missing, contributionRung.estimated),
      estimatedAmount: contributionRung.estimated,
      includedFamilies: contributionRung.included,
      missingFamilies: contributionRung.missing,
    },
    postMarketingContribution: {
      amount: postMarketingAmount,
      state: rungState(
        postMarketingAmount,
        [...contributionRung.missing, ...marketingOther.missing],
        contributionRung.estimated + marketingOther.estimated,
      ),
      estimatedAmount: roundMoney(contributionRung.estimated + marketingOther.estimated),
      includedFamilies: [...contributionRung.included, ...marketingOther.included],
      missingFamilies: [...contributionRung.missing, ...marketingOther.missing],
    },
    operatingProfit: {
      amount: operatingAmount,
      state: rungState(
        operatingAmount,
        [...contributionRung.missing, ...marketingOther.missing, ...fixedRung.missing],
        contributionRung.estimated + marketingOther.estimated + fixedRung.estimated,
      ),
      estimatedAmount: roundMoney(
        contributionRung.estimated + marketingOther.estimated + fixedRung.estimated,
      ),
      includedFamilies: [
        ...contributionRung.included,
        ...marketingOther.included,
        ...fixedRung.included,
        ...operatingExtras.included,
      ],
      missingFamilies: [
        ...contributionRung.missing,
        ...marketingOther.missing,
        ...fixedRung.missing,
        ...operatingExtras.missing,
      ],
    },
  };

  // Only variable, order-driven cost belongs in a marginal rate. Fixed and
  // marketing layers are structurally excluded above.
  const variableCostRate =
    netProductSales !== null && netProductSales > 0 && contributionRung.cost !== null
      ? contributionRung.cost / netProductSales
      : null;
  if (netProductSales !== null && netProductSales <= 0) {
    diagnostics.push("net_product_sales_not_positive");
  }
  if (contributionRung.cost !== null && contributionRung.cost < 0) {
    // Reversals exceeded the costs booked in this window, which means the
    // revenue figure and the reversals are not the same window's.
    diagnostics.push("contribution_cost_negative_after_reversals");
  }
  const rateUsable = variableCostRate !== null && variableCostRate >= 0 && variableCostRate < 1;
  const breakEvenRoasSuggested = rateUsable ? roundMoney(1 / (1 - variableCostRate!)) : null;
  if (variableCostRate !== null && variableCostRate >= 1) {
    diagnostics.push("variable_cost_rate_at_or_above_revenue");
  }
  if (variableCostRate !== null && variableCostRate < 0) {
    diagnostics.push("variable_cost_rate_negative");
  }
  const aov =
    typeof request.aovAssumption === "number" && Number.isFinite(request.aovAssumption)
      ? request.aovAssumption
      : null;
  // Refused for the same rate that refuses a break-even ROAS: a CPA derived
  // from an out-of-range rate is a negative target.
  const breakEvenCpaSuggested =
    aov !== null && rateUsable ? roundMoney(aov * (1 - variableCostRate!)) : null;

  // Tax treatment is part of the contract, so a cost whose treatment is
  // unknown or inconsistent with its neighbours cannot be top graded: a cost
  // stated gross of recoverable tax is overstated against a net revenue base
  // by the whole tax rate, and nothing here can convert between the two.
  const contributionTaxTreatments = new Set<CostTaxTreatment>();
  let observedTaxUnspecified = false;
  let excludedUnknownContribution = false;
  for (const bucket of buckets.values()) {
    if (!CONTRIBUTION_COST_FAMILIES.includes(bucket.family)) continue;
    if (!CONTRIBUTION_CLASS.has(bucket.decisionClass)) {
      // A contribution cost the owner moved out of the marginal rate still
      // has to be resolvable, or the picture is incomplete.
      if (MISSING_STATES.some((state) => bucket.states.has(state))) {
        excludedUnknownContribution = true;
      }
      continue;
    }
    if (bucket.observedTaxUnspecified) observedTaxUnspecified = true;
    for (const treatment of bucket.taxTreatments) contributionTaxTreatments.add(treatment);
  }
  const taxTreatmentUnknown = contributionTaxTreatments.has("unknown");
  const taxTreatmentMixed = contributionTaxTreatments.size > 1;
  if (taxTreatmentUnknown) diagnostics.push("cost_tax_treatment_unknown");
  if (taxTreatmentMixed) {
    diagnostics.push(`cost_tax_treatment_mixed:${[...contributionTaxTreatments].sort().join(",")}`);
  }
  if (observedTaxUnspecified) diagnostics.push("cost_tax_treatment_unspecified_observed");
  if (excludedUnknownContribution) diagnostics.push("excluded_contribution_family_unknown");
  // A cost net of tax over a revenue base that carries tax understates the
  // rate by about the tax rate — the same error the cost-side rule catches.
  const revenueBaseCarriesTax = Boolean(
    revenue.rateBase && TAX_INCLUSIVE_BASES.includes(revenue.rateBase),
  );
  const taxBasesDisagree =
    revenueBaseCarriesTax && contributionTaxTreatments.has("net_of_recoverable_tax");
  if (revenueBaseCarriesTax) {
    diagnostics.push(`revenue_base_includes_tax:${revenue.rateBase}`);
  }
  if (taxBasesDisagree) diagnostics.push("cost_and_revenue_tax_bases_disagree");

  const hasStructureError = (request.structureIssues ?? []).some(
    (issue) => issue.severity === "error",
  );
  const truthGrade = gradeTruth({
    coverage,
    contributionMissing: contributionRung.missing,
    structure,
    hasStructureError,
    capAtC:
      taxTreatmentUnknown ||
      taxTreatmentMixed ||
      taxBasesDisagree ||
      excludedUnknownContribution ||
      (contributionRung.cost !== null && contributionRung.cost < 0) ||
      (variableCostRate !== null && variableCostRate < 0),
  });
  const targetRoas =
    typeof request.targetRoas === "number" &&
    Number.isFinite(request.targetRoas) &&
    request.targetRoas > 0
      ? request.targetRoas
      : null;

  const gates: Record<CostDecisionClassKey, CostDecisionGate> = {
    monitor: gate(true, null, "Monitoring never depends on cost truth."),
    loss_guardrail:
      truthGrade === "A" || truthGrade === "B"
        ? gate(true, null, "Costs are good enough to act on a clear loss.")
        : gate(
            true,
            "review_reduce",
            "Cost truth is weak, so loss limiting stays a reviewed reduction.",
          ),
    roas_target_scaling:
      targetRoas !== null
        ? gate(true, null, "The operator's target ROAS is authoritative and present.")
        : breakEvenRoasSuggested !== null && (truthGrade === "A" || truthGrade === "B")
          ? gate(
              true,
              "monitor_low_truth",
              "No target ROAS; scaling runs against the derived break-even only.",
            )
          : gate(
              false,
              "review_hold",
              "No target ROAS and no derivable break-even, so no scale authority.",
            ),
    profit_scaling:
      (truthGrade === "A" || truthGrade === "B") && rungs.preMarketingContribution.amount !== null
        ? gate(true, null, "Contribution is complete enough to scale on profit.")
        : gate(
            false,
            "degraded_no_scale",
            "Profit scaling needs a complete contribution figure.",
          ),
    product_margin:
      (truthGrade === "A" || truthGrade === "B") &&
      (coverage.productCostCoverage ?? 0) >= 0.95 &&
      // Coverage says every line has a number somewhere; this says the product
      // cost itself can be stated. A loaded cost held in another family
      // satisfies the first and not the second.
      rungs.productCost.amount !== null
        ? gate(true, null, "Product costs cover almost all revenue and can be stated.")
        : gate(
            false,
            "monitor_low_truth",
            "Product-level margin needs a statable product cost covering at least 95% of revenue.",
          ),
    reporting_profit:
      rungs.preMarketingContribution.amount !== null
        ? gate(
            true,
            null,
            contributionRung.estimated > 0
              ? "Reportable, with an estimated portion labelled."
              : "Reportable from observed costs.",
          )
        : gate(false, null, "Contribution cannot be stated while families are missing."),
  };

  const readiness: CostDecisionReadiness = {
    truthGrade,
    thresholds: {
      targetRoas,
      targetRoasSource: targetRoas !== null ? "target_pack" : "absent",
      breakEvenRoasSuggested,
      breakEvenCpaSuggested,
      variableCostRate,
      rateBase: revenue.rateBase ?? null,
    },
    gates,
  };

  return {
    window,
    reportingCurrency,
    structureVersion: structure.version,
    revenue: { netProductSales, rateBase: revenue.rateBase ?? null },
    adSpend,
    rungs,
    families: rollups,
    coverage,
    readiness,
    diagnostics,
  };
}

function gradeTruth(args: {
  coverage: CostCoverageSummary;
  contributionMissing: readonly CostFamily[];
  structure: CommerceCostStructure;
  hasStructureError: boolean;
  /** Complete numbers whose meaning is ambiguous cannot be graded A or B. */
  capAtC?: boolean;
}): CostTruthGrade {
  const { coverage, contributionMissing, structure, hasStructureError } = args;
  const productCoverage = coverage.productCostCoverage;

  if (
    hasStructureError ||
    // An unresolved disagreement between sources is not a graded number.
    (structure.conflicts?.length ?? 0) > 0 ||
    contributionMissing.length > 0 ||
    coverage.conflictFamilies.length > 0 ||
    coverage.unavailableFamilies.length > 0 ||
    productCoverage === null ||
    productCoverage < 0.5
  ) {
    return "D";
  }
  // Numbers whose meaning the owner has not confirmed cannot be top graded,
  // however complete they look: the same Shopify field means different things
  // in different shops.
  if (!structure.confirmed) return "C";
  if (productCoverage < 0.95) return "C";
  if ((coverage.estimatedShare ?? 0) > 0.5) return "C";
  if (args.capAtC) return "C";
  if ((coverage.estimatedShare ?? 0) > 0.05) return "B";
  return "A";
}

/** Layers, in ladder order, for UI that renders the breakdown. */
export const COST_LADDER_LAYER_ORDER: readonly CostLayer[] = [
  "product",
  "variable_operating",
  "marketing",
  "fixed",
];
