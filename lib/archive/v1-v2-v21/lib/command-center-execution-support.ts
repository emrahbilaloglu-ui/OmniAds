import type { CommandCenterAction } from "@/lib/command-center";
import type {
  CommandCenterExecutionSupportMatrix,
  CommandCenterExecutionSupportMatrixEntry,
} from "@/lib/command-center-execution";
import {
  COMMAND_CENTER_EXECUTION_CAPABILITY_REGISTRY,
  resolveCommandCenterExecutionCapability,
} from "@/lib/command-center-execution-capabilities";

function toSupportMatrixEntry(
  capability: typeof COMMAND_CENTER_EXECUTION_CAPABILITY_REGISTRY[number],
) {
  return {
    familyKey: capability.capabilityKey,
    label: `${capability.sourceType.replaceAll("_", " ")}: ${(
      capability.recommendedAction ?? "family"
    ).replaceAll("_", " ")}`,
    sourceSystem: capability.sourceSystem,
    sourceType: capability.sourceType,
    recommendedAction: capability.recommendedAction,
    supportMode: capability.supportMode,
    applyGate: capability.applyGate,
    rollback: capability.rollback,
    applyProofLevel: capability.applyProofLevel,
    rollbackProofLevel: capability.rollbackProofLevel,
    supportReason: capability.supportReason,
    operatorGuidance: capability.operatorGuidance,
  } satisfies CommandCenterExecutionSupportMatrixEntry;
}

export const COMMAND_CENTER_EXECUTION_SUPPORT_MATRIX =
  COMMAND_CENTER_EXECUTION_CAPABILITY_REGISTRY.map(toSupportMatrixEntry);

export function resolveCommandCenterExecutionSupportEntry(
  action: Pick<CommandCenterAction, "sourceSystem" | "sourceType" | "recommendedAction">,
) {
  return toSupportMatrixEntry(resolveCommandCenterExecutionCapability(action));
}

export function buildCommandCenterExecutionSupportMatrix(
  action: Pick<CommandCenterAction, "sourceSystem" | "sourceType" | "recommendedAction">,
): CommandCenterExecutionSupportMatrix {
  return {
    selectedEntry: resolveCommandCenterExecutionSupportEntry(action),
    entries: [...COMMAND_CENTER_EXECUTION_SUPPORT_MATRIX],
  };
}
