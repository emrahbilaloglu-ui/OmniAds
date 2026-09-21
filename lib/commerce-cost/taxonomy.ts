import {
  COST_FAMILIES,
  type CostBehaviour,
  type CostDecisionClass,
  type CostEvidenceTier,
  type CostFamily,
  type CostLayer,
  type CostRefundBehaviour,
} from "@/src/types/commerce-cost";

/**
 * What each cost family is, economically.
 *
 * The defaults here are the ones that keep decisions honest without the owner
 * configuring anything: fixed families never reach marginal decisions, and a
 * family whose money is already spent by the time a customer returns goods is
 * not reversed by a refund.
 */

export interface CostFamilyMeta {
  layer: CostLayer;
  behaviour: CostBehaviour;
  decisionClass: CostDecisionClass;
  refundBehaviour: CostRefundBehaviour;
  /** False for paid marketing: it is never modelled as a cost component. */
  componentAllowed: boolean;
  /** False for paid marketing: it can never hide inside another component. */
  embeddable: boolean;
  label: string;
}

export const COST_FAMILY_META: Readonly<Record<CostFamily, CostFamilyMeta>> = {
  product_purchase: {
    layer: "product",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Product purchase",
  },
  inbound_logistics: {
    layer: "product",
    behaviour: "variable",
    decisionClass: "contribution",
    // Freight to get the unit into stock is spent; a resale recovers it.
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Inbound freight",
  },
  duties_import: {
    layer: "product",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Duties and import taxes",
  },
  production_labor: {
    layer: "product",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Production labour",
  },
  packaging: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    // Opened packaging does not come back.
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: true,
    label: "Packaging",
  },
  fulfillment: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_cancel_only",
    componentAllowed: true,
    embeddable: true,
    label: "Fulfilment",
  },
  outbound_shipping: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    // A shipped parcel is paid for whether or not the customer keeps it.
    refundBehaviour: "reverse_on_cancel_only",
    componentAllowed: true,
    embeddable: true,
    label: "Outbound shipping",
  },
  payment_processing: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: true,
    label: "Payment processing",
  },
  channel_fees: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Channel and marketplace fees",
  },
  returns_processing: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    // A return costs money; it is never given back by another return.
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: true,
    label: "Returns handling",
  },
  returns_loss: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: true,
    label: "Unsellable returns",
  },
  promo_giveaway: {
    layer: "variable_operating",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "reverse_on_restock",
    componentAllowed: true,
    embeddable: true,
    label: "Promotional giveaways",
  },
  marketing_paid: {
    layer: "marketing",
    behaviour: "variable",
    decisionClass: "contribution",
    refundBehaviour: "non_recoverable",
    // Ad spend comes from the ad platforms. Modelling or embedding it would
    // count the same money twice in every ROAS and profit figure.
    componentAllowed: false,
    embeddable: false,
    label: "Paid marketing",
  },
  marketing_other: {
    layer: "marketing",
    behaviour: "semi_fixed",
    decisionClass: "operating",
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: false,
    label: "Other marketing",
  },
  platform_software: {
    layer: "fixed",
    behaviour: "fixed",
    decisionClass: "operating",
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: false,
    label: "Platform and software",
  },
  overhead_fixed: {
    layer: "fixed",
    behaviour: "fixed",
    decisionClass: "operating",
    refundBehaviour: "non_recoverable",
    componentAllowed: true,
    embeddable: false,
    label: "Fixed overhead",
  },
};

export function costFamilyMeta(family: CostFamily): CostFamilyMeta {
  return COST_FAMILY_META[family];
}

export function costFamilyLayer(family: CostFamily): CostLayer {
  return COST_FAMILY_META[family].layer;
}

export function familiesInLayer(layer: CostLayer): CostFamily[] {
  return COST_FAMILIES.filter((family) => COST_FAMILY_META[family].layer === layer);
}

/** Product-layer families: the cost of the goods themselves. */
export const PRODUCT_COST_FAMILIES: readonly CostFamily[] = familiesInLayer("product");

/**
 * Families that scale with an order and therefore belong in a marginal
 * decision. Fixed and marketing layers are deliberately absent.
 */
export const CONTRIBUTION_COST_FAMILIES: readonly CostFamily[] = [
  ...familiesInLayer("product"),
  ...familiesInLayer("variable_operating"),
];

export function isContributionFamily(family: CostFamily): boolean {
  return CONTRIBUTION_COST_FAMILIES.includes(family);
}

/** What a stated margin covers, and therefore what it may not co-exist with. */
export function marginImpliedFamilies(marginKind: "gross" | "contribution"): readonly CostFamily[] {
  return marginKind === "gross" ? PRODUCT_COST_FAMILIES : CONTRIBUTION_COST_FAMILIES;
}

const EVIDENCE_RANK: Readonly<Record<CostEvidenceTier, number>> = {
  override: 0,
  observed_exact: 1,
  observed_allocated: 2,
  contracted_rate: 3,
  classified_attribute: 4,
  operator_estimate: 5,
  template_default: 6,
};

export function evidenceRank(evidence: CostEvidenceTier): number {
  return EVIDENCE_RANK[evidence];
}

/** Estimates must never be presented, or summed, as observations. */
export function isEstimateEvidence(evidence: CostEvidenceTier): boolean {
  return evidence === "operator_estimate" || evidence === "template_default";
}
