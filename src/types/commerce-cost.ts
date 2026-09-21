/**
 * The commerce cost domain contract.
 *
 * One businesses' cost structure is a versioned set of composable
 * *components*. A component says which cost family it carries, what it
 * applies to, how it is calculated, where the number came from, how good that
 * number is, when it is true, and what happens to it on a refund. Scenarios
 * (landed cost, fully loaded cost, per-order shipping, marketplace fees, BOM,
 * dropshipping, subscriptions, …) are combinations of these primitives rather
 * than a closed list of modes, so a new scenario is new data, not new code.
 *
 * Three rules are encoded in the types themselves, because they are the ones
 * that silently corrupt profit:
 *  - Paid marketing is never a cost component. It comes from the ad platforms.
 *  - A percentage needs the base it is a percentage OF.
 *  - Absent, zero, not-applicable and unreadable are four different states.
 */

// ---------------------------------------------------------------------------
// Families and layers
// ---------------------------------------------------------------------------

/** Rungs of the economics ladder a family belongs to. */
export const COST_LAYERS = ["product", "variable_operating", "marketing", "fixed"] as const;
export type CostLayer = (typeof COST_LAYERS)[number];

export const COST_FAMILIES = [
  // product layer
  "product_purchase",
  "inbound_logistics",
  "duties_import",
  "production_labor",
  // variable operating layer
  "packaging",
  "fulfillment",
  "outbound_shipping",
  "payment_processing",
  "channel_fees",
  "returns_processing",
  "returns_loss",
  "promo_giveaway",
  // marketing layer
  "marketing_paid",
  "marketing_other",
  // fixed layer
  "platform_software",
  "overhead_fixed",
] as const;
export type CostFamily = (typeof COST_FAMILIES)[number];

/** How a family behaves against marginal volume. */
export const COST_BEHAVIOURS = ["variable", "semi_fixed", "fixed"] as const;
export type CostBehaviour = (typeof COST_BEHAVIOURS)[number];

/** Which decisions a cost may inform. */
export const COST_DECISION_CLASSES = ["contribution", "operating", "informational"] as const;
export type CostDecisionClass = (typeof COST_DECISION_CLASSES)[number];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Dimensions a component can be scoped by. Tag and metafield dimensions exist
 * so an unforeseen distinction (a supplier programme, a delivery promise, a
 * bundle marker) is expressible without extending this list.
 */
export const COST_SCOPE_DIMENSIONS = [
  "channel",
  "market",
  "shipping_method",
  "payment_method",
  "order_type",
  "product_id",
  "variant_id",
  "sku",
  "collection",
  "product_tag",
  "order_tag",
  "customer_tag",
  "supplier",
  "location",
  "discount_code",
  "metafield",
] as const;
export type CostScopeDimension = (typeof COST_SCOPE_DIMENSIONS)[number];

export const COST_SCOPE_OPERATORS = ["in", "not_in", "exists"] as const;
export type CostScopeOperator = (typeof COST_SCOPE_OPERATORS)[number];

export interface CostScopePredicate {
  dimension: CostScopeDimension;
  operator: CostScopeOperator;
  /** Matched case-insensitively. Ignored by `exists`. */
  values?: readonly string[];
  /** Namespaced key for keyed dimensions such as `metafield`. */
  key?: string | null;
}

/** Order types that change the cost structure rather than the product. */
export const COST_ORDER_TYPES = [
  "one_time",
  "subscription_first",
  "subscription_renewal",
  "b2b",
  "pos",
] as const;
export type CostOrderType = (typeof COST_ORDER_TYPES)[number];

// ---------------------------------------------------------------------------
// Calculation basis
// ---------------------------------------------------------------------------

/**
 * Revenue bases a percentage may be taken of. A base is never inferred from
 * another: a percentage of a base the caller cannot supply resolves to
 * `unknown`, not to an approximation.
 */
export const COST_BASES = [
  "line_net_sales",
  "line_gross_sales",
  "order_net_product_sales",
  "order_gross_product_sales",
  "order_total_excl_tax",
  "order_total_incl_tax",
  "order_payment_captured",
  "order_shipping_revenue",
] as const;
export type CostBase = (typeof COST_BASES)[number];

/** Bases measured on a single line; the rest are order-level. */
export const COST_LINE_BASES: readonly CostBase[] = ["line_net_sales", "line_gross_sales"];

