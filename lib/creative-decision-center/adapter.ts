/**
 * Creative Decision Center v2.1 shadow buyer adapter.
 *
 * This module is the deterministic, table-driven bridge from an
 * already-produced V2.1 engine output (`CreativeDecisionOsV21Output`) and
 * explicit operator-facing context to a `CreativeDecisionCenterRowDecision`.
 *
 * Hard constraints (D003, D016, D019, D020, INVARIANTS):
 * - The adapter MUST NOT compute decisions from raw signals. It maps an
 *   already-V2.1 engine output + explicit context into the row decision
 *   contract. There is no hidden second decision engine here.
 * - The adapter MUST NOT import runtime engine, Meta, app, components, or
 *   archive modules. Only contract types/constants and the shared structural
 *   helpers in this center module are allowed.
 * - The adapter MUST NOT be wired into any production route, UI bucket, or
 *   default response in this slice. Shadow only.
 * - `actionBoard` keying still belongs to `buyerAction` (D019). The
 *   `executionAction` field is row-level metadata only.
 * - `executionAction` is emitted only when `buyerAction === "scale"` AND
 *   the operator-facing `campaignKind` is one of `"test" | "main" | "mixed"`.
 *   A missing or unlabeled campaign kind on a would-be scale row downgrades
 *   to a `diagnose_data` safety output with no executionAction (D016 +
 *   GOLDEN_CASES GC-036 / GC-042 alignment).
 * - Row confidence band is structurally capped to `"low"` when the engine
 *   output already advertises any missing data (INVARIANTS I20).
 */

import {
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
  type BuyerActionMappingRule,
  type CreativeDecisionCenterActionability,
  type CreativeDecisionCenterBuyerAction,
  type CreativeDecisionCenterConfidenceBand,
  type CreativeDecisionCenterExecutionAction,
  type CreativeDecisionCenterIdentityGrain,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionOsV21Output,
  type CreativeDecisionOsV21PrimaryDecision,
} from "./contracts";

export const CREATIVE_DECISION_CENTER_ADAPTER_VERSION =
  "creative-decision-center.shadow-adapter.v1";

/**
 * Operator-facing context the adapter requires to turn a V2.1 engine output
 * into a row decision. The adapter never derives these fields from raw
 * platform signals; they are explicit inputs from upstream pipelines.
 */
export interface CreativeDecisionCenterAdapterContext {
  creativeId: string;
  rowId?: string;
  identityGrain: CreativeDecisionCenterIdentityGrain;
  familyId?: string | null;
  /**
   * Campaign kind label from the upstream campaign-label resolver. Required
   * to be one of "test" | "main" | "mixed" for the executionAction to be
   * populated on a Scale verdict. Null or absent values are treated as an
   * unlabeled campaign and route the row through the D016 safety fallback.
   */
  campaignKind?: "test" | "main" | "mixed" | null;
}

/**
 * Free-form upstream label that drove this row (D020). Adapter pass-through.
 * Common values include V3 `keep`, `same_as_canonical`, `out_of_scope`,
 * but the adapter must not parse it for decision logic.
 */
export interface CreativeDecisionCenterAdapterAuditMetadata {
  sourceDecision?: string | null;
}

export interface CreativeDecisionCenterAdapterInput
  extends CreativeDecisionCenterAdapterAuditMetadata {
  engine: CreativeDecisionOsV21Output;
  context: CreativeDecisionCenterAdapterContext;
}

const BUYER_LABELS: Record<CreativeDecisionCenterBuyerAction, string> = {
  scale: "Scale",
  cut: "Cut",
  refresh: "Refresh",
  protect: "Protect",
  test_more: "Test more",
  watch_launch: "Watch launch",
  fix_delivery: "Fix delivery",
  fix_policy: "Fix policy",
  diagnose_data: "Diagnose data",
};

const EXECUTION_LABEL_HINTS: Record<
  CreativeDecisionCenterExecutionAction,
  string
> = {
  promote_to_main: "Promote to main",
  scale_budget: "Scale budget",
  controlled_scale: "Controlled scale",
};

const SCALE_CTA_BY_KIND: Record<
  NonNullable<CreativeDecisionCenterAdapterContext["campaignKind"]>,
  CreativeDecisionCenterExecutionAction
> = {
  test: "promote_to_main",
  main: "scale_budget",
  mixed: "controlled_scale",
};

const NEXT_STEP_TEMPLATES: Record<CreativeDecisionCenterBuyerAction, string> = {
  scale: "Confirm the scale move that matches the campaign kind.",
  cut: "Cut spend on this creative.",
  refresh: "Queue a refresh variant.",
  protect: "Protect this winner; avoid disruptive edits.",
  test_more: "Keep testing; signal is not yet decisive.",
  watch_launch: "Watch the launch window; do not scale or cut yet.",
  fix_delivery: "Investigate why this active row is not delivering.",
  fix_policy: "Resolve the policy or review block before resuming.",
  diagnose_data: "Resolve missing or stale data before acting.",
};

