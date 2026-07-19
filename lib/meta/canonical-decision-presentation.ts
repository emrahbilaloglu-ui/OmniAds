import { adaptCreativeDecisionToRow } from "@/lib/creative-decision-center/adapter";
import {
  bridgeV3DecisionToV21,
  type CreativeDecisionCenterV3BridgeContext,
  type V3BridgeOmittedResult,
  type V3BridgeMappedResult,
} from "@/lib/creative-decision-center/v3-bridge";
import type { DecisionOutput } from "@/lib/creative-decision-engine/types";
import {
  classifyMetaCreativeAssessment,
  type MetaCreativeAssessmentPresentation,
} from "@/lib/meta/creative-assessment";
import {
  projectMetaDecisionSemantics,
  type MetaDecisionSemanticProjection,
} from "@/lib/meta/decision-semantics";
import type {
  MetaDecisionExecutionAction,
  MetaDecisionLifecycleRole,
} from "@/lib/meta/decisions-workspace-contract";

export type CanonicalMetaDecisionPresentationProjection =
  | {
      kind: "mapped";
      bridge: V3BridgeMappedResult;
      adapterRow: ReturnType<typeof adaptCreativeDecisionToRow>["row"];
      heldAction: "scale" | "cut" | "refresh" | null;
      assessment: MetaCreativeAssessmentPresentation;
      semantics: MetaDecisionSemanticProjection;
      buyerLabel: string;
      executionAction: MetaDecisionExecutionAction | null;
      blockerCodes: string[];
    }
  | {
      kind: "omitted";
      bridge: V3BridgeOmittedResult;
    };

function heldAction(
  value: DecisionOutput["blockedActionType"],
): "scale" | "cut" | "refresh" | null {
  return value === "scale" || value === "cut" || value === "refresh"
    ? value
    : null;
}

function heldActionBuyerLabel(action: "scale" | "cut" | "refresh") {
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} · Held`;
}

/**
 * One pure server projection for native/legacy canonical reads and the
 * committed demo generator. It composes the established V3 bridge, buyer
 * adapter, assessment vocabulary, and state/resolution semantics. Callers may
 * suppress execution metadata for review-only evidence, but cannot replace
 * any decision or buyer-action calculation.
 */
export function projectCanonicalMetaDecisionPresentation(input: {
  decision: DecisionOutput;
  context: CreativeDecisionCenterV3BridgeContext;
  lifecycleRole: MetaDecisionLifecycleRole;
  blockerCodes?: readonly string[];
  reviewOnly?: boolean;
}): CanonicalMetaDecisionPresentationProjection {
  const bridge = bridgeV3DecisionToV21({
    decision: input.decision,
    context: input.context,
  });
  if (bridge.kind === "omitted") {
    return { kind: "omitted", bridge };
  }

  const adapterRow = adaptCreativeDecisionToRow(bridge.adapterInput).row;
  const blockedAction = heldAction(input.decision.blockedActionType);
  const assessment = classifyMetaCreativeAssessment({
    label: input.decision.label,
    truthSource: input.decision.truthSource,
    badgeCodes: input.decision.badges.map((badge) => badge.type),
    heldAction: blockedAction,
  });
  const blockerCodes = Array.from(
    new Set(
      [
        ...bridge.engine.blockerReasons,
        ...(input.blockerCodes ?? []),
        assessment.blockerCode,
        input.decision.authorityBlocker,
      ].filter((code): code is string => Boolean(code)),
    ),
  ).sort();
  const semantics = projectMetaDecisionSemantics({
    legacyBuyerAction: adapterRow.buyerAction,
    sourceLabel: input.decision.label,
    lifecycleRole: input.lifecycleRole,
    badgeCodes: input.decision.badges.map((badge) => badge.type),
    blockerCodes,
    heldAction: blockedAction,
    authorityBlocker: input.decision.authorityBlocker,
  });

  return {
    kind: "mapped",
    bridge,
    adapterRow,
    heldAction: blockedAction,
    assessment,
    semantics,
    buyerLabel: blockedAction
      ? heldActionBuyerLabel(blockedAction)
      : adapterRow.buyerLabel,
    executionAction:
      input.reviewOnly || semantics.decisionState === "blocked"
        ? null
        : ((adapterRow.executionAction as MetaDecisionExecutionAction | null) ??
          null),
    blockerCodes,
  };
}