/** How an order-level or period amount is spread across lines. */
export const COST_ALLOCATION_DRIVERS = ["revenue", "units", "orders", "weight", "equal"] as const;
export type CostAllocationDriver = (typeof COST_ALLOCATION_DRIVERS)[number];

export const COST_PERIODS = ["day", "week", "month", "year"] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

export const COST_BASIS_KINDS = [
  "amount_per_unit",
  "amount_per_line",
  "amount_per_order",
  "percent_of_base",
  "percent_plus_fixed",
  "rate_table",
  "bom",
  "period_amount",
  "margin_input",
] as const;
export type CostBasisKind = (typeof COST_BASIS_KINDS)[number];

/** Rows are matched in order; the first match wins. */
export interface CostRateTableRow {
  when?: readonly CostScopePredicate[];
  /** Inclusive upper bound in kilograms. Null or absent means no bound. */
  weightMaxKg?: number | null;
  amount: number;
}

export interface CostBomComponent {
  variantId?: string | null;
  sku?: string | null;
  quantity: number;
  /** Stated child cost. When absent the child's own components are resolved. */
  amount?: number | null;
}

export type CostBasis =
  | { kind: "amount_per_unit"; amount: number }
  | { kind: "amount_per_line"; amount: number }
  | { kind: "amount_per_order"; amount: number; allocation: CostAllocationDriver }
  | {
      kind: "percent_of_base";
      percent: number;
      base: CostBase;
      allocation?: CostAllocationDriver;
    }
  | {
      kind: "percent_plus_fixed";
      percent: number;
      base: CostBase;
      fixedAmount: number;
      /** The fixed part is per order unless stated per unit. */
      fixedPer?: "order" | "unit";
      allocation?: CostAllocationDriver;
    }
  | {
      kind: "rate_table";
      level: "order" | "unit";
      rows: readonly CostRateTableRow[];
      fallbackAmount?: number | null;
      allocation?: CostAllocationDriver;
    }
  | { kind: "bom"; components: readonly CostBomComponent[]; wastePercent?: number | null }
  | {
      kind: "period_amount";
      amount: number;
      period: CostPeriod;
      allocation: CostAllocationDriver;
    }
  | {
      /**
       * A margin the owner states instead of costs. It implies the cost of
       * every family it covers, so those families cannot also be componentised.
       */
      kind: "margin_input";
      marginKind: "gross" | "contribution";
      marginPercent: number;
      base: CostBase;
      allocation?: CostAllocationDriver;
    };

// ---------------------------------------------------------------------------
// Provenance, time and behaviour
// ---------------------------------------------------------------------------

/** Ordered best to worst; ties break on scope specificity, then recency. */
export const COST_EVIDENCE_TIERS = [
  "override",
  "observed_exact",
  "observed_allocated",
  "contracted_rate",
  "classified_attribute",
  "operator_estimate",
  "template_default",
] as const;
export type CostEvidenceTier = (typeof COST_EVIDENCE_TIERS)[number];

export const COST_SOURCE_KINDS = [
  "shopify_unit_cost",
  "shopify_payouts",
  "carrier_invoice",
  "supplier_invoice",
  "csv_import",
  "manual",
  "template",
  "derived",
  "legacy_import",
] as const;
export type CostSourceKind = (typeof COST_SOURCE_KINDS)[number];

export interface CostSourceRef {
  kind: CostSourceKind;
  ref?: string | null;
}

/** Which event date the cost is recognised on. */
export const COST_RECOGNITIONS = ["on_order", "on_fulfillment", "on_payout", "on_period"] as const;
export type CostRecognition = (typeof COST_RECOGNITIONS)[number];

/**
 * What a refund gives back. Shipping already flown and processing fees already
 * charged are not recovered by a return, so they are not reversed by default.
 */
export const COST_REFUND_BEHAVIOURS = [
  "reverse_on_restock",
  "reverse_on_cancel_only",
  "product_share_only",
  "non_recoverable",
] as const;
export type CostRefundBehaviour = (typeof COST_REFUND_BEHAVIOURS)[number];

export const COST_TAX_TREATMENTS = [
  "net_of_recoverable_tax",
  "gross_including_tax",
  "unknown",
] as const;
export type CostTaxTreatment = (typeof COST_TAX_TREATMENTS)[number];

export const COST_FX_POLICIES = ["reporting_currency", "transaction_date", "fixed_rate"] as const;
export type CostFxPolicy = (typeof COST_FX_POLICIES)[number];

export interface CostFx {
  policy: CostFxPolicy;
  fixedRate?: number | null;
}

