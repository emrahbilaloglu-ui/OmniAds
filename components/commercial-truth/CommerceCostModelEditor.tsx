"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import styles from "@/components/commercial-truth/CommerceCostModelEditor.module.css";
import { FieldHelpTip } from "@/components/commercial-truth/FieldHelpTip";
import {
  COST_ALLOCATION_DRIVERS,
  COST_BASES,
  COST_DECISION_CLASSES,
  COST_EVIDENCE_TIERS,
  COST_FAMILIES,
  COST_PERIODS,
  COST_RECOGNITIONS,
  COST_REFUND_BEHAVIOURS,
  COST_SCOPE_DIMENSIONS,
  COST_SOURCE_KINDS,
  COST_TAX_TREATMENTS,
  type CommerceCostComponent,
  type CommerceCostStructure,
  type CostAllocationDriver,
  type CostBase,
  type CostBasis,
  type CostBasisKind,
  type CostBomComponent,
  type CostDecisionClass,
  type CostEmbeddedShare,
  type CostEvidenceTier,
  type CostFamily,
  type CostFxPolicy,
  type CostLayer,
  type CostPeriod,
  type CostRateTableRow,
  type CostRecognition,
  type CostRefundBehaviour,
  type CostScopeDimension,
  type CostScopeOperator,
  type CostScopePredicate,
  type CostSourceKind,
  type CostStructureIssue,
  type CostTaxTreatment,
} from "@/src/types/commerce-cost";
import { CONTRIBUTION_COST_FAMILIES, costFamilyMeta } from "@/lib/commerce-cost/taxonomy";
import { validateCostStructure } from "@/lib/commerce-cost/validate";
import type { BreakEvenRoasPreview } from "@/lib/commerce-cost/break-even-preview";
import { DatePicker } from "@/components/date-range/DateRangePicker";

export type CommerceCostModelSource = "stored" | "legacy_preview" | "empty";

export interface CommerceCostModelEditorProps {
  structure: CommerceCostStructure;
  source: CommerceCostModelSource;
  canEdit: boolean;
  saving: boolean;
  serverIssues?: readonly CostStructureIssue[];
  sourceWarnings?: readonly string[];
  error?: string | null;
  dirty: boolean;
  breakEvenPreview?: BreakEvenRoasPreview | null;
  breakEvenPreviewLoading?: boolean;
  breakEvenPreviewError?: string | null;
  targetPackBreakEvenRoas?: number | null;
  onChange: (structure: CommerceCostStructure) => void;
  onSave: () => void;
  onDiscard: () => void;
}

type EditableBasisKind = Exclude<CostBasisKind, never>;

type CostScenarioId =
  | "supplier_unit"
  | "landed_cost"
  | "loaded_ratio"
  | "all_expense_reference"
  | "payment_fee"
  | "shipping_rate"
  | "bundle_bom"
  | "recurring_overhead"
  | "margin_estimate";

interface ComponentForm {
  scenarioId: CostScenarioId | null;
  editingId: string | null;
  label: string;
  family: CostFamily;
  slot: string;
  kind: EditableBasisKind;
  amount: string;
  percent: string;
  fixedAmount: string;
  fixedPer: "order" | "unit";
  base: CostBase;
  allocation: CostAllocationDriver;
  period: CostPeriod;
  marginKind: "gross" | "contribution";
  currency: string;
  fxPolicy: Extract<CostFxPolicy, "transaction_date" | "fixed_rate">;
  fixedRate: string;
  decisionClass: CostDecisionClass;
  taxTreatment: CostTaxTreatment;
  recognition: CostRecognition;
  refundBehaviour: CostRefundBehaviour;
  evidence: CostEvidenceTier;
  sourceKind: CostSourceKind;
  sourceRef: string;
  replacesEmbedded: boolean;
  overrideOf: string;
  reason: string;
  auditNote: string;
  effectiveFrom: string;
  effectiveTo: string;
  embeds: CostFamily[];
  scopeRules: Array<{
    dimension: CostScopeDimension;
    operator: CostScopeOperator;
    key: string;
    values: string;
  }>;
  rateLevel: "order" | "unit";
  fallbackAmount: string;
  rateRows: Array<{ weightMaxKg: string; amount: string; when?: readonly CostScopePredicate[] }>;
  bomLines: Array<{ variantId: string; sku: string; quantity: string; amount: string }>;
  bomWastePercent: string;
  embeddedShares: Array<{
    family: CostFamily;
    kind: CostEmbeddedShare["kind"];
    value: string;
  }>;
}

const LAYERS: Array<{ layer: CostLayer; label: string; note: string }> = [
  { layer: "product", label: "Product", note: "goods, inbound freight, duties and production" },
  {
    layer: "variable_operating",
    label: "Per order",
    note: "shipping, fulfilment, packaging, fees and returns",
  },
  { layer: "marketing", label: "Other marketing", note: "non-platform marketing only" },
  { layer: "fixed", label: "Fixed", note: "software and recurring overhead" },
];

const COMMON_KINDS: Array<{ value: EditableBasisKind; label: string }> = [
  { value: "percent_of_base", label: "Percentage of revenue / loaded rate" },
  { value: "amount_per_unit", label: "Amount per unit" },
  { value: "amount_per_line", label: "Amount per order line" },
  { value: "amount_per_order", label: "Amount per order" },
  { value: "percent_plus_fixed", label: "Percentage + fixed fee" },
  { value: "period_amount", label: "Recurring amount" },
  { value: "margin_input", label: "Stated margin" },
  { value: "rate_table", label: "Rate table" },
  { value: "bom", label: "Bill of materials" },
];

const DECISION_LABELS: Record<CostDecisionClass, string> = {
  contribution: "Unit economics and contribution",
  operating: "Operating profit only",
  informational: "Reference only",
};

const TAX_LABELS: Record<CostTaxTreatment, string> = {
  net_of_recoverable_tax: "Net of recoverable tax",
  gross_including_tax: "Includes tax",
  unknown: "Not specified",
};

const REFUND_LABELS: Record<CostRefundBehaviour, string> = {
  reverse_on_restock: "Reverse when the item is restocked",
  reverse_on_cancel_only: "Reverse only when cancelled before use",
  product_share_only: "Reverse the product share only",
  non_recoverable: "Keep the cost after a refund",
};

const RECOGNITION_LABELS: Record<CostRecognition, string> = {
  on_order: "Order date",
  on_fulfillment: "Fulfilment date",
  on_payout: "Payout date",
  on_period: "Across the reporting period",
};

const EVIDENCE_LABELS: Record<CostEvidenceTier, string> = {
  override: "Manual override",
  observed_exact: "Exact observed cost",
  observed_allocated: "Allocated observed cost",
  contracted_rate: "Contracted rate",
  classified_attribute: "Rule from product or order data",
  operator_estimate: "Business estimate",
  template_default: "Template default",
};

const SOURCE_LABELS: Record<CostSourceKind, string> = {
  shopify_unit_cost: "Shopify unit cost",
  shopify_payouts: "Shopify payout",
  carrier_invoice: "Carrier invoice",
  supplier_invoice: "Supplier invoice",
  csv_import: "Imported file",
  manual: "Manual entry",
  template: "Template",
  derived: "Derived value",
  legacy_import: "Legacy import",
};

