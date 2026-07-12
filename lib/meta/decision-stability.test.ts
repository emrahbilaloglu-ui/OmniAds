import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMetaStateHysteresis,
  META_PENDING_TRANSITION_REASON_PREFIX,
  metaStabilityKey,
  readPreviousMetaDecisionStates,
  stabilizeMetaRecommendations,
} from "@/lib/meta/decision-stability";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "bid-cmp_1",
    level: "campaign",
    campaignId: "cmp_1",
    type: "bid_efficiency",
    lens: "efficiency",
    decisionState: "act",
    confidence: "high",
    confidenceScore: 0.8,
    title: "Bid efficiency",
    why: "Because",
    recommendedAction: "Do it",
    evidence: [],
    ...overrides,
  } as MetaRecommendation;
}

describe("applyMetaStateHysteresis", () => {
  it("holds a first-ever hard action at test until a second snapshot confirms it", () => {
    expect(applyMetaStateHysteresis("act", null)).toEqual({
      publishedState: "test",
      rawState: "act",
      suppressed: true,
    });
  });

  it("publishes a first-ever soft state immediately", () => {
    expect(applyMetaStateHysteresis("watch", null)).toEqual({
      publishedState: "watch",
      rawState: "watch",
      suppressed: false,
    });
  });

  it("publishes immediately when the state did not change", () => {
    expect(
      applyMetaStateHysteresis("act", { publishedState: "act", rawState: "act" }),
    ).toEqual({ publishedState: "act", rawState: "act", suppressed: false });
  });

  it("publishes soft transitions (test<->watch) immediately", () => {
    expect(
      applyMetaStateHysteresis("watch", { publishedState: "test", rawState: "test" }),
    ).toEqual({ publishedState: "watch", rawState: "watch", suppressed: false });
  });

  it("publishes an act->non-act safety exit immediately", () => {
    expect(
      applyMetaStateHysteresis("watch", { publishedState: "act", rawState: "act" }),
    ).toEqual({ publishedState: "watch", rawState: "watch", suppressed: false });
  });

  it("suppresses the first non-act->act flip", () => {
    expect(
      applyMetaStateHysteresis("act", { publishedState: "watch", rawState: "watch" }),
    ).toEqual({ publishedState: "watch", rawState: "act", suppressed: true });
  });

  it("confirms the transition on the second consecutive snapshot", () => {
    expect(
      applyMetaStateHysteresis("act", { publishedState: "watch", rawState: "act" }),
    ).toEqual({ publishedState: "act", rawState: "act", suppressed: false });
  });

  it("re-suppresses when the raw state keeps oscillating", () => {
    // Yesterday published watch with raw act; today raw flips back to watch:
    // no transition to publish (matches published), so it publishes watch.
    expect(
      applyMetaStateHysteresis("watch", { publishedState: "watch", rawState: "act" }),
    ).toEqual({ publishedState: "watch", rawState: "watch", suppressed: false });
  });

  it("treats a missing raw state as the published state (legacy snapshots)", () => {
    expect(
      applyMetaStateHysteresis("act", { publishedState: "watch", rawState: null }),
    ).toEqual({ publishedState: "watch", rawState: "act", suppressed: true });
  });
});

describe("stabilizeMetaRecommendations", () => {
  const scopeFor = (recommendation: MetaRecommendation) => ({
    scopeType: "campaign",
    scopeId: recommendation.campaignId ?? "unknown",
  });

  it("stamps stability memory and holds a first-ever hard action at test", () => {
    const { recommendations, suppressedCount } = stabilizeMetaRecommendations({
      recommendations: [rec()],
      previousByKey: new Map(),
      scopeFor,
    });
    expect(suppressedCount).toBe(1);
    expect(recommendations[0]?.decisionState).toBe("test");
    expect(recommendations[0]?.signalQuality?.stability).toEqual({
      raw_decision_state: "act",
      suppressed: true,
    });
  });

  it("publishes a hard-action exit immediately", () => {
    const key = metaStabilityKey({
      scopeType: "campaign",
      scopeId: "cmp_1",
      recType: "bid_efficiency",
    });
    const { recommendations, suppressedCount } = stabilizeMetaRecommendations({
      recommendations: [rec({ decisionState: "watch", stateReason: "raw reason" })],
      previousByKey: new Map([[key, { publishedState: "act", rawState: "act" }]]),
      scopeFor,
    });
    expect(suppressedCount).toBe(0);
    expect(recommendations[0]?.decisionState).toBe("watch");
    expect(recommendations[0]?.stateReason).toBe("raw reason");
    expect(recommendations[0]?.signalQuality?.stability).toEqual({
      raw_decision_state: "watch",
      suppressed: false,
    });
  });

  it("holds a soft-to-hard entry and prefixes the state reason", () => {
    const key = metaStabilityKey({
      scopeType: "campaign",
      scopeId: "cmp_1",
      recType: "bid_efficiency",
    });
    const { recommendations, suppressedCount } = stabilizeMetaRecommendations({
      recommendations: [rec({ stateReason: "raw reason" })],
      previousByKey: new Map([[key, { publishedState: "watch", rawState: "watch" }]]),
      scopeFor,
    });
    expect(suppressedCount).toBe(1);
    expect(recommendations[0]?.decisionState).toBe("watch");
    expect(recommendations[0]?.stateReason).toBe(
      `${META_PENDING_TRANSITION_REASON_PREFIX}raw reason`,
    );
  });

  it("preserves existing signalQuality fields when stamping stability", () => {
    const { recommendations } = stabilizeMetaRecommendations({
      recommendations: [rec({ signalQuality: { sample: "thin" } })],
      previousByKey: new Map(),
      scopeFor,
    });
    expect(recommendations[0]?.signalQuality).toEqual({
      sample: "thin",
      stability: { raw_decision_state: "act", suppressed: true },
    });
  });
});

describe("readPreviousMetaDecisionStates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps rows to stability keys and reads raw state from signal_quality", async () => {
    const tag = vi.fn(() =>
      Promise.resolve([
        {
          scope_type: "campaign",
          scope_id: "cmp_1",
          rec_type: "bid_efficiency",
          decision_state: "act",
          signal_quality: { stability: { raw_decision_state: "watch", suppressed: true } },
        },
        {
          scope_type: "adset",
          scope_id: "adset_1",
          rec_type: "volume",
          decision_state: "test",
          signal_quality: {},
        },
        {
          scope_type: "campaign",
          scope_id: "cmp_bad",
          rec_type: "bid_efficiency",
          decision_state: "not_a_state",
          signal_quality: null,
        },
      ]),
    ) as unknown as ReturnType<typeof db.getDb>;
    vi.mocked(db.getDb).mockReturnValue(tag);

    const map = await readPreviousMetaDecisionStates({
      businessId: "biz_1",
      asOf: "2026-07-06",
      engineVersion: "v1.0.0",
    });

    expect(map.size).toBe(2);
    expect(
      map.get(metaStabilityKey({ scopeType: "campaign", scopeId: "cmp_1", recType: "bid_efficiency" })),
    ).toEqual({ publishedState: "act", rawState: "watch" });
    expect(
      map.get(metaStabilityKey({ scopeType: "adset", scopeId: "adset_1", recType: "volume" })),
    ).toEqual({ publishedState: "test", rawState: null });
  });
});
