/**
 * "Decisions to act on" counts what the server serves as act-now.
 *
 * The engine's verdict label and the state the server is willing to serve are
 * not the same fact, and the decision read is where they come apart: it hands
 * every hydrated row to `enforceMetaCommercialActionAuthority` and then to the
 * campaign-role guard, and both move the row to `decisionState: "watch"` while
 * leaving `decisionLabel` untouched. Counting labels therefore reported a
 * withheld scale as a task, and dropped every act-state row the engine happened
 * to label rebuild, swap or tune.
 *
 * The blocked row here is built by running the real guard rather than by hand,
 * so the suite fails if that coupling ever stops holding instead of asserting a
 * shape nothing produces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readLatestMetaDecisionSnapshot: vi.fn(),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import * as db from "@/lib/db";
import * as snapshot from "@/lib/meta/snapshot";
import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function recommendation(
  overrides: Partial<MetaRecommendation> = {},
): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    adsetId: "set_1",
    type: "adset_scale_budget",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.9,
    decisionLabel: "scale",
    decisionState: "act",
    decision: "Raise budget",
    title: "Scale the winner",
    why: "Above target",
    summary: "Mature scale candidate",
    recommendedAction: "Raise the daily budget",
    expectedImpact: "More volume",
    evidence: [],
    proposedAction: { kind: "budget_increase" },
    targetValue: { budget: 120 },
    ...overrides,
  } as MetaRecommendation;
}

/** A scale the server refuses to serve as actionable, produced by the guard. */
const withheldScale = enforceMetaCommercialActionAuthority(
  recommendation(),
  null,
);

/** An act-state row the engine labelled something other than scale or cut. */
const actRebuild = recommendation({
  id: "rec-2",
  level: "campaign",
  adsetId: undefined,
  campaignId: "camp_1",
  type: "rebuild_with_constraints",
  decisionLabel: "rebuild",
  decisionState: "act",
  title: "Rebuild mixed configuration",
});

function snapshotReturns(recommendations: MetaRecommendation[]) {
  vi.mocked(snapshot.readLatestMetaDecisionSnapshot).mockResolvedValue({
    status: "ok",
    snapshotDate: "2026-09-05",
    summary: {},
    recommendations,
  } as never);
}

function brief() {
  return buildMetaDailyBrief({
    businessId: BUSINESS,
    providerAccountId: "act_1",
    asOf: "2026-09-05",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const tag = (() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(async () => []) as never;
  vi.mocked(db.getDb).mockReturnValue(tag);
});

describe("the guard this card reads around", () => {
  it("moves the state and keeps the label, so the two disagree", () => {
    // The premise of everything below: if the guard ever started rewriting the
    // label too, filtering on it would no longer be the defect described here.
    expect(withheldScale.decisionState).toBe("watch");
    expect(withheldScale.decisionLabel).toBe("scale");
    expect(withheldScale.proposedAction).toBeUndefined();
  });
});

describe("the actionable count is the served state", () => {
  it("does not count a scale the server withheld", async () => {
    snapshotReturns([withheldScale]);

    const result = await brief();

    // The card says "Decisions to act on". This row carries no proposed action
    // and the decision surfaces hold it; presenting it as a task sent the
    // operator to a decision they cannot take.
    expect(result.decisions).toMatchObject({ state: "read", actionable: 0 });
    expect(result.decisions.top).toEqual([]);
  });

  it("counts an act-state decision the engine did not label scale or cut", async () => {
    snapshotReturns([actRebuild]);

    const result = await brief();

    expect(result.decisions.actionable).toBe(1);
    expect(result.decisions.top[0]).toMatchObject({
      scopeType: "campaign",
      scopeId: "camp_1",
      label: "rebuild",
    });
  });

  it("keeps the count and the list describing the same rows", async () => {
    snapshotReturns([
      withheldScale,
      actRebuild,
      recommendation({
        id: "rec-3",
        decisionLabel: "keep",
        decisionState: "watch",
        title: "Hold",
      }),
    ]);

    const result = await brief();

    // A card whose number and list disagree is worse than one merely wrong:
    // the label filter counted the withheld scale and listed it while the
    // rebuild it should have led with was absent from both.
    expect(result.decisions.actionable).toBe(1);
    expect(result.decisions.top).toHaveLength(1);
    expect(result.decisions.top[0]!.title).toBe("Rebuild mixed configuration");
  });
});