const ALLOCATION_LABELS: Record<CostAllocationDriver, string> = {
  revenue: "By revenue",
  units: "By units",
  orders: "By orders",
  weight: "By weight",
  equal: "Equally",
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function inputDate(value: string | null | undefined) {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function instantFromDate(value: string, fallback: string) {
  return value ? `${value}T00:00:00.000Z` : fallback;
}

function numberFrom(value: string, field: string): number {
  if (!value.trim()) throw new Error(`${field} is required.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} needs a number.`);
  return parsed;
}

function defaultForm(structure: CommerceCostStructure): ComponentForm {
  const family: CostFamily = "product_purchase";
  const meta = costFamilyMeta(family);
  return {
    scenarioId: null,
    editingId: null,
    label: "",
    family,
    slot: "default",
    kind: "percent_of_base",
    amount: "",
    percent: "",
    fixedAmount: "",
    fixedPer: "order",
    base: "line_net_sales",
    allocation: "revenue",
    period: "month",
    marginKind: "gross",
    currency: structure.reportingCurrency,
    fxPolicy: "transaction_date",
    fixedRate: "",
    decisionClass: meta.decisionClass,
    taxTreatment: "unknown",
    recognition: "on_order",
    refundBehaviour: meta.refundBehaviour,
    evidence: "operator_estimate",
    sourceKind: "manual",
    sourceRef: "",
    replacesEmbedded: false,
    overrideOf: "",
    reason: "",
    auditNote: "",
    effectiveFrom: inputDate(structure.effectiveFrom) || todayIsoDate(),
    effectiveTo: "",
    embeds: [],
    scopeRules: [],
    rateLevel: "order",
    fallbackAmount: "",
    rateRows: [],
    bomLines: [],
    bomWastePercent: "",
    embeddedShares: [],
  };
}

const COST_SCENARIOS: ReadonlyArray<{
  id: CostScenarioId;
  title: string;
  detail: string;
}> = [
  {
    id: "supplier_unit",
    title: "Supplier or manufacturing cost",
    detail: "A defensible cost per sold unit.",
  },
  {
    id: "landed_cost",
    title: "Landed product cost",
    detail: "Unit cost already includes inbound freight and duties.",
  },
  {
    id: "loaded_ratio",
    title: "Loaded all-in ratio",
    detail: "A revenue rate that combines per-sale variable costs.",
  },
  {
    id: "all_expense_reference",
    title: "All-expense ratio",
    detail: "A historical rate mixing variable and overhead costs; reference only.",
  },
  {
    id: "payment_fee",
    title: "Payment or marketplace fee",
    detail: "Percentage plus a fixed transaction charge.",
  },
  {
    id: "shipping_rate",
    title: "Shipping or fulfilment rates",
    detail: "Order charge or weight-tier contract rates.",
  },
  {
    id: "bundle_bom",
    title: "Bundle or manufactured recipe",
    detail: "Resolve product cost from BOM quantities and waste.",
  },
  {
    id: "recurring_overhead",
    title: "Recurring overhead",
    detail: "Monthly software, payroll, rent or agency expense.",
  },
  {
    id: "margin_estimate",
    title: "Margin-based estimate",
    detail: "Use a stated margin when detailed costs are unavailable.",
  },
];

const SCENARIO_GUIDANCE: Record<
  CostScenarioId,
  { instruction: string; example: string }
> = {
  supplier_unit: {
    instruction: "Enter what one sold unit costs to buy or make.",
    example: "Example: 18.50 USD per unit.",
  },
  landed_cost: {
    instruction: "Enter one unit’s product cost after inbound freight and duties.",
    example: "Do not add inbound freight or duties again as separate costs.",
  },
  loaded_ratio: {
    instruction: "Enter the share of sales consumed by your combined per-sale costs.",
    example: "Example: enter 42 for a 42% loaded variable-cost rate.",
  },
  all_expense_reference: {
    instruction: "Enter the historic all-expense share of sales for comparison.",
    example: "This stays reference-only because it mixes variable and fixed costs.",
  },
  payment_fee: {
    instruction: "Enter the provider percentage and its fixed fee per order or unit.",
    example: "Example: 2.9% plus 0.30 USD per order.",
  },
  shipping_rate: {
    instruction: "Enter each carrier rate tier and an optional unmatched-order fallback.",
    example: "Use weight limits only when the contract actually depends on weight.",
  },
  bundle_bom: {
    instruction: "Add each recipe or bundle item with its quantity.",
    example: "Provide a SKU or variant ID; add unit cost only when it is known here.",
  },
  recurring_overhead: {
    instruction: "Enter the total recurring expense and choose its period.",
    example: "Example: 2,000 USD per month for software or rent.",
  },
  margin_estimate: {
    instruction: "Enter the gross or contribution margin you can support.",
    example: "Use this when detailed cost inputs are not available yet.",
  },
};

function formForScenario(
  structure: CommerceCostStructure,
  scenario: CostScenarioId,
): ComponentForm {
  const base = { ...defaultForm(structure), scenarioId: scenario };
  switch (scenario) {
    case "supplier_unit":
      return {
        ...base,
        label: "Supplier or manufacturing cost",
        kind: "amount_per_unit",
        evidence: "contracted_rate",
        sourceKind: "supplier_invoice",
      };
    case "landed_cost":
      return {
        ...base,
        label: "Landed product cost",
        kind: "amount_per_unit",
        embeds: ["inbound_logistics", "duties_import"],
        refundBehaviour: "reverse_on_restock",
        evidence: "contracted_rate",
        sourceKind: "supplier_invoice",
      };
    case "loaded_ratio":
      return {
        ...base,
        label: "Loaded variable cost",
        kind: "percent_of_base",
        embeds: CONTRIBUTION_COST_FAMILIES.filter((family) => family !== "product_purchase"),
        refundBehaviour: "product_share_only",
      };
    case "all_expense_reference":
      return {
        ...base,
        label: "All-expense ratio (reference)",
        slot: "all-expense-reference",
        kind: "percent_of_base",
        decisionClass: "informational",
        refundBehaviour: "non_recoverable",
        reason:
          "This rate mixes per-sale costs with allocated operating or fixed expenses and must not drive marginal decisions.",
        auditNote:
          "Reference-only composite. Break it into product, per-order and recurring components before decision-runtime cutover.",
      };
    case "payment_fee":
      return {
        ...base,
        family: "payment_processing",
        label: "Payment processing fee",
        kind: "percent_plus_fixed",
        refundBehaviour: "non_recoverable",
        evidence: "contracted_rate",
        sourceKind: "shopify_payouts",
      };
    case "shipping_rate":
      return {
        ...base,
        family: "outbound_shipping",
        label: "Shipping contract",
        kind: "rate_table",
        rateLevel: "order",
        rateRows: [{ weightMaxKg: "", amount: "" }],
        recognition: "on_fulfillment",
        refundBehaviour: "reverse_on_cancel_only",
        evidence: "contracted_rate",
        sourceKind: "carrier_invoice",
      };
    case "bundle_bom":
      return {
        ...base,
        label: "Bundle or recipe cost",
        kind: "bom",
        bomLines: [{ variantId: "", sku: "", quantity: "1", amount: "" }],
        evidence: "classified_attribute",
      };
    case "recurring_overhead":
      return {
        ...base,
        family: "overhead_fixed",
        label: "Recurring overhead",
        kind: "period_amount",
        period: "month",
        recognition: "on_period",
        refundBehaviour: "non_recoverable",
        decisionClass: "operating",
      };
    case "margin_estimate":
      return {
        ...base,
        label: "Stated gross margin",
        kind: "margin_input",
        marginKind: "gross",
        evidence: "operator_estimate",
        sourceKind: "manual",
      };
  }
}

function formFromComponent(component: CommerceCostComponent): ComponentForm {
  const basis = component.basis;
  return {
    scenarioId: null,
    editingId: component.id,
    label: component.label ?? "",
    family: component.family,
    slot: component.slot,
    kind: basis.kind,
    amount:
      "amount" in basis && typeof basis.amount === "number" ? String(basis.amount) : "",
    percent:
      basis.kind === "percent_of_base" || basis.kind === "percent_plus_fixed"
        ? String(basis.percent)
        : basis.kind === "margin_input"
          ? String(basis.marginPercent)
          : "",
    fixedAmount: basis.kind === "percent_plus_fixed" ? String(basis.fixedAmount) : "",
    fixedPer: basis.kind === "percent_plus_fixed" ? (basis.fixedPer ?? "order") : "order",
    base:
      basis.kind === "percent_of_base" ||
      basis.kind === "percent_plus_fixed" ||
      basis.kind === "margin_input"
        ? basis.base
        : "line_net_sales",
    allocation:
      "allocation" in basis && basis.allocation ? basis.allocation : "revenue",
    period: basis.kind === "period_amount" ? basis.period : "month",
    marginKind: basis.kind === "margin_input" ? basis.marginKind : "gross",
    currency: component.currency,
    fxPolicy: component.fx?.policy === "fixed_rate" ? "fixed_rate" : "transaction_date",
    fixedRate:
      component.fx?.policy === "fixed_rate" && typeof component.fx.fixedRate === "number"
        ? String(component.fx.fixedRate)
        : "",
    decisionClass: component.decisionClass ?? costFamilyMeta(component.family).decisionClass,
    taxTreatment: component.taxTreatment,
    recognition: component.recognition,
    refundBehaviour:
      component.refundBehaviour ?? costFamilyMeta(component.family).refundBehaviour,
    evidence: component.evidence,
    sourceKind: component.source.kind,
    sourceRef: component.source.ref ?? "",
    replacesEmbedded: component.replacesEmbedded ?? false,
    overrideOf: component.overrideOf ?? "",
    reason: component.reason ?? "",
    auditNote: component.audit?.note ?? "",
    effectiveFrom: inputDate(component.effectiveFrom),
    effectiveTo: inputDate(component.effectiveTo),
    embeds: [...(component.embeds ?? [])],
    scopeRules: component.scope.map((predicate) => ({
      dimension: predicate.dimension,
      operator: predicate.operator,
      key: predicate.key ?? "",
      values: (predicate.values ?? []).join(", "),
    })),
    rateLevel: basis.kind === "rate_table" ? basis.level : "order",
    fallbackAmount:
      basis.kind === "rate_table" && typeof basis.fallbackAmount === "number"
        ? String(basis.fallbackAmount)
        : "",
    rateRows:
      basis.kind === "rate_table"
        ? basis.rows.map((row) => ({
            weightMaxKg: typeof row.weightMaxKg === "number" ? String(row.weightMaxKg) : "",
            amount: String(row.amount),
            ...(row.when ? { when: row.when } : {}),
          }))
        : [],
    bomWastePercent:
      basis.kind === "bom" && typeof basis.wastePercent === "number"
        ? String(basis.wastePercent)
        : "",
    bomLines:
      basis.kind === "bom"
        ? basis.components.map((line) => ({
            variantId: line.variantId ?? "",
            sku: line.sku ?? "",
            quantity: String(line.quantity),
            amount: typeof line.amount === "number" ? String(line.amount) : "",
          }))
        : [],
    embeddedShares: (component.embeddedShares ?? []).map((share) => ({
      family: share.family,
      kind: share.kind,
      value: String(share.value),
    })),
  };
}

function buildBasis(form: ComponentForm): CostBasis {
  switch (form.kind) {
    case "amount_per_unit":
    case "amount_per_line":
      return { kind: form.kind, amount: numberFrom(form.amount, "Amount") };
    case "amount_per_order":
      return {
        kind: form.kind,
        amount: numberFrom(form.amount, "Amount"),
        allocation: form.allocation,
      };
    case "percent_of_base":
      return {
        kind: form.kind,
        percent: numberFrom(form.percent, "Percentage"),
        base: form.base,
        allocation: form.allocation,
      };
    case "percent_plus_fixed":
      return {
        kind: form.kind,
        percent: numberFrom(form.percent, "Percentage"),
        base: form.base,
        fixedAmount: numberFrom(form.fixedAmount, "Fixed fee"),
        fixedPer: form.fixedPer,
        allocation: form.allocation,
      };
    case "period_amount":
      return {
        kind: form.kind,
        amount: numberFrom(form.amount, "Recurring amount"),
        period: form.period,
        allocation: form.allocation,
      };
    case "margin_input":
      return {
        kind: form.kind,
        marginKind: form.marginKind,
        marginPercent: numberFrom(form.percent, "Margin"),
        base: form.base,
        allocation: form.allocation,
      };
    case "rate_table":
      return {
        kind: form.kind,
        level: form.rateLevel,
        rows: form.rateRows.map<CostRateTableRow>((row) => ({
          amount: numberFrom(row.amount, "Rate amount"),
          ...(row.when ? { when: row.when } : {}),
          ...(row.weightMaxKg.trim()
            ? { weightMaxKg: numberFrom(row.weightMaxKg, "Maximum weight") }
            : {}),
        })),
        ...(form.fallbackAmount.trim()
          ? { fallbackAmount: numberFrom(form.fallbackAmount, "Fallback amount") }
          : {}),
        allocation: form.allocation,
      };
    case "bom":
      return {
        kind: form.kind,
        components: form.bomLines.map<CostBomComponent>((line) => ({
          quantity: numberFrom(line.quantity, "Recipe quantity"),
          ...(line.variantId.trim() ? { variantId: line.variantId.trim() } : {}),
          ...(line.sku.trim() ? { sku: line.sku.trim() } : {}),
          ...(line.amount.trim() ? { amount: numberFrom(line.amount, "Known unit cost") } : {}),
        })),
        ...(form.bomWastePercent.trim()
          ? { wastePercent: numberFrom(form.bomWastePercent, "Waste percentage") }
          : {}),
      };
  }
}

function basisSummary(basis: CostBasis, currency: string) {
  switch (basis.kind) {
    case "amount_per_unit":
      return `${basis.amount.toLocaleString()} ${currency} / unit`;
    case "amount_per_line":
      return `${basis.amount.toLocaleString()} ${currency} / line`;
    case "amount_per_order":
      return `${basis.amount.toLocaleString()} ${currency} / order`;
    case "percent_of_base":
      return `${basis.percent}% of ${basis.base.replaceAll("_", " ")}`;
    case "percent_plus_fixed":
      return `${basis.percent}% + ${basis.fixedAmount.toLocaleString()} ${currency} / ${basis.fixedPer ?? "order"}`;
    case "period_amount":
      return `${basis.amount.toLocaleString()} ${currency} / ${basis.period}`;
    case "margin_input":
      return `${basis.marginPercent}% ${basis.marginKind} margin`;
    case "rate_table":
      return `${basis.rows.length} rate row${basis.rows.length === 1 ? "" : "s"}`;
    case "bom":
      return `${basis.components.length} BOM line${basis.components.length === 1 ? "" : "s"}`;
  }
}

function sourceCopy(source: CommerceCostModelSource) {
  if (source === "stored") return "Saved model";
  if (source === "legacy_preview") return "Legacy preview";
  return "New model";
}

function percentCopy(rate: number | null) {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export function CommerceCostModelEditor({
  structure,
  source,
  canEdit,
  saving,
  serverIssues = [],
  sourceWarnings = [],
  error,
  dirty,
  breakEvenPreview = null,
  breakEvenPreviewLoading = false,
  breakEvenPreviewError = null,
  targetPackBreakEvenRoas = null,
  onChange,
  onSave,
  onDiscard,
}: CommerceCostModelEditorProps) {
  const [form, setForm] = useState<ComponentForm | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [gapFamily, setGapFamily] = useState<CostFamily>("returns_loss");
  const editorRef = useRef<HTMLElement | null>(null);
  const isFormOpen = form !== null;
  const scenarioGuidance = form?.scenarioId ? SCENARIO_GUIDANCE[form.scenarioId] : null;

  useEffect(() => {
    if (!isFormOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const firstControl = editorRef.current?.querySelector<HTMLElement>("input, select, textarea, button");
    firstControl?.focus();
    return () => previouslyFocused?.focus();
  }, [isFormOpen]);

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setForm(null);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      editorRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const localIssues = useMemo(() => validateCostStructure(structure), [structure]);
  const issues = dirty ? localIssues : serverIssues.length > 0 ? serverIssues : localIssues;
  const errors = issues.filter((issue) => issue.severity === "error");
  const activeComponents = structure.components.filter((component) => component.status === "active");
  const retiredCount = structure.components.filter((component) => component.status === "retired").length;

  const updateFamily = (family: CostFamily) => {
    const meta = costFamilyMeta(family);
    setForm((current) =>
      current
        ? {
            ...current,
            family,
            decisionClass: meta.decisionClass,
            refundBehaviour: meta.refundBehaviour,
            kind: meta.layer === "fixed" ? "period_amount" : current.kind,
            recognition: meta.layer === "fixed" ? "on_period" : current.recognition,
          }
        : current,
    );
  };

  const saveForm = () => {
    if (!form) return;
    try {
      const now = new Date().toISOString();
      const existing = form.editingId
        ? structure.components.find((component) => component.id === form.editingId)
        : null;
      const id = existing?.id ?? globalThis.crypto?.randomUUID?.() ?? `cost-${Date.now()}`;
      const component: CommerceCostComponent = {
        ...(existing ?? {}),
        id,
        version: (existing?.version ?? 0) + 1,
        family: form.family,
        slot: form.slot.trim() || "default",
        label: form.label.trim() || costFamilyMeta(form.family).label,
        scope: form.scopeRules.map<CostScopePredicate>((rule, index) => {
          const key = rule.key.trim();
          const values = rule.values
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          if (rule.dimension === "metafield" && !key) {
            throw new Error(`Scope condition ${index + 1} needs a metafield key.`);
          }
          if (rule.operator !== "exists" && values.length === 0) {
            throw new Error(`Scope condition ${index + 1} needs at least one value.`);
          }
          return {
            dimension: rule.dimension,
            operator: rule.operator,
            ...(key ? { key } : {}),
            ...(rule.operator === "exists" ? {} : { values }),
          };
        }),
        basis: buildBasis(form),
        embeds: form.embeds,
        embeddedShares: form.embeddedShares.map<CostEmbeddedShare>((share) => ({
          family: share.family,
          kind: share.kind,
          value: numberFrom(share.value, "Included cost share"),
        })),
        replacesEmbedded: form.replacesEmbedded || undefined,
        currency: form.currency.trim().toUpperCase(),
        fx:
          form.currency.trim().toUpperCase() === structure.reportingCurrency.toUpperCase()
            ? undefined
            : form.fxPolicy === "fixed_rate"
              ? {
                  policy: "fixed_rate",
                  fixedRate: numberFrom(form.fixedRate, "Fixed exchange rate"),
                }
              : { policy: "transaction_date" },
        taxTreatment: form.taxTreatment,
        effectiveFrom: instantFromDate(form.effectiveFrom, structure.effectiveFrom),
        effectiveTo: form.effectiveTo ? instantFromDate(form.effectiveTo, structure.effectiveFrom) : null,
        recordedAt: now,
        recognition: form.kind === "period_amount" ? "on_period" : form.recognition,
        refundBehaviour: form.refundBehaviour,
        evidence: form.evidence,
        source: {
          kind: form.sourceKind,
          ...(form.sourceRef.trim() ? { ref: form.sourceRef.trim() } : {}),
        },
        decisionClass: form.decisionClass,
        overrideOf: form.overrideOf.trim() || null,
        reason: form.reason.trim() || null,
        status: "active",
        audit: {
          ...(existing?.audit ?? {}),
          createdAt: existing?.audit?.createdAt ?? now,
          note: form.auditNote.trim() || null,
        },
      };
      onChange({
        ...structure,
        origin: "operator",
        confirmed: false,
        conflicts: (structure.conflicts ?? []).filter(
          (conflict) => conflict.family !== component.family || conflict.slot !== component.slot,
        ),
        components: existing
          ? structure.components.map((candidate) =>
              candidate.id === existing.id ? component : candidate,
            )
          : [...structure.components, component],
      });
      setForm(null);
      setAdvanced(false);
      setFormError(null);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "The cost could not be added.");
    }
  };

  const retire = (component: CommerceCostComponent) => {
    const now = new Date().toISOString();
    onChange({
      ...structure,
      confirmed: false,
      conflicts: (structure.conflicts ?? []).filter(
        (conflict) => conflict.family !== component.family || conflict.slot !== component.slot,
      ),
      components: structure.components.map((candidate) =>
        candidate.id === component.id
          ? { ...candidate, version: candidate.version + 1, status: "retired", recordedAt: now }
          : candidate,
      ),
    });
  };

  const addGap = () => {
    onChange({
      ...structure,
      confirmed: false,
      notTracked: [...new Set([...(structure.notTracked ?? []), gapFamily])],
    });
  };

  return (
    <article className={styles.shell} data-testid="commerce-cost-model-editor">
      <header className={styles.header}>
        <div>
          <div className={styles.kickerRow}>
            <span className={styles.kicker}>COST MODEL</span>
            <span className={`${styles.sourcePill} ${styles[`source_${source}`]}`}>
              {sourceCopy(source)}
            </span>
          </div>
          <h2 className={styles.title}>How revenue becomes contribution and profit</h2>
          <p className={styles.lede}>
            Keep product, order, marketing and fixed costs separate. Loaded rates can declare what
            they already include, so Adsecute does not subtract the same money twice.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onDiscard}
            disabled={!dirty || saving}
          >
            Discard
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onSave}
            disabled={!canEdit || !dirty || saving || errors.length > 0}
          >
            <Save size={15} aria-hidden="true" />
            {saving ? "Saving…" : "Save cost model"}
          </button>
        </div>
      </header>

      <div className={styles.boundaryNote} role="note">
        <CircleHelp size={16} aria-hidden="true" />
        <span>
          {source === "legacy_preview"
            ? "This is a read-only reconstruction of the percentages used today. Review what each rate includes before the first save."
            : source === "empty"
              ? "No cost assumptions are stored yet. Missing costs remain unknown; Adsecute will not turn them into zero."
              : "This model is stored and versioned. Overview and decision-runtime cutover stays separate until source coverage is verified."}
        </span>
      </div>

      <section className={styles.breakEvenPreview} aria-labelledby="break-even-preview-title">
        <div className={styles.previewHeader}>
          <div className={styles.previewHeading}>
            <span className={styles.previewIcon}><Calculator size={17} aria-hidden="true" /></span>
            <div>
              <div className={styles.previewTitleRow}>
                <h3 id="break-even-preview-title">Break-even ROAS preview</h3>
                <FieldHelpTip label="break-even ROAS preview">
                  Break-even ROAS is 1 divided by contribution margin. Only variable costs that
                  follow a sale are included; ad spend and fixed overhead stay outside this rate.
                </FieldHelpTip>
              </div>
              <p>What the current cost-model draft implies before any decision-system cutover.</p>
            </div>
          </div>
          <span className={styles.previewMode}>
            {breakEvenPreview?.status === "provisional"
              ? `Known-cost floor · ${dirty ? "unsaved draft" : "current model"}`
              : dirty
                ? "Unsaved draft"
                : "Current model"}
          </span>
        </div>

        {breakEvenPreviewLoading ? (
          <div className={styles.previewLoading} role="status">Calculating from the current draft…</div>
        ) : (breakEvenPreview?.status === "ready" || breakEvenPreview?.status === "provisional") &&
          breakEvenPreview.breakEvenRoas !== null ? (
          <>
            <div className={styles.previewMetrics}>
              <div className={styles.previewPrimary}>
                <span>
                  {breakEvenPreview.status === "provisional"
                    ? "KNOWN-COST ROAS FLOOR"
                    : "MODEL-IMPLIED BREAK-EVEN"}
                </span>
                <strong>{breakEvenPreview.breakEvenRoas.toFixed(2)}x</strong>
                <small>
                  {breakEvenPreview.status === "provisional"
                    ? "Missing costs can only raise this threshold"
                    : "Revenue needed per 1.00 of ad spend"}
                </small>
              </div>
              <div className={styles.previewMetric}>
                <span>{breakEvenPreview.status === "provisional" ? "KNOWN VARIABLE COSTS" : "VARIABLE COSTS"}</span>
                <strong>{percentCopy(breakEvenPreview.variableCostRate)}</strong>
                <small>Share of product revenue</small>
              </div>
              <div className={styles.previewMetric}>
                <span>{breakEvenPreview.status === "provisional" ? "MARGIN BEFORE GAPS" : "CONTRIBUTION MARGIN"}</span>
                <strong>{percentCopy(breakEvenPreview.contributionMarginRate)}</strong>
                <small>Before paid media and fixed costs</small>
              </div>
              <div className={styles.previewMetric}>
                <span>TARGET PACK</span>
                <strong>
                  {typeof targetPackBreakEvenRoas === "number"
                    ? `${targetPackBreakEvenRoas.toFixed(2)}x`
                    : "Not set"}
                </strong>
                <small>Manual break-even stays authoritative</small>
              </div>
            </div>
            <div className={styles.previewEvidence}>
              <span>
                Window {breakEvenPreview.window.startDate} – {breakEvenPreview.window.endDate}
              </span>
              {breakEvenPreview.assumptions.map((assumption) => (
                <span key={assumption}>{assumption}</span>
              ))}
            </div>
            {breakEvenPreview.status === "provisional" ? (
              <div className={styles.previewCaution} role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{breakEvenPreview.blockers.slice(0, 3).join(" ")}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className={styles.previewIncomplete} role="status">
            <div>
              <strong>
                {breakEvenPreviewError
                  ? "Preview unavailable"
                  : breakEvenPreview?.status === "invalid"
                    ? "Fix the cost-model conflict to calculate break-even"
                    : "Complete the missing inputs to calculate break-even"}
              </strong>
              <p>
                {breakEvenPreviewError ??
                  breakEvenPreview?.blockers.slice(0, 3).join(" ") ??
                  "The current draft does not yet contain enough cost information."}
              </p>
            </div>
            <div className={styles.previewComparison}>
              <span>Target Pack</span>
              <strong>
                {typeof targetPackBreakEvenRoas === "number"
                  ? `${targetPackBreakEvenRoas.toFixed(2)}x`
                  : "Not set"}
              </strong>
            </div>
          </div>
        )}

        <p className={styles.previewBoundary}>
          Preview only. It does not update the Target Pack, Overview, Meta, Google or decision automation.
        </p>
      </section>

      {sourceWarnings.length > 0 ? (
        <div className={styles.sourceWarnings} role="status">
          {sourceWarnings.map((warning) => (
            <p key={warning}>
              <AlertTriangle size={14} aria-hidden="true" />
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <section className={styles.scenarioSection} aria-labelledby="cost-scenarios-title">
        <div className={styles.scenarioHeader}>
          <div>
            <span className={styles.kicker}>GUIDED SETUP</span>
            <h3 id="cost-scenarios-title">Choose what you already know</h3>
          </div>
          <p>You only need the main number first. Accounting defaults can be reviewed later.</p>
        </div>
        <ol className={styles.scenarioSteps} aria-label="Add a cost in three steps">
          <li><span>1</span>Choose the closest description</li>
          <li><span>2</span>Enter the highlighted number</li>
          <li><span>3</span>Review and add the cost</li>
        </ol>
        <div className={styles.scenarioGrid}>
          {COST_SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className={styles.scenarioCard}
              onClick={() => {
                setForm(formForScenario(structure, scenario.id));
                setAdvanced(false);
                setFormError(null);
              }}
              disabled={!canEdit || saving}
            >
              <strong>{scenario.title}</strong>
              <span>{scenario.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.layerRail} aria-label="Cost model layers">
        {LAYERS.map(({ layer, label, note }) => {
          const layerComponents = activeComponents.filter(
            (component) => costFamilyMeta(component.family).layer === layer,
          );
          const layerErrors = issues.filter(
            (issue) => issue.family && costFamilyMeta(issue.family).layer === layer,
          ).length;
          return (
            <div key={layer} className={styles.layerCell}>
              <div className={styles.layerTop}>
                <span className={styles.layerLabel}>{label}</span>
                <span className={layerErrors > 0 ? styles.layerCountAlert : styles.layerCount}>
                  {layerComponents.length}
                </span>
              </div>
              <span className={styles.layerNote}>{note}</span>
            </div>
          );
        })}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarSummary}>
          <b>{activeComponents.length}</b> active costs
          {retiredCount > 0 ? <span>· {retiredCount} retired</span> : null}
          <span>· {structure.notTracked?.length ?? 0} acknowledged gaps</span>
        </div>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => {
            setForm(defaultForm(structure));
            setAdvanced(false);
            setFormError(null);
          }}
          disabled={!canEdit || saving}
        >
          <Plus size={15} aria-hidden="true" /> Add cost
        </button>
      </div>

      <div className={styles.componentList}>
        {activeComponents.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No cost components yet</strong>
            <span>Add the costs the business can defend. Leave the rest unknown.</span>
          </div>
        ) : (
          LAYERS.map(({ layer, label }) => {
            const layerComponents = activeComponents.filter(
              (component) => costFamilyMeta(component.family).layer === layer,
            );
            if (layerComponents.length === 0) return null;
            return (
              <section key={layer} className={styles.componentGroup}>
                <h3>{label}</h3>
                {layerComponents.map((component) => {
                  const componentIssues = issues.filter((issue) =>
                    issue.componentIds.includes(component.id),
                  );
                  return (
                    <div key={component.id} className={styles.componentRow}>
                      <div className={styles.componentIdentity}>
                        <span className={styles.familyLabel}>
                          {costFamilyMeta(component.family).label}
                        </span>
                        <strong>{component.label ?? costFamilyMeta(component.family).label}</strong>
                        <span className={styles.componentMeta}>
                          {component.scope.length === 0
                            ? "Store-wide"
                            : `${component.scope.length} scope rule${component.scope.length === 1 ? "" : "s"}`}
                          {component.embeds?.length
                            ? ` · includes ${component.embeds.map((family) => costFamilyMeta(family).label).join(", ")}`
                            : ""}
                        </span>
                      </div>
                      <div className={styles.componentAmount}>
                        <strong>{basisSummary(component.basis, component.currency)}</strong>
                        <span>
                          {DECISION_LABELS[
                            component.decisionClass ?? costFamilyMeta(component.family).decisionClass
                          ]}
                          {component.taxTreatment === "unknown" ? " · tax basis unknown" : ""}
                        </span>
                      </div>
                      <div className={styles.componentStatus}>
                        {componentIssues.length > 0 ? (
                          <span className={styles.issueBadge}>
                            <AlertTriangle size={13} aria-hidden="true" /> {componentIssues.length}
                          </span>
                        ) : (
                          <span className={styles.okBadge}>
                            <Check size={13} aria-hidden="true" /> ready
                          </span>
                        )}
                      </div>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          aria-label={`Edit ${component.label ?? costFamilyMeta(component.family).label}`}
                          onClick={() => {
                            setForm(formFromComponent(component));
                            setAdvanced(false);
                            setFormError(null);
                          }}
                          disabled={!canEdit || saving}
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Retire ${component.label ?? costFamilyMeta(component.family).label}`}
                          onClick={() => retire(component)}
                          disabled={!canEdit || saving}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })
        )}
      </div>

      <section className={styles.gaps}>
        <div>
          <h3>Known gaps</h3>
          <p>“Not tracked” stays missing in profit calculations. Use an explicit 0 cost for a real zero.</p>
        </div>
        <div className={styles.gapControls}>
          <select
            value={gapFamily}
            onChange={(event) => setGapFamily(event.target.value as CostFamily)}
            aria-label="Cost family not tracked"
            disabled={!canEdit || saving}
          >
            {COST_FAMILIES.filter((family) => family !== "marketing_paid").map((family) => (
              <option key={family} value={family}>
                {costFamilyMeta(family).label}
              </option>
            ))}
          </select>
          <button type="button" onClick={addGap} disabled={!canEdit || saving}>
            Acknowledge gap
          </button>
        </div>
        {(structure.notTracked ?? []).length > 0 ? (
          <div className={styles.gapTags}>
            {(structure.notTracked ?? []).map((family) => (
              <button
                type="button"
                key={family}
                onClick={() =>
                  onChange({
                    ...structure,
                    confirmed: false,
                    notTracked: (structure.notTracked ?? []).filter((candidate) => candidate !== family),
                  })
                }
                disabled={!canEdit || saving}
                aria-label={`Remove ${costFamilyMeta(family).label} gap`}
              >
                {costFamilyMeta(family).label} ×
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {(structure.conflicts ?? []).length > 0 ? (
        <section className={styles.conflicts} aria-live="polite">
          <h3>Resolve source differences</h3>
          <p>These legacy values disagree. Edit the affected cost and save the value the business accepts.</p>
          {(structure.conflicts ?? []).map((conflict) => (
            <div key={`${conflict.family}:${conflict.slot}`} className={styles.conflictRow}>
              <strong>{costFamilyMeta(conflict.family).label}</strong>
              <span>
                {conflict.candidates
                  .map((candidate) => {
                    const sourceLabel = candidate.source.ref === "business_cost_models"
                      ? "Current cost model"
                      : candidate.source.ref === "business_target_packs"
                        ? "Commercial Truth target pack"
                        : "Legacy source";
                    return `${sourceLabel}: ${candidate.value ?? "unknown"}%`;
                  })
                  .join(" · ")}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <label className={styles.confirmation}>
        <input
          type="checkbox"
          checked={structure.confirmed}
          onChange={(event) =>
            onChange({
              ...structure,
              origin: event.target.checked && source === "legacy_preview" ? "operator" : structure.origin,
              confirmed: event.target.checked,
            })
          }
          disabled={
            !canEdit ||
            saving ||
            activeComponents.length === 0 ||
            errors.length > 0 ||
            (structure.conflicts?.length ?? 0) > 0
          }
        />
        <span>
          <strong>I confirm what these costs include</strong>
          <small>
            The amounts, revenue bases, scopes and included families above describe this business.
          </small>
        </span>
      </label>

      {issues.length > 0 ? (
        <section className={styles.issuePanel} aria-live="polite">
          <h3>{errors.length > 0 ? "Resolve before saving" : "Review notes"}</h3>
          <ul>
            {issues.slice(0, 8).map((issue, index) => (
              <li key={`${issue.code}-${index}`} data-severity={issue.severity}>
                <span>{issue.severity === "error" ? "Error" : "Review"}</span>
                {issue.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <p className={styles.saveError}>{error}</p> : null}

      {form ? (
        <div className={styles.editorBackdrop} role="presentation">
          <section
            ref={editorRef}
            className={styles.editorPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cost-editor-title"
            onKeyDown={handleEditorKeyDown}
          >
            <header className={styles.editorHeader}>
              <div>
                <span className={styles.kicker}>{form.editingId ? "EDIT COST" : "NEW COST"}</span>
                <h3 id="cost-editor-title">
                  {form.editingId ? "Update cost component" : "Add a cost component"}
                </h3>
              </div>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setForm(null)}
                aria-label="Close cost editor"
              >
                ×
              </button>
            </header>

            <div className={styles.guidedIntro}>
              <span>{form.editingId ? "REVIEW THE MAIN INPUTS" : "START HERE"}</span>
              <strong>
                {scenarioGuidance?.instruction ??
                  (form.editingId
                    ? "Update the value that changed; advanced settings can stay as they are."
                    : "Choose how the cost is calculated, then enter its required value.")}
              </strong>
              <p>
                {scenarioGuidance?.example ??
                  "The defaults cover the common case. Open Advanced settings only when your accounting treatment, scope or source differs."}
              </p>
            </div>

            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <div className={styles.fieldHeading}>
                  <label htmlFor="commerce-cost-name">Name</label>
                  <FieldHelpTip label="cost name">
                    Use a name you will recognize later, such as “Supplier cost” or “Monthly software”.
                  </FieldHelpTip>
                </div>
                <input
                  id="commerce-cost-name"
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                  placeholder="e.g. fully loaded product cost"
                />
              </div>
              <div className={styles.formField}>
                <div className={styles.fieldHeading}>
                  <label htmlFor="commerce-cost-family">Cost category</label>
                  <FieldHelpTip label="cost category">
                    Choose what the money pays for. This controls where the cost appears in profit calculations.
                  </FieldHelpTip>
                </div>
                <select id="commerce-cost-family" aria-label="Cost family" value={form.family} onChange={(event) => updateFamily(event.target.value as CostFamily)}>
                  {COST_FAMILIES.filter((family) => family !== "marketing_paid").map((family) => (
                    <option key={family} value={family}>
                      {costFamilyMeta(family).label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`${styles.formField} ${styles.formWide}`}>
                <div className={styles.fieldHeading}>
                  <label htmlFor="commerce-cost-calculation">How do you know this cost?</label>
                  <FieldHelpTip label="cost calculation">
                    Pick the format of the number you have: a percentage of sales, an amount per
                    unit or order, a recurring total, a margin, a rate table or a recipe.
                  </FieldHelpTip>
                </div>
                <select
                  id="commerce-cost-calculation"
                  aria-label="How it is calculated"
                  value={form.kind}
                  onChange={(event) => setForm({ ...form, kind: event.target.value as EditableBasisKind })}
                >
                  {COMMON_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </div>

              {form.kind === "margin_input" ? (
                <label>
                  <span>Margin type</span>
                  <select
                    value={form.marginKind}
                    onChange={(event) =>
                      setForm({ ...form, marginKind: event.target.value as "gross" | "contribution" })
                    }
                  >
                    <option value="gross">Gross margin</option>
                    <option value="contribution">Contribution margin</option>
                  </select>
                </label>
              ) : null}

              {form.kind === "percent_of_base" ||
              form.kind === "percent_plus_fixed" ||
              form.kind === "margin_input" ? (
                <>
                  <div className={styles.formField}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="commerce-cost-percentage">
                        {form.kind === "margin_input" ? "Margin %" : "Percentage"}
                      </label>
                      <FieldHelpTip label={form.kind === "margin_input" ? "margin percentage" : "cost percentage"}>
                        Enter the percentage as a whole number. For example, enter 42 for 42%.
                      </FieldHelpTip>
                    </div>
                    <input
                      id="commerce-cost-percentage"
                      inputMode="decimal"
                      value={form.percent}
                      onChange={(event) => setForm({ ...form, percent: event.target.value })}
                      placeholder="Required"
                    />
                  </div>
                  <div className={styles.formField}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="commerce-cost-percentage-base">Percentage applies to</label>
                      <FieldHelpTip label="percentage base">
                        This is the sales amount used to calculate the percentage. Net product sales
                        is the usual choice for product and variable-cost rates.
                      </FieldHelpTip>
                    </div>
                    <select id="commerce-cost-percentage-base" aria-label="Percentage base" value={form.base} onChange={(event) => setForm({ ...form, base: event.target.value as CostBase })}>
                      {COST_BASES.map((base) => (
                        <option key={base} value={base}>
                          {base.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}

              {form.kind.startsWith("amount_") || form.kind === "period_amount" ? (
                <div className={styles.formField}>
                  <div className={styles.fieldHeading}>
                    <label htmlFor="commerce-cost-amount">Amount</label>
                    <FieldHelpTip label="cost amount">
                      Enter the amount in the currency selected below. The calculation choice tells
                      Adsecute whether it applies per unit, order, line or period.
                    </FieldHelpTip>
                  </div>
                  <input
                    id="commerce-cost-amount"
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(event) => setForm({ ...form, amount: event.target.value })}
                    placeholder="Required"
                  />
                </div>
              ) : null}

              {form.kind === "percent_plus_fixed" ? (
                <>
                  <label>
                    <span>Fixed fee</span>
                    <input
                      inputMode="decimal"
                      value={form.fixedAmount}
                      onChange={(event) => setForm({ ...form, fixedAmount: event.target.value })}
                      placeholder="Required"
                    />
                  </label>
                  <label>
                    <span>Fixed fee applies per</span>
                    <select
                      value={form.fixedPer}
                      onChange={(event) => setForm({ ...form, fixedPer: event.target.value as "order" | "unit" })}
                    >
                      <option value="order">Order</option>
                      <option value="unit">Unit</option>
                    </select>
                  </label>
                </>
              ) : null}

              {form.kind === "period_amount" ? (
                <label>
                  <span>Recurring period</span>
                  <select value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value as CostPeriod })}>
                    {COST_PERIODS.map((period) => (
                      <option key={period} value={period}>
                        {period}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {form.kind === "rate_table" ? (
                <fieldset className={`${styles.formWide} ${styles.structuredField}`}>
                  <legend>Rate tiers</legend>
                  <div className={styles.compactPair}>
                    <label>
                      <span>Rate applies per</span>
                      <select
                        value={form.rateLevel}
                        onChange={(event) =>
                          setForm({ ...form, rateLevel: event.target.value as "order" | "unit" })
                        }
                      >
                        <option value="order">Order</option>
                        <option value="unit">Unit</option>
                      </select>
                    </label>
                    <label>
                      <span>Fallback amount (optional)</span>
                      <input
                        inputMode="decimal"
                        value={form.fallbackAmount}
                        onChange={(event) => setForm({ ...form, fallbackAmount: event.target.value })}
                        placeholder="No fallback"
                      />
                    </label>
                  </div>
                  <div className={styles.structuredList}>
                    {form.rateRows.map((row, index) => (
                      <div key={index} className={styles.structuredRow}>
                        <label>
                          <span>Max weight kg (optional)</span>
                          <input
                            inputMode="decimal"
                            value={row.weightMaxKg}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                rateRows: form.rateRows.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, weightMaxKg: event.target.value }
                                    : candidate,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          <span>Amount</span>
                          <input
                            inputMode="decimal"
                            value={row.amount}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                rateRows: form.rateRows.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, amount: event.target.value }
                                    : candidate,
                                ),
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              rateRows: form.rateRows.filter((_, candidateIndex) => candidateIndex !== index),
                            })
                          }
                          aria-label={`Remove rate tier ${index + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.inlineAdd}
                    onClick={() =>
                      setForm({
                        ...form,
                        rateRows: [...form.rateRows, { weightMaxKg: "", amount: "" }],
                      })
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Add rate tier
                  </button>
                </fieldset>
              ) : null}
              {form.kind === "bom" ? (
                <fieldset className={`${styles.formWide} ${styles.structuredField}`}>
                  <legend>Recipe or bundle items</legend>
                  <label className={styles.compactInput}>
                    <span>Waste / yield loss (optional)</span>
                    <div className={styles.percentField}>
                      <input
                        inputMode="decimal"
                        value={form.bomWastePercent}
                        onChange={(event) =>
                          setForm({ ...form, bomWastePercent: event.target.value })
                        }
                        placeholder="0"
                        aria-label="BOM waste percentage"
                      />
                      <span>%</span>
                    </div>
                  </label>
                  <div className={styles.structuredList}>
                    {form.bomLines.map((line, index) => (
                      <div key={index} className={`${styles.structuredRow} ${styles.bomRow}`}>
                        {([
                          ["SKU", "sku"],
                          ["Variant ID", "variantId"],
                          ["Quantity", "quantity"],
                          ["Known unit cost (optional)", "amount"],
                        ] as const).map(([label, key]) => (
                          <label key={key}>
                            <span>{label}</span>
                            <input
                              inputMode={key === "quantity" || key === "amount" ? "decimal" : undefined}
                              value={line[key]}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  bomLines: form.bomLines.map((candidate, candidateIndex) =>
                                    candidateIndex === index
                                      ? { ...candidate, [key]: event.target.value }
                                      : candidate,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              bomLines: form.bomLines.filter((_, candidateIndex) => candidateIndex !== index),
                            })
                          }
                          aria-label={`Remove recipe item ${index + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.inlineAdd}
                    onClick={() =>
                      setForm({
                        ...form,
                        bomLines: [
                          ...form.bomLines,
                          { variantId: "", sku: "", quantity: "1", amount: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Add recipe item
                  </button>
                </fieldset>
              ) : null}

              <div className={styles.formField}>
                <div className={styles.fieldHeading}>
                  <label htmlFor="commerce-cost-currency">Currency</label>
                  <FieldHelpTip label="cost currency">
                    Use the currency of the source amount. Adsecute asks for a conversion rule only
                    when it differs from the reporting currency.
                  </FieldHelpTip>
                </div>
                <input id="commerce-cost-currency" value={form.currency} maxLength={3} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
              </div>
              {form.currency.trim().toUpperCase() !== structure.reportingCurrency.toUpperCase() ? (
                <>
                  <label>
                    <span>Currency conversion</span>
                    <select
                      value={form.fxPolicy}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          fxPolicy: event.target.value as ComponentForm["fxPolicy"],
                        })
                      }
                    >
                      <option value="transaction_date">Transaction-date rate</option>
                      <option value="fixed_rate">Fixed rate</option>
                    </select>
                  </label>
                  {form.fxPolicy === "fixed_rate" ? (
                    <label>
                      <span>{structure.reportingCurrency} per 1 {form.currency || "unit"}</span>
                      <input
                        inputMode="decimal"
                        value={form.fixedRate}
                        onChange={(event) => setForm({ ...form, fixedRate: event.target.value })}
                        placeholder="Required"
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {form.kind === "amount_per_order" ||
              form.kind === "percent_of_base" ||
              form.kind === "percent_plus_fixed" ||
              form.kind === "period_amount" ||
              form.kind === "margin_input" ||
              form.kind === "rate_table" ? (
                <div className={styles.formField}>
                  <div className={styles.fieldHeading}>
                    <label htmlFor="commerce-cost-allocation">How to spread this cost</label>
                    <FieldHelpTip label="cost allocation">
                      Choose how an order-level, period-level or shared cost is divided across
                      products. Revenue is the common default for percentage-based costs.
                    </FieldHelpTip>
                  </div>
                  <select id="commerce-cost-allocation" aria-label="Allocation" value={form.allocation} onChange={(event) => setForm({ ...form, allocation: event.target.value as CostAllocationDriver })}>
                    {COST_ALLOCATION_DRIVERS.map((driver) => (
                      <option key={driver} value={driver}>
                        {ALLOCATION_LABELS[driver]}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <DatePicker
                value={form.effectiveFrom || null}
                onChange={(value) => setForm({ ...form, effectiveFrom: value ?? "" })}
                label="Effective from"
                allowClear={false}
                className={styles.datePicker}
                testId="commerce-cost-effective-from"
              />
              <DatePicker
                value={form.effectiveTo || null}
                onChange={(value) => setForm({ ...form, effectiveTo: value ?? "" })}
                label="Effective until (optional)"
                placeholder="No end date"
                minDate={form.effectiveFrom || undefined}
                className={styles.datePicker}
                testId="commerce-cost-effective-until"
              />
            </div>

            <div className={styles.advancedRow}>
              <button type="button" className={styles.advancedToggle} onClick={() => setAdvanced((current) => !current)} aria-expanded={advanced}>
                {advanced ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                <span>
                  <strong>{advanced ? "Hide advanced settings" : "Advanced settings"}</strong>
                  <small>Accounting, refunds and scope</small>
                </span>
              </button>
              <FieldHelpTip label="advanced cost settings">
                Use these only when the default refund treatment, accounting date, source,
                product scope or overlap handling does not match your setup.
              </FieldHelpTip>
            </div>

            {advanced ? (
              <div className={styles.formGrid}>
                <label>
                  <span>Decision use</span>
                  <select value={form.decisionClass} onChange={(event) => setForm({ ...form, decisionClass: event.target.value as CostDecisionClass })}>
                    {COST_DECISION_CLASSES.map((value) => <option key={value} value={value}>{DECISION_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Tax treatment</span>
                  <select value={form.taxTreatment} onChange={(event) => setForm({ ...form, taxTreatment: event.target.value as CostTaxTreatment })}>
                    {COST_TAX_TREATMENTS.map((value) => <option key={value} value={value}>{TAX_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Refund behaviour</span>
                  <select value={form.refundBehaviour} onChange={(event) => setForm({ ...form, refundBehaviour: event.target.value as CostRefundBehaviour })}>
                    {COST_REFUND_BEHAVIOURS.map((value) => <option key={value} value={value}>{REFUND_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Recognition</span>
                  <select value={form.recognition} onChange={(event) => setForm({ ...form, recognition: event.target.value as CostRecognition })}>
                    {COST_RECOGNITIONS.map((value) => <option key={value} value={value}>{RECOGNITION_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Evidence</span>
                  <select value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value as CostEvidenceTier })}>
                    {COST_EVIDENCE_TIERS.map((value) => <option key={value} value={value}>{EVIDENCE_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Source</span>
                  <select value={form.sourceKind} onChange={(event) => setForm({ ...form, sourceKind: event.target.value as CostSourceKind })}>
                    {COST_SOURCE_KINDS.map((value) => <option key={value} value={value}>{SOURCE_LABELS[value]}</option>)}
                  </select>
                </label>
                <label>
                  <span>Source reference (optional)</span>
                  <input
                    value={form.sourceRef}
                    onChange={(event) => setForm({ ...form, sourceRef: event.target.value })}
                    placeholder="Invoice, file or external record ID"
                  />
                </label>
                <label className={styles.inlineCheck}>
                  <input
                    type="checkbox"
                    checked={form.replacesEmbedded}
                    onChange={(event) =>
                      setForm({ ...form, replacesEmbedded: event.target.checked })
                    }
                  />
                  <span>Replace this family inside a loaded cost</span>
                </label>
                <label>
                  <span>Overrides another component (optional)</span>
                  <select
                    value={form.overrideOf}
                    onChange={(event) => setForm({ ...form, overrideOf: event.target.value })}
                  >
                    <option value="">No override</option>
                    {structure.components
                      .filter(
                        (component) =>
                          component.status === "active" &&
                          component.id !== form.editingId &&
                          component.family === form.family &&
                          component.slot === (form.slot.trim() || "default"),
                      )
                      .map((component) => (
                        <option key={component.id} value={component.id}>
                          {component.label ?? costFamilyMeta(component.family).label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={styles.formWide}>
                  <span>Reason for replacement or override (optional)</span>
                  <textarea
                    rows={2}
                    value={form.reason}
                    onChange={(event) => setForm({ ...form, reason: event.target.value })}
                    placeholder="Why this source supersedes the included or previous cost"
                  />
                </label>
                <label className={styles.formWide}>
                  <span>Audit note (optional)</span>
                  <textarea
                    rows={2}
                    value={form.auditNote}
                    onChange={(event) => setForm({ ...form, auditNote: event.target.value })}
                    placeholder="Contract period, method or reviewer note"
                  />
                </label>
                <label>
                  <span>Charge group</span>
                  <input
                    value={form.slot}
                    onChange={(event) => setForm({ ...form, slot: event.target.value })}
                    placeholder="default"
                  />
                </label>
                <fieldset className={styles.formWide}>
                  <legend>Already included in this amount</legend>
                  <div className={styles.familyChecks}>
                    {COST_FAMILIES.filter((family) => family !== form.family && costFamilyMeta(family).embeddable).map((family) => (
                      <label key={family}>
                        <input
                          type="checkbox"
                          checked={form.embeds.includes(family)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              embeds: event.target.checked
                                ? [...form.embeds, family]
                                : form.embeds.filter((candidate) => candidate !== family),
                              embeddedShares: event.target.checked
                                ? form.embeddedShares
                                : form.embeddedShares.filter((share) => share.family !== family),
                            })
                          }
                        />
                        {costFamilyMeta(family).label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className={`${styles.formWide} ${styles.structuredField}`}>
                  <legend>Where this cost applies</legend>
                  <p className={styles.fieldHelp}>Leave empty for the whole store. Add conditions for a market, SKU, shipping method or another segment.</p>
                  <div className={styles.structuredList}>
                    {form.scopeRules.map((rule, index) => (
                      <div key={index} className={`${styles.structuredRow} ${styles.scopeRow}`}>
                        <label>
                          <span>Field</span>
                          <select
                            value={rule.dimension}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                scopeRules: form.scopeRules.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, dimension: event.target.value as CostScopeDimension }
                                    : candidate,
                                ),
                              })
                            }
                          >
                            {COST_SCOPE_DIMENSIONS.map((dimension) => (
                              <option key={dimension} value={dimension}>
                                {dimension.replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Condition</span>
                          <select
                            value={rule.operator}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                scopeRules: form.scopeRules.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, operator: event.target.value as CostScopeOperator }
                                    : candidate,
                                ),
                              })
                            }
                          >
                            <option value="in">Matches any</option>
                            <option value="not_in">Excludes</option>
                            <option value="exists">Is present</option>
                          </select>
                        </label>
                        {rule.dimension === "metafield" ? (
                          <label>
                            <span>Metafield key</span>
                            <input
                              value={rule.key}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  scopeRules: form.scopeRules.map((candidate, candidateIndex) =>
                                    candidateIndex === index
                                      ? { ...candidate, key: event.target.value }
                                      : candidate,
                                  ),
                                })
                              }
                              placeholder="namespace.key"
                            />
                          </label>
                        ) : null}
                        {rule.operator !== "exists" ? (
                          <label>
                            <span>Values</span>
                            <input
                              value={rule.values}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  scopeRules: form.scopeRules.map((candidate, candidateIndex) =>
                                    candidateIndex === index
                                      ? { ...candidate, values: event.target.value }
                                      : candidate,
                                  ),
                                })
                              }
                              placeholder="Separate multiple values with commas"
                            />
                          </label>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              scopeRules: form.scopeRules.filter((_, candidateIndex) => candidateIndex !== index),
                            })
                          }
                          aria-label={`Remove scope condition ${index + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.inlineAdd}
                    onClick={() =>
                      setForm({
                        ...form,
                        scopeRules: [
                          ...form.scopeRules,
                          { dimension: "market", operator: "in", key: "", values: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Add condition
                  </button>
                </fieldset>

                <fieldset className={`${styles.formWide} ${styles.structuredField}`}>
                  <legend>Included cost breakdown (optional)</legend>
                  <p className={styles.fieldHelp}>Add a known share only when part of this loaded amount may later be replaced by a direct source.</p>
                  <div className={styles.structuredList}>
                    {form.embeddedShares.map((share, index) => (
                      <div key={index} className={styles.structuredRow}>
                        <label>
                          <span>Included cost</span>
                          <select
                            value={share.family}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                embeddedShares: form.embeddedShares.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, family: event.target.value as CostFamily }
                                    : candidate,
                                ),
                              })
                            }
                          >
                            {form.embeds.map((family) => (
                              <option key={family} value={family}>{costFamilyMeta(family).label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Share type</span>
                          <select
                            value={share.kind}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                embeddedShares: form.embeddedShares.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, kind: event.target.value as CostEmbeddedShare["kind"] }
                                    : candidate,
                                ),
                              })
                            }
                          >
                            <option value="percent_of_host">% of loaded amount</option>
                            <option value="amount_per_unit">Amount per unit</option>
                          </select>
                        </label>
                        <label>
                          <span>Value</span>
                          <input
                            inputMode="decimal"
                            value={share.value}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                embeddedShares: form.embeddedShares.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? { ...candidate, value: event.target.value }
                                    : candidate,
                                ),
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              embeddedShares: form.embeddedShares.filter((_, candidateIndex) => candidateIndex !== index),
                            })
                          }
                          aria-label={`Remove included cost share ${index + 1}`}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.inlineAdd}
                    disabled={form.embeds.length === 0}
                    onClick={() => {
                      const available = form.embeds.find(
                        (family) => !form.embeddedShares.some((share) => share.family === family),
                      ) ?? form.embeds[0];
                      if (!available) return;
                      setForm({
                        ...form,
                        embeddedShares: [
                          ...form.embeddedShares,
                          { family: available, kind: "percent_of_host", value: "" },
                        ],
                      });
                    }}
                  >
                    <Plus size={14} aria-hidden="true" /> Add known share
                  </button>
                </fieldset>
              </div>
            ) : null}

            {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
            <footer className={styles.editorFooter}>
              <button type="button" className={styles.secondaryButton} onClick={() => setForm(null)}>
                Cancel
              </button>
              <button type="button" className={styles.primaryButton} onClick={saveForm}>
                {form.editingId ? "Update cost" : "Add cost"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </article>
  );
}