export const COST_COMPONENT_STATUSES = ["draft", "active", "retired"] as const;
export type CostComponentStatus = (typeof COST_COMPONENT_STATUSES)[number];

/** A family embedded in a host component, and its size when that is known. */
export interface CostEmbeddedShare {
  family: CostFamily;
  kind: "amount_per_unit" | "percent_of_host";
  value: number;
}

// ---------------------------------------------------------------------------
// Component and structure
// ---------------------------------------------------------------------------

export interface CommerceCostComponent {
  id: string;
  /** Monotonic per `id`; a change supersedes rather than edits. */
  version: number;
  family: CostFamily;
  /**
   * Composition slot. The ownership atom is `family:slot`, so one family can
   * hold several distinct real costs (a base rate and a surcharge) while two
   * components competing for the same slot are a conflict, not a sum.
   */
  slot: string;
  label?: string | null;
  /** Empty means store-wide. */
  scope: readonly CostScopePredicate[];
  basis: CostBasis;
  /** Families whose cost is already inside this component's amount. */
  embeds?: readonly CostFamily[];
  embeddedShares?: readonly CostEmbeddedShare[];
  /** Takes an embedded family over from a host. Needs that host's share. */
  replacesEmbedded?: boolean;
  currency: string;
  fx?: CostFx;
  taxTreatment: CostTaxTreatment;
  effectiveFrom: string;
  effectiveTo?: string | null;
  /** Transaction time, so "what did we believe then" is reproducible. */
  recordedAt: string;
  supersededAt?: string | null;
  recognition: CostRecognition;
  refundBehaviour?: CostRefundBehaviour;
  evidence: CostEvidenceTier;
  source: CostSourceRef;
  decisionClass?: CostDecisionClass;
  overrideOf?: string | null;
  reason?: string | null;
  status: CostComponentStatus;
  audit?: { createdBy?: string | null; createdAt?: string | null; note?: string | null };
}

export const COST_STRUCTURE_ORIGINS = ["operator", "template", "legacy_import"] as const;
export type CostStructureOrigin = (typeof COST_STRUCTURE_ORIGINS)[number];

/**
 * Which source owns the product-cost answer. This is an operator declaration,
 * not a runtime switch: consumers must opt in separately before using it.
 */
export const PRODUCT_COST_AUTHORITIES = [
  "unconfigured",
  "shopify_unit_cost",
  "manual_components",
  "hybrid",
] as const;
export type ProductCostAuthority = (typeof PRODUCT_COST_AUTHORITIES)[number];

/** What one Shopify `InventoryItem.unitCost` represents for this business. */
export const SHOPIFY_UNIT_COST_MEANINGS = [
  "unknown",
  "product_purchase_only",
  "landed_cost",
  "loaded_variable_cost",
  "custom_composite",
] as const;
export type ShopifyUnitCostMeaning = (typeof SHOPIFY_UNIT_COST_MEANINGS)[number];

export const SHOPIFY_MISSING_COST_POLICIES = ["leave_unknown", "manual_fallback"] as const;
export type ShopifyMissingCostPolicy = (typeof SHOPIFY_MISSING_COST_POLICIES)[number];

export const SHOPIFY_HISTORICAL_COST_POLICIES = [
  "unknown_before_first_observation",
  "manual_components_before_first_observation",
] as const;
export type ShopifyHistoricalCostPolicy = (typeof SHOPIFY_HISTORICAL_COST_POLICIES)[number];

export interface ShopifyUnitCostPolicy {
  meaning: ShopifyUnitCostMeaning;
  /** Every family already contained in Shopify's unit-cost number. */
  includedFamilies: readonly CostFamily[];
  /** Below this catalog coverage the source is not ready for later cutover. */
  minimumCoveragePercent: number;
  missingCostPolicy: ShopifyMissingCostPolicy;
  /** Active manual component used only when a variant has no Shopify cost. */
  fallbackComponentId?: string | null;
  /** Current catalog values do not establish an older order's historical cost. */
  historicalPolicy: ShopifyHistoricalCostPolicy;
}

export interface CommerceCostSourcePolicy {
  productCostAuthority: ProductCostAuthority;
  /** Present only when Shopify participates in product-cost ownership. */
  shopifyUnitCost?: ShopifyUnitCostPolicy;
}

/** Two sources disagree and the product refuses to pick silently. */
export interface CostStructureConflict {
  family: CostFamily;
  slot: string;
  detail: string;
  candidates: ReadonlyArray<{ source: CostSourceRef; value: number | null; note?: string | null }>;
}

