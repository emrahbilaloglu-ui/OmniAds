import React from "react";
import { Badge } from "@/components/ui/badge";
import type {
  CommandCenterExecutionPreview,
  CommandCenterExecutionSupportMatrixEntry,
} from "@/lib/command-center-execution";
import { cn } from "@/lib/utils";

function formatLabel(value: string) {
  return value.replaceAll("_", " ");
}

function resolveProofTone(
  value: CommandCenterExecutionSupportMatrixEntry["applyProofLevel"],
) {
  if (value === "live_canary_proven") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (value === "provider_validated") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (value === "code_supported") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveSupportTone(
  mode: CommandCenterExecutionSupportMatrixEntry["supportMode"],
) {
  if (mode === "supported") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (mode === "manual_only") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveApplyGateTone(
  posture: CommandCenterExecutionSupportMatrixEntry["applyGate"]["posture"],
) {
  if (posture === "enabled") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (posture === "allowlist_only") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (posture === "disabled") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function resolveRollbackTone(
  kind: CommandCenterExecutionSupportMatrixEntry["rollback"]["kind"],
) {
  if (kind === "provider_rollback") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (kind === "recovery_note_only") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function CommandCenterExecutionSupportMatrix({
  preview,
}: {
  preview: Pick<
    CommandCenterExecutionPreview,
    "supportMode" | "supportMatrix" | "rollback" | "capability" | "preflight"
  >;
}) {
  const selectedEntry = preview.supportMatrix.selectedEntry;

  return (
    <div
      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"
      data-testid="command-center-execution-support-matrix"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Support matrix
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Family capability stays explicit. Current live safety gates still decide whether apply is available.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge
            variant="outline"
            className={resolveSupportTone(preview.supportMode)}
            data-testid="command-center-execution-selected-support-mode"
          >
            current preview: {formatLabel(preview.supportMode)}
          </Badge>
          <Badge
            variant="outline"
            className={resolveRollbackTone(preview.rollback.kind)}
            data-testid="command-center-execution-selected-rollback-kind"
          >
            rollback: {formatLabel(preview.rollback.kind)}
          </Badge>
          <Badge variant="outline" className="border-slate-200 bg-white text-slate-700">
            preflight: {preview.preflight.readyForApply ? "ready" : "blocked"}
          </Badge>
        </div>
      </div>

      <div
        className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-3"
        data-testid="command-center-execution-selected-support"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">
            Selected family: {selectedEntry.label}
          </p>
          <Badge variant="outline" className={resolveSupportTone(selectedEntry.supportMode)}>
            family: {formatLabel(selectedEntry.supportMode)}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-slate-700">{selectedEntry.supportReason}</p>
        <p className="mt-2 text-xs text-slate-600">
          Rollback truth: {selectedEntry.rollback.note ?? "No rollback note is available."}
        </p>
        <p className="mt-2 text-xs text-slate-600">
          Capability key: {preview.capability.capabilityKey}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          Apply / rollback proof: {formatLabel(preview.capability.applyProofLevel)} /{" "}
          {formatLabel(preview.capability.rollbackProofLevel)}
        </p>
      </div>

      <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
        {preview.supportMatrix.entries.map((entry) => {
          const isSelected = entry.familyKey === selectedEntry.familyKey;
          return (
            <div
              key={entry.familyKey}
              className={cn(
                "rounded-xl border bg-white px-3 py-3",
                isSelected ? "border-blue-300 shadow-sm" : "border-slate-200",
              )}
              data-testid={`command-center-execution-support-entry-${entry.familyKey}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">{entry.label}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className={resolveSupportTone(entry.supportMode)}>
                    {formatLabel(entry.supportMode)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={resolveApplyGateTone(entry.applyGate.posture)}
                  >
                    apply: {formatLabel(entry.applyGate.posture)}
                  </Badge>
                  <Badge variant="outline" className={resolveRollbackTone(entry.rollback.kind)}>
                    rollback: {formatLabel(entry.rollback.kind)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={resolveProofTone(entry.applyProofLevel)}
                  >
                    apply proof: {formatLabel(entry.applyProofLevel)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={resolveProofTone(entry.rollbackProofLevel)}
                  >
                    rollback proof: {formatLabel(entry.rollbackProofLevel)}
                  </Badge>
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-700">{entry.supportReason}</p>
              <p className="mt-1 text-xs text-slate-600">{entry.applyGate.note}</p>
              {entry.operatorGuidance.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {entry.operatorGuidance.map((guidance) => (
                    <li key={guidance}>{guidance}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
