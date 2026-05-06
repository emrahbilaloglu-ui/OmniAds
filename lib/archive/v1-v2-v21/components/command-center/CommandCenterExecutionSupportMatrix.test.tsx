import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterExecutionSupportMatrix } from "@/components/command-center/CommandCenterExecutionSupportMatrix";
import type { CommandCenterExecutionPreview } from "@/lib/command-center-execution";

const preview = {
  supportMode: "manual_only",
  capability: {
    registryVersion: "command-center-execution-capabilities.v1",
    capabilityKey: "meta_adset_decision:scale_budget",
    provider: "meta",
    targetType: "adset",
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    recommendedAction: "scale_budget",
    supportMode: "supported",
    applyGate: {
      posture: "allowlist_only",
      note: "Provider-backed apply is available only when the execution flag is enabled, the kill switch is inactive, and the business is in the Meta execution canary allowlist.",
      requiresApproval: true,
      requiresCanary: true,
      killSwitchAware: true,
    },
    rollback: {
      kind: "provider_rollback",
      note: "Rollback restores the captured pre-apply ad set status and daily budget snapshot.",
    },
    applyProofLevel: "provider_validated",
    rollbackProofLevel: "provider_validated",
    supportReason:
      "Exact-target Meta ad set write-back exists for this action when the ad set stays inside the safe daily-budget subset.",
    operatorGuidance: [
      "Review the preview diff and guardrails before apply.",
      "Use canary-gated apply only after workflow approval.",
    ],
    validationPlan: [
      "Re-read the live Meta ad set before apply and block if the preview target drifted.",
    ],
  },
  preflight: {
    generatedAt: "2026-04-12T00:00:00.000Z",
    readyForApply: false,
    blockingChecks: ["Workflow approval"],
    checks: [
      {
        key: "workflow_approved",
        label: "Workflow approval",
        required: true,
        status: "fail" as const,
        detail: "Approve the workflow action before apply.",
      },
    ],
  },
  rollback: {
    kind: "not_available",
    note: "Rollback is unavailable because the current preview has no provider-backed apply path.",
  },
  supportMatrix: {
    selectedEntry: {
      familyKey: "meta_adset_decision:scale_budget",
      label: "Meta ad set: scale budget",
      sourceSystem: "meta",
      sourceType: "meta_adset_decision",
      recommendedAction: "scale_budget",
      supportMode: "supported",
      applyGate: {
        posture: "allowlist_only",
        note: "Provider-backed apply is available only when the business is allowlisted.",
      },
      rollback: {
        kind: "provider_rollback",
        note: "Rollback restores the captured pre-apply ad set status and daily budget snapshot.",
      },
      applyProofLevel: "provider_validated",
      rollbackProofLevel: "provider_validated",
      supportReason:
        "Exact-target Meta ad set write-back exists for this action when the ad set stays inside the safe daily-budget subset.",
      operatorGuidance: [
        "Review the preview diff and guardrails before apply.",
        "Use canary-gated apply only after workflow approval.",
      ],
    },
    entries: [
      {
        familyKey: "meta_adset_decision:scale_budget",
        label: "Meta ad set: scale budget",
        sourceSystem: "meta",
        sourceType: "meta_adset_decision",
        recommendedAction: "scale_budget",
        supportMode: "supported",
        applyGate: {
          posture: "allowlist_only",
          note: "Provider-backed apply is available only when the business is allowlisted.",
        },
        rollback: {
          kind: "provider_rollback",
          note: "Rollback restores the captured pre-apply ad set status and daily budget snapshot.",
        },
        applyProofLevel: "provider_validated",
        rollbackProofLevel: "provider_validated",
        supportReason:
          "Exact-target Meta ad set write-back exists for this action when the ad set stays inside the safe daily-budget subset.",
        operatorGuidance: [
          "Review the preview diff and guardrails before apply.",
          "Use canary-gated apply only after workflow approval.",
        ],
      },
      {
        familyKey: "meta_budget_shift:budget_shift",
        label: "Meta budget shift: budget shift",
        sourceSystem: "meta",
        sourceType: "meta_budget_shift",
        recommendedAction: "budget_shift",
        supportMode: "manual_only",
        applyGate: {
          posture: "not_applicable",
          note: "No provider-backed apply path exists for this family in V2-07.",
        },
        rollback: {
          kind: "not_available",
          note: "No provider-backed rollback exists for this family.",
        },
        applyProofLevel: "unsupported",
        rollbackProofLevel: "unsupported",
        supportReason:
          "Budget-shift recommendations stay manual-only because the decision layer does not ship exact provider-side donor and receiver mutation targets.",
        operatorGuidance: [
          "Inspect donor and receiver campaigns in Meta Ads Manager.",
        ],
      },
    ],
  },
} satisfies Pick<
  CommandCenterExecutionPreview,
  "supportMode" | "rollback" | "supportMatrix" | "capability" | "preflight"
>;

describe("CommandCenterExecutionSupportMatrix", () => {
  it("renders the selected family, support matrix entries, and rollback truth", () => {
    const html = renderToStaticMarkup(
      <CommandCenterExecutionSupportMatrix preview={preview} />,
    );

    expect(html).toContain("Support matrix");
    expect(html).toContain("Selected family");
    expect(html).toContain("Meta ad set: scale budget");
    expect(html).toContain("current preview: manual only");
    expect(html).toContain("rollback: not available");
    expect(html).toContain("Capability key: meta_adset_decision:scale_budget");
    expect(html).toContain("Apply / rollback proof: provider validated / provider validated");
    expect(html).toContain("apply proof: provider validated");
    expect(html).toContain("preflight: blocked");
    expect(html).toContain("Meta budget shift: budget shift");
  });
});
