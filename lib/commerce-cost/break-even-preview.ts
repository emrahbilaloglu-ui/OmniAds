import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostBase,
  CostFamily,
} from "@/src/types/commerce-cost";
import {
  CONTRIBUTION_COST_FAMILIES,
  costFamilyMeta,
  marginImpliedFamilies,
} from "@/lib/commerce-cost/taxonomy";
import { validateCostStructure } from "@/lib/commerce-cost/validate";

/**
 * A read-only scenario estimate for the draft cost model.
 *
 * This deliberately does not reuse the stored Target Pack threshold. The
 * Target Pack remains operator authority; this result only answers what the
 * currently entered variable costs imply. It is also intentionally separate
 * from the decision runtime, which has not been cut over to this model.
 */

export type BreakEvenPreviewStatus =
  | "ready"
  | "provisional"
  | "incomplete"
  | "invalid"
  | "unavailable";

export interface BreakEvenPreviewFacts {
  window: { startDate: string; endDate: string; days: number };
  reportingCurrency: string;
  /** Totals are in reporting currency and cover the same selected window. */
  baseTotals: Partial<Record<CostBase, number | null>>;
  orderCount: number | null;
  unitCount: number | null;
  lineCount: number | null;
  currencyMismatchNetSales: number | null;
  shopify: {
    available: boolean;
    unavailableReason: string | null;
    currentUnitCostTotal: number | null;
    costedNetSales: number | null;
    missingNetSales: number | null;
    latestObservedAt: string | null;
  };
}

export interface BreakEvenPreviewContribution {
  id: string;
  label: string;
  rate: number;
  families: CostFamily[];
  source: "component" | "shopify_current_catalog";
}

export interface BreakEvenRoasPreview {
  status: BreakEvenPreviewStatus;
  breakEvenRoas: number | null;
  variableCostRate: number | null;
  contributionMarginRate: number | null;
  window: BreakEvenPreviewFacts["window"];
  reportingCurrency: string;
  contributions: BreakEvenPreviewContribution[];
  blockers: string[];
  assumptions: string[];
}

const NET_PRODUCT_BASES = new Set<CostBase>([
  "line_net_sales",
  "order_net_product_sales",
]);

function round(value: number, precision = 4) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function unique(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))];
}

function contributionFamiliesOf(component: CommerceCostComponent): CostFamily[] {
  return [
    ...new Set<CostFamily>([
      component.family,
      ...(component.embeds ?? []),
      ...(component.basis.kind === "margin_input"
        ? marginImpliedFamilies(component.basis.marginKind)
        : []),
    ]),
  ].filter((family) => CONTRIBUTION_COST_FAMILIES.includes(family));
}

function amountCurrencyFactor(
  component: CommerceCostComponent,
  reportingCurrency: string,
): number | null {
  if (component.currency.toUpperCase() === reportingCurrency.toUpperCase()) return 1;
  if (
    component.fx?.policy === "fixed_rate" &&
    typeof component.fx.fixedRate === "number" &&
    Number.isFinite(component.fx.fixedRate) &&
    component.fx.fixedRate > 0
  ) {
    return component.fx.fixedRate;
  }
  return null;
}

