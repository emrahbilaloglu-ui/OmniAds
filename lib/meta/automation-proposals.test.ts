import { describe, expect, it } from "vitest";

import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  evaluateProposalTransition,
  isProposalExpired,
  proposalActionForDecision,
  proposalActionLabel,
  proposalDecisionKey,
  proposalExpiryFor,
  type MetaAutomationProposalStatus,
} from "@/lib/meta/automation-proposals";

const NOW = new Date("2026-08-17T12:00:00.000Z");

describe("which engine decisions may become a proposal", () => {
  it("projects a cut decision at campaign and ad-set grain as a pause", () => {
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "campaign" }),
    ).toEqual({ action: "pause", scopeType: "campaign" });
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "adset" }),
    ).toEqual({ action: "pause", scopeType: "adset" });
  });

  it("refuses every label that has no guarded endpoint to execute", () => {
    // `scale` is the design's own first prototype row. There is no guarded
    // budget-write endpoint in this repo, so projecting it would put a primary
    // button on screen whose only possible outcome is a failure.
    for (const decisionLabel of [
      "scale",
      "tune",
      "keep",
      "rebuild",
      "switch",
      "test_more",
      "diagnose",
      null,
    ]) {
      expect(
        proposalActionForDecision({ decisionLabel, scopeType: "adset" }),
      ).toBeNull();
    }
  });

  it("refuses ad grain, whose write path is the decision-origin contract", () => {
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "ad" }),
    ).toBeNull();
    expect(
      proposalActionForDecision({ decisionLabel: "cut", scopeType: "account" }),
    ).toBeNull();
  });

  it("labels the row with the design's own wording and caption", () => {
    expect(proposalActionLabel("pause", "adset")).toBe("Pause ad set");
    expect(proposalActionLabel("pause", "campaign")).toBe("Pause campaign");
    expect(META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION).toBe("Approve & apply");
  });

  it("keys a proposal by the same decision key the write ceremony parses", () => {
    expect(proposalDecisionKey("adset", "23848")).toBe("adset:23848");
  });
});

describe("expiry is one snapshot cadence", () => {
  it("derives the expiry from the decision row's own creation time", () => {
    expect(proposalExpiryFor("2026-08-17T09:00:00.000Z")).toBe(
      "2026-08-18T09:00:00.000Z",
    );
    expect(META_AUTOMATION_PROPOSAL_TTL_HOURS).toBe(24);
  });

  it("treats the exact expiry instant as expired, not as the last usable moment", () => {
    expect(
      isProposalExpired({ expiresAt: NOW.toISOString(), now: NOW }),
    ).toBe(true);
    expect(
      isProposalExpired({ expiresAt: "2026-08-17T12:00:00.001Z", now: NOW }),
    ).toBe(false);
  });

  it("treats an unparseable expiry as expired", () => {
    // Fail-closed: the alternative makes a corrupt timestamp the one way to
    // reach a provider write past the evidence that justified it.
    expect(isProposalExpired({ expiresAt: "not-a-date", now: NOW })).toBe(true);
  });
});

describe("the proposal state machine", () => {
  const pendingUntil = "2026-08-17T18:00:00.000Z";

  it("moves a live pending proposal to the state its control names", () => {
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "approve",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "approved" });
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "modify",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "modified" });
    expect(
      evaluateProposalTransition({
        status: "pending",
        expiresAt: pendingUntil,
        action: "dismiss",
        now: NOW,
      }),
    ).toEqual({ ok: true, next: "dismissed" });
  });

  it("refuses every already-decided state, including the server-written ones", () => {
    const decided: MetaAutomationProposalStatus[] = [
      "approved",
      "failed",
      "modified",
      "dismissed",
      "expired",
    ];
    for (const status of decided) {
      const result = evaluateProposalTransition({
        status,
        expiresAt: pendingUntil,
        action: "approve",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.refusal).toBe("proposal_not_pending");
    }
  });

  it("refuses an expired proposal for every control, including dismiss", () => {
    for (const action of ["approve", "modify", "dismiss"] as const) {
      const result = evaluateProposalTransition({
        status: "pending",
        expiresAt: "2026-08-17T11:59:59.000Z",
        action,
        now: NOW,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.refusal).toBe("proposal_expired");
    }
  });

  it("says the expired proposal will be re-evaluated rather than lost", () => {
    const result = evaluateProposalTransition({
      status: "pending",
      expiresAt: "2026-08-16T00:00:00.000Z",
      action: "approve",
      now: NOW,
    });
    expect(result.ok === false && result.message).toContain(
      "next snapshot re-evaluates it",
    );
  });
});