const SCALE_EXECUTION_STEP: Record<
  CreativeDecisionCenterExecutionAction,
  string
> = {
  promote_to_main: "Promote this test winner into the Main lane.",
  scale_budget: "Increase the budget on this Main-lane winner.",
  controlled_scale: "Review the structure before scaling this Mixed campaign.",
};

/**
 * Deterministic table-driven dispatch. Order matters: the first matching
 * rule wins. Each rule's `when` clause is purely structural - it reads
 * already-V2.1 fields from the engine output. There is no derivation from
 * raw signals here.
 */
const MAPPING_TABLE: readonly BuyerActionMappingRule[] = [
  // Delivery-class diagnostics - fix_delivery
  {
    id: "diagnose-delivery",
    when: { primaryDecision: "Diagnose", problemClass: "delivery" },
    output: {
      buyerAction: "fix_delivery",
      buyerLabel: BUYER_LABELS.fix_delivery,
      uiBucket: "fix_delivery",
      nextStepTemplate: NEXT_STEP_TEMPLATES.fix_delivery,
    },
  },
  // Policy-class diagnostics - fix_policy
  {
    id: "diagnose-policy",
    when: { primaryDecision: "Diagnose", problemClass: "policy" },
    output: {
      buyerAction: "fix_policy",
      buyerLabel: BUYER_LABELS.fix_policy,
      uiBucket: "fix_policy",
      nextStepTemplate: NEXT_STEP_TEMPLATES.fix_policy,
    },
  },
  // Launch monitoring on Diagnose verdict - watch_launch
  {
    id: "diagnose-launch-monitoring",
    when: { primaryDecision: "Diagnose", problemClass: "launch_monitoring" },
    output: {
      buyerAction: "watch_launch",
      buyerLabel: BUYER_LABELS.watch_launch,
      uiBucket: "watch_launch",
      nextStepTemplate: NEXT_STEP_TEMPLATES.watch_launch,
    },
  },
  // Default Diagnose -> diagnose_data
  {
    id: "diagnose-default",
    when: { primaryDecision: "Diagnose" },
    output: {
      buyerAction: "diagnose_data",
      buyerLabel: BUYER_LABELS.diagnose_data,
      uiBucket: "diagnose_data",
      nextStepTemplate: NEXT_STEP_TEMPLATES.diagnose_data,
    },
  },
  // Test More + launch monitoring -> watch_launch
  {
    id: "test-more-launch-monitoring",
    when: { primaryDecision: "Test More", problemClass: "launch_monitoring" },
    output: {
      buyerAction: "watch_launch",
      buyerLabel: BUYER_LABELS.watch_launch,
      uiBucket: "watch_launch",
      nextStepTemplate: NEXT_STEP_TEMPLATES.watch_launch,
    },
  },
  // Test More default -> test_more
  {
    id: "test-more-default",
    when: { primaryDecision: "Test More" },
    output: {
      buyerAction: "test_more",
      buyerLabel: BUYER_LABELS.test_more,
      uiBucket: "test_more",
      nextStepTemplate: NEXT_STEP_TEMPLATES.test_more,
    },
  },
  // Cut -> cut
  {
    id: "cut-default",
    when: { primaryDecision: "Cut" },
    output: {
      buyerAction: "cut",
      buyerLabel: BUYER_LABELS.cut,
      uiBucket: "cut",
      nextStepTemplate: NEXT_STEP_TEMPLATES.cut,
    },
  },
  // Refresh -> refresh
  {
    id: "refresh-default",
    when: { primaryDecision: "Refresh" },
    output: {
      buyerAction: "refresh",
      buyerLabel: BUYER_LABELS.refresh,
      uiBucket: "refresh",
      nextStepTemplate: NEXT_STEP_TEMPLATES.refresh,
    },
  },
  // Protect -> protect
  {
    id: "protect-default",
    when: { primaryDecision: "Protect" },
    output: {
      buyerAction: "protect",
      buyerLabel: BUYER_LABELS.protect,
      uiBucket: "protect",
      nextStepTemplate: NEXT_STEP_TEMPLATES.protect,
    },
  },
  // Scale: structural rule emits the buyerAction; executionAction is
  // assigned downstream from the context.campaignKind. The mapping rule
  // itself stays campaign-kind agnostic so the table remains readable.
  {
    id: "scale-default",
    when: { primaryDecision: "Scale" },
    output: {
      buyerAction: "scale",
      buyerLabel: BUYER_LABELS.scale,
      uiBucket: "scale",
      nextStepTemplate: NEXT_STEP_TEMPLATES.scale,
    },
  },
];