export interface CommerceCostStructure {
  businessId: string;
  version: number;
  origin: CostStructureOrigin;
  /** False until the owner has confirmed what the numbers mean. */
  confirmed: boolean;
  reportingCurrency: string;
  effectiveFrom: string;
  recordedAt: string;
  components: readonly CommerceCostComponent[];
  /** Declares source precedence and what externally supplied costs include. */
  sourcePolicy?: CommerceCostSourcePolicy;
  /**
   * Families the owner has said they do not track. An acknowledged gap, and
   * NOT a zero: a rung that needs one of these is reported unstated. To say a
   * family genuinely costs nothing, state a component with an amount of 0.
   */
  notTracked?: readonly CostFamily[];
  /** Families that should exist here; drives gap detection beyond components. */
  expectedFamilies?: readonly CostFamily[];
  conflicts?: readonly CostStructureConflict[];
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Resolution input
// ---------------------------------------------------------------------------

/**
 * Runtime values may carry a plain dimension (`market`) or a namespaced key
 * (`metafield:bundle`). Keeping the keyed form in the type prevents callers
 * from casting away the very distinction the matcher relies on.
 */
export type CostDimensionKey = CostScopeDimension | `${CostScopeDimension}:${string}`;
export type CostDimensionValues = Partial<Record<CostDimensionKey, readonly string[]>>;

export type CostBaseAmounts = Partial<Record<CostBase, number | null>>;

export interface CostOrderContext {
  orderId: string;
  /** Recognition anchor for `on_order`. */
  occurredAt: string;
  /** Workspace-local date the revenue event is dated on. */
  occurredDate: string;
  fulfilledAt?: string | null;
  fulfilledDate?: string | null;
  payoutAt?: string | null;
  payoutDate?: string | null;
  /** Currency of the supplied base amounts. */
  currency: string;
  dimensions?: CostDimensionValues;
  bases?: CostBaseAmounts;
  weightKg?: number | null;
}

/** A measured cost for one line, from an invoice, payout or label. */
export interface ObservedCostFact {
  family: CostFamily;
  slot?: string;
  amount: number;
  currency: string;
  evidence?: Extract<CostEvidenceTier, "observed_exact" | "observed_allocated" | "override">;
  source: CostSourceRef;
  /** Whether `amount` covers the whole line or one unit. */
  per?: "line" | "unit";
  /**
   * Whether the measured amount includes recoverable tax. Absent means the
   * importer did not say, which is reported but does not punish the grade —
   * a measured invoice is still the best evidence there is.
   */
  taxTreatment?: CostTaxTreatment;
  reason?: string | null;
}

export interface CostLineContext {
  lineId: string;
  quantity: number;
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  dimensions?: CostDimensionValues;
  bases?: CostBaseAmounts;
  weightKg?: number | null;
  isGiftCard?: boolean;
  requiresShipping?: boolean;
  /** Families that cannot apply to this line at all. */
  notApplicableFamilies?: readonly CostFamily[];
  observed?: readonly ObservedCostFact[];
}

/** Why a family's own source could not answer, as opposed to having no value. */
export const COST_UNAVAILABLE_REASONS = [
  "permission_missing",
  "read_failed",
  "stale",
  "currency_blocked",
  "source_disconnected",
] as const;
export type CostUnavailableReason = (typeof COST_UNAVAILABLE_REASONS)[number];

export interface CostSourceIssue {
  family: CostFamily;
  reason: CostUnavailableReason;
  detail?: string | null;
}

export interface CostResolutionRequest {
  structure: CommerceCostStructure;
  order: CostOrderContext;
  lines: readonly CostLineContext[];
  reportingCurrency: string;
  /** Units of the reporting currency per 1 unit of the keyed currency. */
  fxRates?: Readonly<Record<string, number>>;
  sourceIssues?: readonly CostSourceIssue[];
  /** Ignore components recorded after this instant (bitemporal replay). */
  asOfRecordedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Resolution output
// ---------------------------------------------------------------------------

export const COST_AMOUNT_STATES = [
  "value",
  "zero",
  "embedded",
  "not_applicable",
  "not_tracked",
  "unknown",
  "conflict",
  "unavailable",
] as const;
export type CostAmountState = (typeof COST_AMOUNT_STATES)[number];

export interface CostAllocationTrace {
  driver: CostAllocationDriver;
  /** The undivided order-level amount, in the reporting currency. */
  orderAmount: number;
  weight: number;
  totalWeight: number;
}

export interface CostResolutionEntry {
  lineId: string;
  family: CostFamily;
  slot: string;
  layer: CostLayer;
  state: CostAmountState;
  /** Reporting currency. Null unless the state is `value` or `zero`. */
  amount: number | null;
  /** True when the number came from an estimate rather than an observation. */
  estimated: boolean;
  quantity: number;
  evidence?: CostEvidenceTier | null;
  source?: CostSourceRef | null;
  ownerComponentId?: string | null;
  ownerComponentVersion?: number | null;
  decisionClass: CostDecisionClass;
  refundBehaviour: CostRefundBehaviour;
  /** Whether this amount includes tax the owner can recover. */
  taxTreatment: CostTaxTreatment;
  /** Which date the ledger books this cost on. */
  recognition: CostRecognition;
  /** Set when this family's money lives inside another component. */
  shadowedBy?: { componentId: string; family: CostFamily } | null;
  /** How an order-level amount reached this line. */
  allocation?: CostAllocationTrace;
  /** Share subtracted from this host because a direct component replaced it. */
  hostShareRemoved?: number | null;
  conflictingComponentIds?: readonly string[];
  unavailableReason?: CostUnavailableReason | null;
  reasons: readonly string[];
}

export interface CostResolutionLineFact {
  lineId: string;
  quantity: number;
  netSales: number | null;
}

export interface CostResolutionResult {
  orderId: string;
  structureVersion: number;
  reportingCurrency: string;
  /** Recognition dates by component recognition mode, for the ledger. */
  dates: { order: string; fulfilled: string | null; payout: string | null };
  lines: readonly CostResolutionLineFact[];
  entries: readonly CostResolutionEntry[];
  /** Components skipped here because they are window-level, not order-level. */
  deferredPeriodComponentIds: readonly string[];
  reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const COST_LEDGER_KINDS = ["sale", "refund_reversal", "period_allocation"] as const;
export type CostLedgerKind = (typeof COST_LEDGER_KINDS)[number];

export interface CostLedgerEvent {
  /** Stable and idempotent: re-deriving the same input yields the same id. */
  eventId: string;
  kind: CostLedgerKind;
  occurredDate: string;
  orderId?: string | null;
  lineId?: string | null;
  refundLineId?: string | null;
  family: CostFamily;
  slot: string;
  layer: CostLayer;
  /** Signed: negative on a reversal. */
  quantity: number;
  /** Signed, reporting currency. Null when the state carries no number. */
  amount: number | null;
  state: CostAmountState;
  estimated: boolean;
  decisionClass: CostDecisionClass;
  taxTreatment: CostTaxTreatment;
  /** The family holding this one's money, when this event is `embedded`. */
  hostFamily?: CostFamily | null;
  unavailableReason?: CostUnavailableReason | null;
  evidence?: CostEvidenceTier | null;
  ownerComponentId?: string | null;
  ownerComponentVersion?: number | null;
  structureVersion: number;
  reasons: readonly string[];
}

export const COST_RESTOCK_TYPES = ["return", "cancel", "no_restock", "unknown"] as const;
export type CostRestockType = (typeof COST_RESTOCK_TYPES)[number];

export interface CostRefundLine {
  refundLineId: string;
  lineId: string;
  quantity: number;
  restockType: CostRestockType;
  /** Local date the refund is dated on. */
  refundedDate: string;
}

// ---------------------------------------------------------------------------
// Economics ladder
// ---------------------------------------------------------------------------

export const COST_LADDER_STATES = ["complete", "partial", "estimated", "unavailable"] as const;
export type CostLadderState = (typeof COST_LADDER_STATES)[number];

export interface EconomicsLadderRung {
  amount: number | null;
  state: CostLadderState;
  /** Portion of `amount` that rests on estimates. */
  estimatedAmount: number;
  includedFamilies: readonly CostFamily[];
  missingFamilies: readonly CostFamily[];
}

export interface CostFamilyRollup {
  family: CostFamily;
  layer: CostLayer;
  amount: number | null;
  estimatedAmount: number;
  state: CostAmountState;
  /** Share of line revenue whose lines carry a number for this family. */
  coverage: number | null;
  unavailableReason?: CostUnavailableReason | null;
}

export interface CostCoverageSummary {
  /** Revenue-weighted share of lines with a resolved product cost. */
  productCostCoverage: number | null;
  costedNetSales: number;
  totalNetSales: number;
  lineCount: number;
  costedLineCount: number;
  /** Share of resolved cost that rests on estimates. */
  estimatedShare: number | null;
  unknownFamilies: readonly CostFamily[];
  conflictFamilies: readonly CostFamily[];
  unavailableFamilies: ReadonlyArray<{ family: CostFamily; reason: CostUnavailableReason }>;
  notTrackedFamilies: readonly CostFamily[];
  /** Revenue-weighted coverage per family, for the family breakdown. */
  familyCoverage?: Readonly<Partial<Record<CostFamily, number | null>>>;
}

export const COST_TRUTH_GRADES = ["A", "B", "C", "D"] as const;
export type CostTruthGrade = (typeof COST_TRUTH_GRADES)[number];

export const COST_DECISION_CLASS_KEYS = [
  "monitor",
  "loss_guardrail",
  "roas_target_scaling",
  "profit_scaling",
  "product_margin",
  "reporting_profit",
] as const;
export type CostDecisionClassKey = (typeof COST_DECISION_CLASS_KEYS)[number];

export interface CostDecisionGate {
  allowed: boolean;
  /** Mirrors the existing decision safety vocabulary. */
  ceiling: "review_hold" | "review_reduce" | "monitor_low_truth" | "degraded_no_scale" | null;
  reason: string;
}

export interface CostThresholdSummary {
  /** The operator's confirmed target. Authoritative whenever present. */
  targetRoas: number | null;
  targetRoasSource: "target_pack" | "absent";
  /** Derived from the resolved cost structure. A suggestion, never applied. */
  breakEvenRoasSuggested: number | null;
  /** Only when an AOV assumption exists. Its absence blocks nothing. */
  breakEvenCpaSuggested: number | null;
  variableCostRate: number | null;
  rateBase: CostBase | null;
}

export interface CostDecisionReadiness {
  truthGrade: CostTruthGrade;
  thresholds: CostThresholdSummary;
  gates: Readonly<Record<CostDecisionClassKey, CostDecisionGate>>;
}

export interface EconomicsLadder {
  window: { startDate: string; endDate: string; days: number };
  reportingCurrency: string;
  structureVersion: number;
  revenue: { netProductSales: number | null; rateBase: CostBase | null };
  adSpend: number | null;
  rungs: {
    productCost: EconomicsLadderRung;
    preMarketingContribution: EconomicsLadderRung;
    postMarketingContribution: EconomicsLadderRung;
    operatingProfit: EconomicsLadderRung;
  };
  families: readonly CostFamilyRollup[];
  coverage: CostCoverageSummary;
  readiness: CostDecisionReadiness;
  diagnostics: readonly string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const COST_ISSUE_SEVERITIES = ["error", "warning"] as const;
export type CostIssueSeverity = (typeof COST_ISSUE_SEVERITIES)[number];

export const COST_STRUCTURE_ISSUE_CODES = [
  "marketing_family_not_allowed",
  "family_not_embeddable",
  "embedded_family_also_direct",
  "margin_input_with_direct_component",
  "embedded_share_required_for_replacement",
  "replacement_without_host",
  "unknown_base",
  "line_scope_with_order_base",
  "fixed_family_needs_period_basis",
  "period_basis_on_variable_family",
  "variable_percent_exceeds_full_revenue",
  "margin_out_of_range",
  "percent_out_of_range",
  "negative_amount",
  "bom_cycle",
  "bom_depth_exceeded",
  "bom_child_unidentified",
  "override_without_reason",
  "override_target_missing",
  "override_target_mismatch",
  "duplicate_effective_range",
  "currency_without_fx_policy",
  "effective_range_inverted",
  "unconfirmed_zero_amount",
  "rate_table_without_rows",
  "allocation_missing_for_order_amount",
  "embedded_share_not_a_cost",
  "embedded_share_without_embed",
  "loaded_product_refund_policy_invalid",
  "unparseable_time",
  "duplicate_component_version",
  "shopify_source_meaning_unknown",
  "shopify_source_product_cost_missing",
  "shopify_source_family_not_embeddable",
  "shopify_source_family_also_direct",
  "shopify_fallback_component_missing",
  "shopify_fallback_component_invalid",
  "shopify_fallback_composition_mismatch",
  "shopify_coverage_threshold_invalid",
] as const;
export type CostStructureIssueCode = (typeof COST_STRUCTURE_ISSUE_CODES)[number];

export interface CostStructureIssue {
  code: CostStructureIssueCode;
  severity: CostIssueSeverity;
  componentIds: readonly string[];
  family?: CostFamily | null;
  detail: string;
}
