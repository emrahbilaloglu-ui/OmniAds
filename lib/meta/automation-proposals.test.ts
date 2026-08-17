import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));

const dbModule = await import("@/lib/db");

import {
  META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
  META_AUTOMATION_PROPOSAL_TTL_HOURS,
  evaluateProposalTransition,
  isProposalExpired,
  proposalActionForDecision,
  proposalActionLabel,
  proposalDecisionKey,
  proposalExpiryFor,
  raiseRuleAutomationProposal,
  type MetaAutomationProposalStatus,
} from "@/lib/meta/automation-proposals";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const RULE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("one queue, two origins", () => {
  it("never lets a rule and the projection queue the same pause twice", () => {
    const source = readFileSync("lib/meta/automation-proposals.ts", "utf8");
    const projection = source.slice(
      source.indexOf("export async function projectMetaAutomationProposals"),
      source.indexOf("export interface ReadMetaAutomationProposalsResult"),
    );

    // The projection skips an entity whose pending action slot is already held
    // — by a rule firing, or by anything else — and exempts only the exact row
    // it upserts onto, so refresh-in-place still works.
    expect(projection).toContain("held.status = 'pending'");
    expect(projection).toContain("held.proposed_action = 'pause'");
    expect(projection).toContain("held.origin = 'engine_decision'");
    // And it stamps its own origin rather than letting the default decide.
    expect(projection).toContain("'engine_decision',");
  });

  it("reads the queue as one collection, not one per origin", () => {
    const source = readFileSync("lib/meta/automation-proposals.ts", "utf8");
    const read = source.slice(
      source.indexOf("export async function readMetaAutomationProposalQueue"),
      source.indexOf("/** One proposal, scoped to the authorized business"),
    );

    // One FROM, no origin filter: the operator sees a single list.
    expect(read.match(/FROM meta_automation_proposals/g)).toHaveLength(1);
    expect(read).not.toContain("origin =");
  });

  it("has no second proposal table anywhere in the subsystem", () => {
    for (const file of [
      "lib/meta/automation-proposals.ts",
      "lib/meta/automation-proposal-intake.ts",
      "lib/meta/automation-rules-store.ts",
      "lib/migrations.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain(
        "meta_automation_rule_proposals",
      );
    }
  });
});

describe("raising a rule firing into the queue", () => {
  function recordingDb(rows: Array<Array<{ id: string }>>) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tagged = () => Promise.resolve([]);
    (tagged as unknown as { query: unknown }).query = (
      text: string,
      values: unknown[],
    ) => {
      calls.push({ text, values });
      return Promise.resolve(rows.shift() ?? []);
    };
    return { tagged, calls };
  }

  it("inserts one pending row and reports its id", async () => {
    const { tagged, calls } = recordingDb([[{ id: "proposal_1" }]]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await raiseRuleAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      ruleId: RULE_ID,
      dedupeKey: `${RULE_ID}:adset_1:2026-08-16`,
      scopeType: "adset",
      scopeId: "adset_1",
      proposedAction: "pause",
      entityLabel: "Retargeting 7d — DPA",
      reason: "ROAS below breakeven.",
      evidenceLabel: "breakeven 2.50 · 3d",
      evidenceRef: {},
      evaluatedForDate: "2026-08-16",
      now: NOW,
    });

    expect(result).toEqual({ status: "inserted", proposalId: "proposal_1" });
    expect(calls).toHaveLength(1);
    const statement = calls[0]!.text.replace(/\s+/g, " ");
    // Untargeted on purpose: two different unique indexes can refuse this row,
    // and naming one would turn the other into a thrown error mid-evaluation.
    expect(statement).toContain("ON CONFLICT DO NOTHING");
    expect(statement).not.toMatch(/ON CONFLICT \(/);
    expect(calls[0]!.values).toContain("adset:adset_1");
    expect(calls[0]!.values).toContain("Pause ad set");
    expect(calls[0]!.values).toContain(
      META_AUTOMATION_PROPOSAL_PRIMARY_CAPTION,
    );
  });

  it("joins the row that already holds the slot instead of queueing a second", async () => {
    const { tagged, calls } = recordingDb([[], [{ id: "proposal_held" }]]);
    vi.mocked(dbModule.getDb).mockReturnValue(tagged as never);

    const result = await raiseRuleAutomationProposal({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      ruleId: RULE_ID,
      dedupeKey: `${RULE_ID}:adset_1:2026-08-16`,
      scopeType: "adset",
      scopeId: "adset_1",
      proposedAction: "pause",
      entityLabel: null,
      reason: "ROAS below breakeven.",
      evidenceLabel: null,
      evidenceRef: {},
      evaluatedForDate: "2026-08-16",
      now: NOW,
    });

    expect(result).toEqual({
      status: "already_queued",
      proposalId: "proposal_held",
    });
    expect(calls[1]!.text.replace(/\s+/g, " ")).toContain(
      "status = 'pending'",
    );
  });
});