export const CREATIVE_DECISION_CENTER_ADAPTER_MAPPING_TABLE = MAPPING_TABLE;

export const CREATIVE_DECISION_CENTER_ADAPTER_UNLABELED_SCALE_REASON =
  "campaign_role_unresolved";

function matchesRule(
  engine: CreativeDecisionOsV21Output,
  rule: BuyerActionMappingRule,
): boolean {
  if (
    rule.when.primaryDecision &&
    rule.when.primaryDecision !== engine.primaryDecision
  ) {
    return false;
  }
  if (
    rule.when.problemClass &&
    rule.when.problemClass !== engine.problemClass
  ) {
    return false;
  }
  if (
    rule.when.actionability &&
    rule.when.actionability !== engine.actionability
  ) {
    return false;
  }
  if (rule.when.reasonTagsAny && rule.when.reasonTagsAny.length > 0) {
    const wanted = new Set(rule.when.reasonTagsAny);
    const intersects = engine.reasonTags.some((tag) => wanted.has(tag));
    if (!intersects) return false;
  }
  if (rule.when.requiredData && rule.when.requiredData.length > 0) {
    const missing = new Set(engine.missingData);
    const allRequired = rule.when.requiredData.every((entry) => !missing.has(entry));
    if (!allRequired) return false;
  }
  if (rule.when.blockersAbsent && rule.when.blockersAbsent.length > 0) {
    const present = new Set(engine.blockerReasons);
    const allAbsent = rule.when.blockersAbsent.every((entry) => !present.has(entry));
    if (!allAbsent) return false;
  }
  return true;
}

function findMatchingRule(
  engine: CreativeDecisionOsV21Output,
): BuyerActionMappingRule | null {
  for (const rule of MAPPING_TABLE) {
    if (matchesRule(engine, rule)) return rule;
  }
  return null;
}

function deriveConfidenceBand(
  engine: CreativeDecisionOsV21Output,
): CreativeDecisionCenterConfidenceBand {
  // INVARIANTS I20: rows whose engine output advertises missing data must not
  // ride at "high" confidence. The adapter applies this cap structurally
  // here so downstream consumers (drawer, tests) see the cap explicitly.
  if (engine.missingData.length > 0) return "low";
  if (engine.confidence >= 70) return "high";
  if (engine.confidence >= 40) return "medium";
  return "low";
}

function joinReasons(
  engine: CreativeDecisionOsV21Output,
): string[] {
  return [...engine.reasonTags];
}

function oneLineFromEngine(engine: CreativeDecisionOsV21Output): string {
  return engine.evidenceSummary;
}

interface ScaleResolution {
  executionAction: CreativeDecisionCenterExecutionAction | null;
  fellBackToDiagnose: boolean;
}

function resolveScaleExecution(
  context: CreativeDecisionCenterAdapterContext,
): ScaleResolution {
  if (
    context.campaignKind === "test" ||
    context.campaignKind === "main" ||
    context.campaignKind === "mixed"
  ) {
    return {
      executionAction: SCALE_CTA_BY_KIND[context.campaignKind],
      fellBackToDiagnose: false,
    };
  }
  return { executionAction: null, fellBackToDiagnose: true };
}

interface AdapterStep {
  buyerAction: CreativeDecisionCenterBuyerAction;
  buyerLabel: string;
  uiBucket: CreativeDecisionCenterBuyerAction;
  executionAction: CreativeDecisionCenterExecutionAction | null;
  nextStep: string;
  matchedRuleId: string | null;
  unlabeledScaleSafetyApplied: boolean;
}

