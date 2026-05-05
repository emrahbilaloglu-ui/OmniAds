import type { CommandCenterAction, CommandCenterSourceType } from "@/lib/command-center";
import type {
  CommandCenterExecutionApplyGatePosture,
  CommandCenterExecutionCapability,
  CommandCenterExecutionProofLevel,
  CommandCenterExecutionSupportMode,
} from "@/lib/command-center-execution";
import { META_AD_SET_ACTION_TYPES, META_GEO_ACTION_TYPES } from "@/lib/meta/decision-os";
import type { CreativeDecisionPrimaryAction } from "@/lib/creative-decision-os";

const REGISTRY_VERSION =
  "command-center-execution-capabilities.v1" as const;

const CREATIVE_PRIMARY_ACTIONS = [
  "promote_to_scaling",
  "keep_in_test",
  "hold_no_touch",
  "refresh_replace",
  "block_deploy",
  "retest_comeback",
] as const satisfies ReadonlyArray<CreativeDecisionPrimaryAction>;

const META_PLACEMENT_ACTIONS = [
  "keep_advantage_plus",
  "exception_review",
] as const;

const META_NO_TOUCH_ACTIONS = ["hold_no_touch"] as const;
const META_BUDGET_SHIFT_ACTIONS = ["budget_shift"] as const;

const ALLOWLIST_APPLY_NOTE =
  "Provider-backed apply is available only when the execution flag is enabled, the kill switch is inactive, and the business is in the Meta execution canary allowlist.";
const DISABLED_APPLY_NOTE =
  "Provider-backed apply is disabled for this family.";
const NOT_APPLICABLE_APPLY_NOTE =
  "No provider-backed apply path exists for this family in V3-06.";
const PROVIDER_ROLLBACK_NOTE =
  "Rollback restores the captured pre-apply ad set status and daily budget snapshot after a validated provider-backed apply.";
const NOT_AVAILABLE_ROLLBACK_NOTE =
  "No provider-backed rollback exists for this family.";

function formatTargetType(
  sourceType: CommandCenterSourceType,
): CommandCenterExecutionCapability["targetType"] {
  if (sourceType === "meta_adset_decision") return "adset";
  if (sourceType === "meta_budget_shift") return "campaign";
  if (sourceType === "meta_geo_decision") return "geo";
  if (sourceType === "meta_placement_anomaly") return "placement";
  if (sourceType === "creative_primary_decision") return "creative";
  return "unknown";
}

function buildCapability(input: {
  sourceSystem: CommandCenterExecutionCapability["sourceSystem"];
  sourceType: CommandCenterSourceType;
  recommendedAction: string | null;
  supportMode: CommandCenterExecutionSupportMode;
  applyGatePosture: CommandCenterExecutionApplyGatePosture;
  supportReason: string;
  operatorGuidance: string[];
  applyProofLevel?: CommandCenterExecutionProofLevel;
  rollbackProofLevel?: CommandCenterExecutionProofLevel;
  rollbackKind?: CommandCenterExecutionCapability["rollback"]["kind"];
  rollbackNote?: string | null;
  provider?: CommandCenterExecutionCapability["provider"];
  validationPlan?: string[];
}) {
  const applyGateNote =
    input.applyGatePosture === "allowlist_only"
      ? ALLOWLIST_APPLY_NOTE
      : input.applyGatePosture === "disabled"
        ? DISABLED_APPLY_NOTE
        : input.applyGatePosture === "enabled"
          ? "Provider-backed apply is available for this family."
          : NOT_APPLICABLE_APPLY_NOTE;

  return {
    registryVersion: REGISTRY_VERSION,
    capabilityKey: `${input.sourceType}:${input.recommendedAction ?? "family"}`,
    provider: input.provider ?? (input.supportMode === "supported" ? "meta" : "none"),
    targetType: formatTargetType(input.sourceType),
    sourceSystem: input.sourceSystem,
    sourceType: input.sourceType,
    recommendedAction: input.recommendedAction,
    supportMode: input.supportMode,
    applyGate: {
      posture: input.applyGatePosture,
      note: applyGateNote,
      requiresApproval: input.supportMode === "supported",
      requiresCanary: input.applyGatePosture === "allowlist_only",
      killSwitchAware: input.supportMode === "supported",
    },
    rollback: {
      kind: input.rollbackKind ?? "not_available",
      note: input.rollbackNote ?? NOT_AVAILABLE_ROLLBACK_NOTE,
    },
    applyProofLevel: input.applyProofLevel ?? "unsupported",
    rollbackProofLevel: input.rollbackProofLevel ?? "unsupported",
    supportReason: input.supportReason,
    operatorGuidance: input.operatorGuidance,
    validationPlan:
      input.validationPlan ??
      (input.supportMode === "supported"
        ? [
            "Re-read the live Meta ad set before apply and block if the preview target drifted.",
            "Re-read the live Meta ad set after apply and require the requested status or budget to be observable before marking execution successful.",
            "Store immutable before/requested/after provider diff evidence in execution audit.",
          ]
        : ["No provider-backed validation is available because this family is not in the supported subset."]),
  } satisfies CommandCenterExecutionCapability;
}

