import { describe, expect, it } from "vitest";

import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";

import {
  UNKNOWN,
  buildAutomationProposalsModel,
  expiresLabel,
} from "./automation-proposals-exact-adapter";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function proposal(
  overrides: Partial<MetaAutomationProposal> = {},
): MetaAutomationProposal {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    providerAccountId: "act_1",
    decisionKey: "adset:23848",
    scopeType: "adset",
    scopeId: "23848",
    recId: "rec_1",
    recType: "scenario_m3_mid_funnel_inefficient_cut",
    snapshotDate: "2026-08-17",
    engineVersion: "meta-v3",
    decisionLabel: "cut",
    proposedAction: "pause",
    actionLabel: "Pause ad set",
    primaryCaption: "Approve & apply",
    entityLabel: "Retargeting 7d — DPA",
    reason: "ROAS 1.94 below breakeven 2.50 for 6 consecutive days.",
    evidenceLabel: "frees $680/d",
    evidenceRef: { recId: "rec_1" },
    expiresAt: "2026-08-17T18:00:00.000Z",
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    receipt: null,
    createdAt: "2026-08-16T18:00:00.000Z",
    updatedAt: "2026-08-16T18:00:00.000Z",
    ...overrides,
  };
}

describe("the confirmation queue view model", () => {
  it("carries every field the design's row binds, from the record", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [proposal()],
      now: NOW,
    });

    expect(model.count).toBe("1");
    expect(model.rows).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        action: "Pause ad set",
        tone: "negative",
        entity: "Retargeting 7d — DPA",
        why: "ROAS 1.94 below breakeven 2.50 for 6 consecutive days.",
        evidence: "frees $680/d",
        expires: "in 6h",
        primaryCaption: "Approve & apply",
      },
    ]);
  });

  it("renders an em dash for every fact the record does not carry", () => {
    const [row] = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [proposal({ entityLabel: null, evidenceLabel: null })],
      now: NOW,
    }).rows;

    expect(row.entity).toBe(UNKNOWN);
    expect(row.evidence).toBe(UNKNOWN);
    // The facts that ARE carried are still rendered; the em dash is per field.
    expect(row.action).toBe("Pause ad set");
    expect(row.why).toContain("below breakeven");
  });

  it("keeps the count at an em dash when the read was not proven", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "unavailable",
      // Even with rows in hand, an unproven read must not claim a count.
      proposals: [proposal()],
      now: NOW,
    });

    expect(model.count).toBe(UNKNOWN);
    expect(model.rows).toEqual([]);
  });

  it("reports a proven empty queue as zero, not as unknown", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      now: NOW,
    });

    expect(model.count).toBe("0");
    expect(model.rows).toEqual([]);
  });

  it("uses the design's expiry granularity and never counts down past zero", () => {
    expect(
      expiresLabel({ expiresAt: "2026-08-17T12:45:00.000Z", now: NOW }),
    ).toBe("in 45m");
    expect(
      expiresLabel({ expiresAt: "2026-08-17T15:00:00.000Z", now: NOW }),
    ).toBe("in 3h");
    expect(
      expiresLabel({ expiresAt: "2026-08-20T12:00:00.000Z", now: NOW }),
    ).toBe("in 3d");
    expect(
      expiresLabel({ expiresAt: "2026-08-17T11:00:00.000Z", now: NOW }),
    ).toBe(UNKNOWN);
    expect(expiresLabel({ expiresAt: "nonsense", now: NOW })).toBe(UNKNOWN);
  });
});
