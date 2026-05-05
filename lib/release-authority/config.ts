import type { ReleaseAuthorityFlagPosture } from "@/lib/release-authority/types";

function retiredFlagPosture(
  flagKeys: string[],
  summary: string,
): ReleaseAuthorityFlagPosture {
  return {
    mode: "disabled",
    flagKeys,
    summary,
  };
}

export const RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SHA =
  process.env.RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SHA?.trim() ||
  "fe3e23f5df5e9dd7f90cc2318ea7b66920e189d2";

export const RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SOURCE =
  process.env.RELEASE_AUTHORITY_PREVIOUS_KNOWN_GOOD_SOURCE?.trim() ||
  "docs/v3-01-release-authority.md";

export const RELEASE_AUTHORITY_CANONICAL_DOC =
  "docs/v3-01-release-authority.md";

export function resolveMetaDecisionOsFlagPosture() {
  return retiredFlagPosture(
    ["META_DECISION_OS_V1", "META_DECISION_OS_CANARY_BUSINESSES"],
    "Legacy Meta Decision OS is archived in Phase 4.1.",
  );
}

export function resolveCreativeDecisionOsFlagPosture() {
  return retiredFlagPosture(
    [
      "CREATIVE_DECISION_OS_V1",
      "CREATIVE_DECISION_OS_CANARY_BUSINESSES",
    ],
    "Legacy Creative Decision OS is archived in Phase 4.1.",
  );
}

export function resolveCommandCenterWorkflowFlagPosture() {
  return retiredFlagPosture(
    ["COMMAND_CENTER_V1", "COMMAND_CENTER_CANARY_BUSINESSES"],
    "Legacy Command Center workflow is archived in Phase 4.1.",
  );
}

export function resolveCommandCenterExecutionPreviewFlagPosture() {
  return retiredFlagPosture(
    ["COMMAND_CENTER_EXECUTION_V1"],
    "Legacy Command Center execution preview is archived in Phase 4.1.",
  );
}

export function resolveCommandCenterExecutionApplyFlagPosture() {
  return retiredFlagPosture(
    [
      "COMMAND_CENTER_EXECUTION_V1",
      "META_EXECUTION_APPLY_ENABLED",
      "META_EXECUTION_KILL_SWITCH",
      "META_EXECUTION_CANARY_BUSINESSES",
    ],
    "Legacy Command Center apply and rollback are archived in Phase 4.1.",
  );
}