function netProductSales(facts: BreakEvenPreviewFacts) {
  const value = facts.baseTotals.order_net_product_sales ?? facts.baseTotals.line_net_sales;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function baseRatio(base: CostBase, facts: BreakEvenPreviewFacts): number | null {
  if (NET_PRODUCT_BASES.has(base)) return 1;
  const denominator = netProductSales(facts);
  const numerator = facts.baseTotals[base];
  if (
    denominator === null ||
    denominator <= 0 ||
    typeof numerator !== "number" ||
    !Number.isFinite(numerator)
  ) {
    return null;
  }
  return numerator / denominator;
}

function componentRate(
  component: CommerceCostComponent,
  facts: BreakEvenPreviewFacts,
): { rate: number | null; blocker: string | null } {
  if (component.scope.length > 0) {
    return {
      rate: null,
      blocker: `${component.label ?? costFamilyMeta(component.family).label} has conditions that need order-level resolution.`,
    };
  }

  const basis = component.basis;
  const denominator = netProductSales(facts);
  const requireDenominator = () =>
    denominator !== null && denominator > 0 ? denominator : null;
  const currencyFactor = amountCurrencyFactor(component, facts.reportingCurrency);
  const amountRate = (amount: number, count: number | null) => {
    const sales = requireDenominator();
    if (sales === null || count === null || currencyFactor === null) return null;
    return (amount * currencyFactor * count) / sales;
  };

  switch (basis.kind) {
    case "percent_of_base": {
      const ratio = baseRatio(basis.base, facts);
      return ratio === null
        ? { rate: null, blocker: `${component.label ?? "This cost"} needs ${basis.base} for the preview window.` }
        : { rate: (basis.percent / 100) * ratio, blocker: null };
    }
    case "margin_input": {
      const ratio = baseRatio(basis.base, facts);
      return ratio === null
        ? { rate: null, blocker: `${component.label ?? "This margin"} needs ${basis.base} for the preview window.` }
        : { rate: (1 - basis.marginPercent / 100) * ratio, blocker: null };
    }
    case "amount_per_unit": {
      const rate = amountRate(basis.amount, facts.unitCount);
      return rate === null
        ? { rate: null, blocker: `${component.label ?? "This cost"} needs unit volume and compatible currency data.` }
        : { rate, blocker: null };
    }
    case "amount_per_line": {
      const rate = amountRate(basis.amount, facts.lineCount);
      return rate === null
        ? { rate: null, blocker: `${component.label ?? "This cost"} needs line volume and compatible currency data.` }
        : { rate, blocker: null };
    }
    case "amount_per_order": {
      const rate = amountRate(basis.amount, facts.orderCount);
      return rate === null
        ? { rate: null, blocker: `${component.label ?? "This cost"} needs order volume and compatible currency data.` }
        : { rate, blocker: null };
    }
    case "percent_plus_fixed": {
      const ratio = baseRatio(basis.base, facts);
      const count = basis.fixedPer === "unit" ? facts.unitCount : facts.orderCount;
      const fixedRate = amountRate(basis.fixedAmount, count);
      return ratio === null || fixedRate === null
        ? { rate: null, blocker: `${component.label ?? "This cost"} needs its sales base, volume and compatible currency data.` }
        : { rate: (basis.percent / 100) * ratio + fixedRate, blocker: null };
    }
    case "period_amount":
      return {
        rate: null,
        blocker: `${component.label ?? "This cost"} is a period cost and cannot define marginal break-even ROAS.`,
      };
    case "rate_table":
      return {
        rate: null,
        blocker: `${component.label ?? "This rate table"} needs its order conditions resolved before break-even can be estimated.`,
      };
    case "bom":
      return {
        rate: null,
        blocker: `${component.label ?? "This bill of materials"} needs product-level order resolution before break-even can be estimated.`,
      };
  }
}

function emptyResult(
  facts: BreakEvenPreviewFacts,
  status: BreakEvenPreviewStatus,
  blockers: string[],
  assumptions: string[] = [],
  contributions: BreakEvenPreviewContribution[] = [],
): BreakEvenRoasPreview {
  return {
    status,
    breakEvenRoas: null,
    variableCostRate: null,
    contributionMarginRate: null,
    window: facts.window,
    reportingCurrency: facts.reportingCurrency,
    contributions,
    blockers: unique(blockers),
    assumptions: unique(assumptions),
  };
}

export function buildBreakEvenRoasPreview(input: {
  structure: CommerceCostStructure;
  facts: BreakEvenPreviewFacts;
}): BreakEvenRoasPreview {
  const { structure, facts } = input;
  const domainErrors = validateCostStructure(structure).filter((issue) => issue.severity === "error");
  if (domainErrors.length > 0) {
    return emptyResult(
      facts,
      "invalid",
      domainErrors.slice(0, 4).map((issue) => issue.detail),
    );
  }

  const active = structure.components.filter((component) => component.status === "active");
  const contributions: BreakEvenPreviewContribution[] = [];
  const blockers: string[] = [];
  const assumptions: string[] = [];
  const accountedFamilies = new Set<CostFamily>();
  let variableRate = 0;
  let productCostResolved = false;
  let hasUnaccountedContribution = false;

  const sourcePolicy = structure.sourcePolicy;
  const shopifyParticipates =
    sourcePolicy?.productCostAuthority === "shopify_unit_cost" ||
    sourcePolicy?.productCostAuthority === "hybrid";

  if (shopifyParticipates) {
    const policy = sourcePolicy?.shopifyUnitCost;
    if (!policy || policy.meaning === "unknown") {
      blockers.push("Define what the Shopify unit-cost field includes before using it in break-even.");
    } else {
      // Composition is configured even when the selected window cannot price
      // it. Mark ownership now so the one source problem is not repeated as a
      // misleading "no stated cost" message for every embedded family.
      for (const family of policy.includedFamilies) accountedFamilies.add(family);
    }
    if (policy && policy.meaning !== "unknown" && !facts.shopify.available) {
      blockers.push(facts.shopify.unavailableReason ?? "Shopify cost and order facts are unavailable.");
    } else if (policy && policy.meaning !== "unknown") {
      const sales = netProductSales(facts);
      const cost = facts.shopify.currentUnitCostTotal;
      const costedSales = facts.shopify.costedNetSales;
      const missingSales = facts.shopify.missingNetSales;
      const coverage =
        sales !== null && sales > 0 && costedSales !== null ? (costedSales / sales) * 100 : null;

      if (sales === null || sales <= 0 || cost === null || costedSales === null) {
        blockers.push("The selected window has no usable Shopify product-sales mix.");
      } else {
        const rate = cost / sales;
        variableRate += rate;
        productCostResolved = policy.includedFamilies.includes("product_purchase") && costedSales > 0;
        contributions.push({
          id: "shopify-current-unit-cost",
          label: "Shopify current unit costs",
          rate: round(rate, 6),
          families: [...policy.includedFamilies],
          source: "shopify_current_catalog",
        });
        assumptions.push(
          `Current Shopify catalog costs are applied to the ${facts.window.days}-day product sales mix; this is a scenario estimate, not historical COGS.`,
        );
        if ((facts.currencyMismatchNetSales ?? 0) > 0) {
          blockers.push("Some Shopify sales use a different reporting currency and have no approved conversion.");
        }
        if ((missingSales ?? 0) > 0) {
          blockers.push(
            `${missingSales!.toFixed(2)} ${facts.reportingCurrency} of sold product revenue has no compatible Shopify unit cost, so the shown value is a known-cost floor.`,
          );
        }
        if (coverage === null || coverage + 1e-9 < policy.minimumCoveragePercent) {
          blockers.push(
            `Sales-weighted Shopify cost coverage is ${coverage?.toFixed(2) ?? "unavailable"}%, below the required ${policy.minimumCoveragePercent}%.`,
          );
        }
      }
    }
  }

  for (const component of active) {
    const decisionClass = component.decisionClass ?? costFamilyMeta(component.family).decisionClass;
    if (decisionClass !== "contribution" || !CONTRIBUTION_COST_FAMILIES.includes(component.family)) {
      continue;
    }
    const families = contributionFamiliesOf(component);
    for (const family of families) accountedFamilies.add(family);
    const resolved = componentRate(component, facts);
    if (resolved.blocker || resolved.rate === null) {
      blockers.push(resolved.blocker ?? `${component.label ?? "A contribution cost"} could not be estimated.`);
      continue;
    }
    variableRate += resolved.rate;
    if (families.includes("product_purchase")) productCostResolved = true;
    contributions.push({
      id: component.id,
      label: component.label ?? costFamilyMeta(component.family).label,
      rate: round(resolved.rate, 6),
      families,
      source: "component",
    });
  }

  // The core resolver always expects product purchase and payment processing
  // unless a structure explicitly narrows its expected set. Product purchase
  // remains mandatory here even for an explicit empty set: a 1.00x break-even
  // with no product cost is not a useful preview.
  const requiredFamilies = new Set<CostFamily>([
    "product_purchase",
    ...(structure.expectedFamilies ?? ["payment_processing"]),
  ]);
  for (const family of structure.notTracked ?? []) {
    if (CONTRIBUTION_COST_FAMILIES.includes(family)) {
      hasUnaccountedContribution = true;
      blockers.push(`${costFamilyMeta(family).label} is marked as not tracked, so break-even is incomplete.`);
    }
  }
  for (const family of requiredFamilies) {
    if (!CONTRIBUTION_COST_FAMILIES.includes(family)) continue;
    if (!accountedFamilies.has(family)) {
      hasUnaccountedContribution = true;
      blockers.push(`${costFamilyMeta(family).label} has no stated cost or explicit zero.`);
    }
  }

  if (blockers.length > 0) {
    if (
      !hasUnaccountedContribution &&
      productCostResolved &&
      Number.isFinite(variableRate) &&
      variableRate >= 0 &&
      variableRate < 1
    ) {
      const contributionMarginRate = 1 - variableRate;
      return {
        status: "provisional",
        breakEvenRoas: round(1 / contributionMarginRate, 2),
        variableCostRate: round(variableRate, 6),
        contributionMarginRate: round(contributionMarginRate, 6),
        window: facts.window,
        reportingCurrency: facts.reportingCurrency,
        contributions,
        blockers: unique(blockers),
        assumptions: unique(assumptions),
      };
    }
    const factsUnavailable = blockers.every((blocker) => /unavailable|no usable/i.test(blocker));
    return emptyResult(
      facts,
      factsUnavailable ? "unavailable" : "incomplete",
      blockers,
      assumptions,
      contributions,
    );
  }

  if (!Number.isFinite(variableRate) || variableRate < 0 || variableRate >= 1) {
    return emptyResult(
      facts,
      "invalid",
      [
        variableRate >= 1
          ? "Variable costs are at or above 100% of revenue, so no finite break-even ROAS exists."
          : "The variable-cost rate is outside the usable range.",
      ],
      assumptions,
      contributions,
    );
  }

  const contributionMarginRate = 1 - variableRate;
  return {
    status: "ready",
    breakEvenRoas: round(1 / contributionMarginRate, 2),
    variableCostRate: round(variableRate, 6),
    contributionMarginRate: round(contributionMarginRate, 6),
    window: facts.window,
    reportingCurrency: facts.reportingCurrency,
    contributions,
    blockers: [],
    assumptions: unique(assumptions),
  };
}
