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
    origin: "engine_decision",
    ruleId: null,
    dedupeKey: null,
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
    // Claim fields are part of the row now. A fixture that omitted them would
    // let a test assert on a proposal shape the database can no longer produce.
    claimToken: null,
    claimedBy: null,
    claimedAt: null,
    dispatchStartedAt: null,
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

  /**
   * REWRITTEN, not deleted. The law it pinned — "a proven empty queue is `0`,
   * not `—`" — still holds and is still asserted. What changed is what counts
   * as PROVEN. A completed queue read only proves that no proposal needs
   * confirmation; it says nothing about the rows this account is holding open
   * without being approvable. The server has always sent those counts beside
   * the queue (`holds`), and the adapter used to drop them, so a queue with a
   * live dispatch in flight reported `0`.
   */
  it("reports a proven empty queue as zero once nothing is held either", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      holds: { claimed: 0, reconcile: 0 },
      now: NOW,
    });

    expect(model.count).toBe("0");
    expect(model.rows).toEqual([]);
    expect(model.provenEmpty).toBe(true);
    // A MEASURED zero stays a zero. This is the whole point of the field.
    expect(model.holds).toEqual({ claimed: 0, reconcile: 0 });
  });

  it("refuses to call the queue empty while a dispatch is in flight", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      holds: { claimed: 1, reconcile: 0 },
      now: NOW,
    });

    expect(model.count).toBe(UNKNOWN);
    expect(model.provenEmpty).toBe(false);
    expect(model.holds).toEqual({ claimed: 1, reconcile: 0 });
  });

  it("refuses to call the queue empty while a row awaits reconciliation", () => {
    // The invariant: an unsafe-to-terminalize row "stays pending ...
    // reconciliation required, and retry forbidden". It is not approvable, so
    // it is not a row here — and it is emphatically not nothing.
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      holds: { claimed: 0, reconcile: 2 },
      now: NOW,
    });

    expect(model.count).toBe(UNKNOWN);
    expect(model.provenEmpty).toBe(false);
  });

  it("treats an unread hold count as unknown, never as nothing held", () => {
    const unread = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      holds: null,
      now: NOW,
    });
    // A server that sends no `holds` field at all is the same statement: the
    // fact was not forwarded, so it was not proven.
    const absent = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [],
      now: NOW,
    });

    expect(unread.count).toBe(UNKNOWN);
    expect(unread.provenEmpty).toBe(false);
    expect(unread.holds).toBeNull();
    expect(absent.count).toBe(UNKNOWN);
    expect(absent.provenEmpty).toBe(false);
  });

  it("counts approvable rows only and never folds holds into the badge", () => {
    const model = buildAutomationProposalsModel({
      readCompleteness: "complete",
      proposals: [proposal()],
      holds: { claimed: 3, reconcile: 4 },
      now: NOW,
    });

    // "Needs your confirmation" is a count of what the operator can act on.
    // Holds are carried beside it and stated separately, never added in.
    expect(model.count).toBe("1");
    expect(model.holds).toEqual({ claimed: 3, reconcile: 4 });
    expect(model.provenEmpty).toBe(false);
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
