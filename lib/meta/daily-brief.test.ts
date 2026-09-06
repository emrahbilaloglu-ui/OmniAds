import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/anomalies", () => ({
  // The projection of the delivery_stall detector the bid policy reads. Real,
  // not stubbed: it is a pure filter over whatever the detector returned, and
  // stubbing it would hide the very wiring these suites now exercise.
  deliveryConstrainedAdsetIdsFrom: (anomalies: Array<{ type?: string; scopeType?: string; severity?: string; scopeId?: string }>) =>
    new Set(
      (anomalies ?? [])
        .filter((a) => a?.type === "delivery_stall" && a?.scopeType === "adset"
          && (a?.severity === "high" || a?.severity === "medium"))
        .map((a) => a.scopeId as string),
    ),
  readMetaAnomaliesForBusiness: vi.fn(),
}));
vi.mock("@/lib/meta/automation-proposals", () => ({
  readMetaAutomationProposalQueue: vi.fn(),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(),
}));

import * as db from "@/lib/db";
import * as anomalies from "@/lib/meta/anomalies";
import * as proposals from "@/lib/meta/automation-proposals";
import * as snapshot from "@/lib/meta/snapshot";
import * as controlPlane from "@/lib/meta/automation-control-plane";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function ledgerReturns(rows: unknown) {
  const tag = (() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(async () => {
    if (rows === null) throw new Error("ledger unreadable");
    return rows;
  }) as never;
  vi.mocked(db.getDb).mockReturnValue(tag);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(controlPlane.resolveEffectiveMetaModes).mockResolvedValue({
    pause: "semi_auto", bid: "manual", budget: "auto", creative: "manual",
  } as never);
  vi.mocked(anomalies.readMetaAnomaliesForBusiness).mockResolvedValue({
    anomalies: [
      { type: "zero_conversions_with_spend", severity: "high", scopeLabel: "Prospecting", title: "Spending with no purchases", detail: "$240" },
      { type: "cpm_spike", severity: "medium", scopeLabel: "Retargeting", title: "CPM spike", detail: "x" },
    ],
  } as never);
  vi.mocked(snapshot.readLatestMetaDecisionSnapshot).mockResolvedValue({
    status: "ok",
    snapshotDate: "2026-09-05",
    summary: {},
    recommendations: [
      // Served rows carry both facts. The label is the engine's verdict; the
      // state is what the server is willing to serve as act-now, and only the
      // second decides whether the brief calls it a task.
      { id: "r1", level: "adset", adsetId: "set_1", decisionLabel: "cut", decisionState: "act", title: "Pause ad set" },
      { id: "r2", level: "campaign", campaignId: "camp_1", decisionLabel: "scale", decisionState: "act", title: "Raise budget" },
      { id: "r3", level: "campaign", campaignId: "camp_2", decisionLabel: "keep", decisionState: "watch", title: "No change" },
    ],
  } as never);
  vi.mocked(proposals.readMetaAutomationProposalQueue).mockResolvedValue({
    readCompleteness: "complete",
    proposals: [{ id: "p1" }, { id: "p2" }],
  } as never);
  ledgerReturns([
    { result_status: "applied", count: 4 },
    { result_status: "failed", count: 1 },
  ]);
});

describe("the brief answers what happened and what is waiting", () => {
  it("assembles every section from its own producer", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });

    expect(brief.modes).toMatchObject({ state: "read", budget: "auto", pause: "semi_auto" });
    expect(brief.alerts).toMatchObject({ state: "read", high: 1, total: 2 });
    // Only what the server serves as act-now. A held row is not a task.
    expect(brief.decisions).toMatchObject({ state: "read", actionable: 2 });
    expect(brief.queue).toMatchObject({ state: "read", pending: 2 });
    expect(brief.appliedYesterday).toMatchObject({ state: "read", applied: 4, failed: 1 });
  });

  it("names the entity at its own grain", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    expect(brief.decisions.top[0]).toMatchObject({ scopeType: "adset", scopeId: "set_1" });
    expect(brief.decisions.top[1]).toMatchObject({ scopeType: "campaign", scopeId: "camp_1" });
  });

  it("reports staleness in days rather than implying today", async () => {
    vi.mocked(snapshot.readLatestMetaDecisionSnapshot).mockResolvedValue({
      status: "ok", snapshotDate: "2026-09-02", summary: {}, recommendations: [],
    } as never);

    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    // A brief built on a three-day-old snapshot is not wrong; reading it as
    // this morning's picture would be.
    expect(brief.freshness).toMatchObject({
      state: "read", lastSnapshotDate: "2026-09-02", staleDays: 3,
    });
  });
});

describe("a section that could not be read says so", () => {
  it("does not report zero alerts when the alert read failed", async () => {
    vi.mocked(anomalies.readMetaAnomaliesForBusiness).mockRejectedValue(new Error("x"));

    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    // "No alerts" and "the alert query did not answer" look identical on a
    // card and mean opposite things.
    expect(brief.alerts.state).toBe("unavailable");
  });

  it("does not report an empty queue for a business with no bound account", async () => {
    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: null, asOf: "2026-09-05",
    });
    expect(brief.queue).toMatchObject({ state: "unavailable", pending: 0 });
    expect(vi.mocked(proposals.readMetaAutomationProposalQueue)).not.toHaveBeenCalled();
  });

  it("does not report an empty queue when the read was incomplete", async () => {
    vi.mocked(proposals.readMetaAutomationProposalQueue).mockResolvedValue({
      readCompleteness: "unavailable", proposals: [],
    } as never);

    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    expect(brief.queue.state).toBe("unavailable");
  });

  it("does not report nothing applied when the ledger could not be read", async () => {
    ledgerReturns(null);

    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    expect(brief.appliedYesterday.state).toBe("unavailable");
  });

  it("does not report manual mode when the control plane could not be read", async () => {
    vi.mocked(controlPlane.resolveEffectiveMetaModes).mockRejectedValue(new Error("x"));

    const brief = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: "2026-09-05",
    });
    expect(brief.modes).toMatchObject({ state: "unavailable", budget: null });
  });
});