const META_ADSET_CAPABILITIES = META_AD_SET_ACTION_TYPES.map((actionType) =>
  buildCapability({
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    recommendedAction: actionType,
    supportMode:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "supported"
        : "manual_only",
    applyGatePosture:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "allowlist_only"
        : "not_applicable",
    applyProofLevel:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "provider_validated"
        : "unsupported",
    rollbackProofLevel:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "provider_validated"
        : "unsupported",
    rollbackKind:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "provider_rollback"
        : "not_available",
    rollbackNote:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? PROVIDER_ROLLBACK_NOTE
        : NOT_AVAILABLE_ROLLBACK_NOTE,
    supportReason:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? "Exact-target Meta ad set write-back exists for this action when the live ad set stays inside the safe daily-budget subset."
        : "This Meta ad set action still requires manual execution because V3 only supports provider-backed apply for pause, recover, scale budget, and reduce budget.",
    operatorGuidance:
      actionType === "pause" ||
      actionType === "recover" ||
      actionType === "scale_budget" ||
      actionType === "reduce_budget"
        ? [
            "Review the preview diff, preflight checks, and guardrails before apply.",
            "Use canary-gated apply only after workflow approval.",
          ]
        : [
            "Review the exact change in Meta Ads Manager.",
            "Complete the action manually and record the operator outcome if executed.",
          ],
  }),
);

const META_BUDGET_SHIFT_CAPABILITIES = META_BUDGET_SHIFT_ACTIONS.map((actionType) =>
  buildCapability({
    sourceSystem: "meta",
    sourceType: "meta_budget_shift",
    recommendedAction: actionType,
    supportMode: "manual_only",
    applyGatePosture: "not_applicable",
    supportReason:
      "Budget-shift recommendations stay manual-only because the decision layer does not ship exact provider-side donor and receiver mutation targets.",
    operatorGuidance: [
      "Inspect donor and receiver campaigns in Meta Ads Manager.",
      "Apply the transfer manually and preserve the documented guardrails.",
    ],
  }),
);

const META_GEO_CAPABILITIES = META_GEO_ACTION_TYPES.map((actionType) =>
  buildCapability({
    sourceSystem: "meta",
    sourceType: "meta_geo_decision",
    recommendedAction: actionType,
    supportMode: "unsupported",
    applyGatePosture: "not_applicable",
    supportReason:
      "GEO actions remain read-only in V3-06; no provider-backed execution path is provider-validated for pooled, isolated, or country-level routing actions.",
    operatorGuidance: [
      "Use the GEO board as decision support only.",
      "Execute any country or cluster changes manually in Meta Ads Manager.",
    ],
  }),
);

const META_PLACEMENT_CAPABILITIES = META_PLACEMENT_ACTIONS.map((actionType) =>
  buildCapability({
    sourceSystem: "meta",
    sourceType: "meta_placement_anomaly",
    recommendedAction: actionType,
    supportMode: "unsupported",
    applyGatePosture: "not_applicable",
    supportReason:
      "Placement anomaly actions remain unsupported because no exact provider-backed placement mutate path is provider-validated in this release.",
    operatorGuidance: [
      "Review the placement anomaly directly in Meta Ads Manager.",
      "Treat this card as operator guidance only.",
    ],
  }),
);

const META_NO_TOUCH_CAPABILITIES = META_NO_TOUCH_ACTIONS.map((actionType) =>
  buildCapability({
    sourceSystem: "meta",
    sourceType: "meta_no_touch_item",
    recommendedAction: actionType,
    supportMode: "unsupported",
    applyGatePosture: "not_applicable",
    supportReason:
      "No-touch items intentionally remain outside the execution subset. They are protective guidance, not write-back commands.",
    operatorGuidance: [
      "Leave the stable winner untouched unless a separate approved workflow overrides it.",
    ],
  }),
);

const CREATIVE_CAPABILITIES = CREATIVE_PRIMARY_ACTIONS.map((actionType) =>
  buildCapability({
    sourceSystem: "creative",
    sourceType: "creative_primary_decision",
    recommendedAction: actionType,
    supportMode: "unsupported",
    applyGatePosture: "not_applicable",
    supportReason:
      "Creative Decision OS actions remain outside the provider-backed execution subset. Creative workflow decisions still require human deployment and review.",
    operatorGuidance: [
      "Use the creative decision as planning guidance.",
      "Apply deployment, refresh, or block decisions through the existing manual creative workflow.",
    ],
  }),
);

export const COMMAND_CENTER_EXECUTION_CAPABILITY_REGISTRY = [
  ...META_ADSET_CAPABILITIES,
  ...META_BUDGET_SHIFT_CAPABILITIES,
  ...META_GEO_CAPABILITIES,
  ...META_PLACEMENT_CAPABILITIES,
  ...META_NO_TOUCH_CAPABILITIES,
  ...CREATIVE_CAPABILITIES,
] as const satisfies ReadonlyArray<CommandCenterExecutionCapability>;

export function resolveCommandCenterExecutionCapability(
  action: Pick<CommandCenterAction, "sourceSystem" | "sourceType" | "recommendedAction">,
) {
  const exactMatch = COMMAND_CENTER_EXECUTION_CAPABILITY_REGISTRY.find(
    (entry) =>
      entry.sourceSystem === action.sourceSystem &&
      entry.sourceType === action.sourceType &&
      entry.recommendedAction === action.recommendedAction,
  );
  if (exactMatch) return exactMatch;

  return buildCapability({
    sourceSystem: action.sourceSystem,
    sourceType: action.sourceType,
    recommendedAction: action.recommendedAction,
    supportMode: "unsupported",
    applyGatePosture: "not_applicable",
    supportReason:
      "This action family is not mapped into the V3-06 capability registry and must remain read-only until reviewed.",
    operatorGuidance: [
      "Treat this action as unsupported.",
      "Do not issue provider-side writes from the execution panel.",
    ],
  });
}