function buildAdapterStep(
  engine: CreativeDecisionOsV21Output,
  context: CreativeDecisionCenterAdapterContext,
): AdapterStep {
  const rule = findMatchingRule(engine);
  if (!rule) {
    // No rule matched. Fall back to diagnose_data so the row stays safe.
    return {
      buyerAction: "diagnose_data",
      buyerLabel: BUYER_LABELS.diagnose_data,
      uiBucket: "diagnose_data",
      executionAction: null,
      nextStep: NEXT_STEP_TEMPLATES.diagnose_data,
      matchedRuleId: null,
      unlabeledScaleSafetyApplied: false,
    };
  }

  const buyerAction = rule.output.buyerAction;
  const baseStep: AdapterStep = {
    buyerAction,
    buyerLabel: rule.output.buyerLabel,
    uiBucket: rule.output.uiBucket,
    executionAction: null,
    nextStep: rule.output.nextStepTemplate,
    matchedRuleId: rule.id,
    unlabeledScaleSafetyApplied: false,
  };

  if (buyerAction !== "scale") {
    return baseStep;
  }

  const { executionAction, fellBackToDiagnose } = resolveScaleExecution(context);
  if (fellBackToDiagnose) {
    // D016 safety: a Scale verdict without a resolved automatic campaign
    // role must not present an execution action. Downgrade to diagnose_data
    // so the UI never offers `promote_to_main`/`scale_budget`/
    // `controlled_scale` while the role is unresolved.
    return {
      buyerAction: "diagnose_data",
      buyerLabel: BUYER_LABELS.diagnose_data,
      uiBucket: "diagnose_data",
      executionAction: null,
      nextStep: NEXT_STEP_TEMPLATES.diagnose_data,
      matchedRuleId: rule.id,
      unlabeledScaleSafetyApplied: true,
    };
  }

  return {
    ...baseStep,
    executionAction,
    nextStep: executionAction
      ? SCALE_EXECUTION_STEP[executionAction]
      : baseStep.nextStep,
    buyerLabel: executionAction
      ? `${BUYER_LABELS.scale} - ${EXECUTION_LABEL_HINTS[executionAction]}`
      : baseStep.buyerLabel,
  };
}

export interface CreativeDecisionCenterAdapterTrace {
  matchedRuleId: string | null;
  unlabeledScaleSafetyApplied: boolean;
  confidenceCapApplied: boolean;
}

export interface CreativeDecisionCenterAdapterResult {
  row: CreativeDecisionCenterRowDecision;
  trace: CreativeDecisionCenterAdapterTrace;
}

/**
 * Map a single V2.1 engine output into a row decision. Deterministic; same
 * input + same context produces the same output. The adapter never reads
 * runtime data, never mutates anything, and never imports from active
 * engine, Meta, UI, or archive modules.
 */
export function adaptCreativeDecisionToRow(
  input: CreativeDecisionCenterAdapterInput,
): CreativeDecisionCenterAdapterResult {
  const { engine, context } = input;
  const step = buildAdapterStep(engine, context);
  const confidenceBand = deriveConfidenceBand(engine);
  const confidenceCapApplied =
    engine.confidence >= 70 && engine.missingData.length > 0;

  const reasons = joinReasons(engine);
  const adjustedReasons = step.unlabeledScaleSafetyApplied
    ? [...reasons, CREATIVE_DECISION_CENTER_ADAPTER_UNLABELED_SCALE_REASON]
    : reasons;
  const adjustedOneLine = step.unlabeledScaleSafetyApplied
    ? `${oneLineFromEngine(engine)} (automatic campaign role unresolved; execution move blocked)`
    : oneLineFromEngine(engine);

  const row: CreativeDecisionCenterRowDecision = {
    scope: "creative",
    creativeId: context.creativeId,
    rowId: context.rowId,
    identityGrain: context.identityGrain,
    familyId: context.familyId ?? null,
    engine,
    buyerAction: step.buyerAction,
    buyerLabel: step.buyerLabel,
    uiBucket: step.uiBucket,
    executionAction: step.executionAction ?? null,
    sourceDecision: input.sourceDecision ?? null,
    confidenceBand,
    priority: engine.priority,
    oneLine: adjustedOneLine,
    reasons: adjustedReasons,
    nextStep: step.nextStep,
    missingData: [...engine.missingData],
  };

  return {
    row,
    trace: {
      matchedRuleId: step.matchedRuleId,
      unlabeledScaleSafetyApplied: step.unlabeledScaleSafetyApplied,
      confidenceCapApplied,
    },
  };
}

export function adaptCreativeDecisionsToRows(
  inputs: readonly CreativeDecisionCenterAdapterInput[],
): CreativeDecisionCenterAdapterResult[] {
  return inputs.map((input) => adaptCreativeDecisionToRow(input));
}

/**
 * Compile-time sanity: the adapter knows about every V2.1 primary decision.
 * If a new primary decision lands without a matching adapter rule, this
 * lookup will compile but the runtime dispatch will fall through to
 * `diagnose_data`. The unit tests assert no fall-through for the six
 * canonical V2.1 primaries.
 */
export function getAdapterPrimaryDecisionCoverage(): readonly CreativeDecisionOsV21PrimaryDecision[] {
  return CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS;
}

/**
 * Structural compile-time sanity around the actionability/CreativeDecisionCenterActionability
 * import path. The adapter does not consume actionability at runtime in v1 -
 * the engine output already provides it - but we reference the type here so
 * future rules can constrain on it without needing a new import.
 */
export type CreativeDecisionCenterAdapterActionabilityRef =
  CreativeDecisionCenterActionability;
