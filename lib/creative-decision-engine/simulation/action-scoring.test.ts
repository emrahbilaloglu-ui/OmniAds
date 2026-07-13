import { describe, expect, it } from "vitest";
import {
  META_SIMULATION_SCORE_CONTRACT_VERSION,
  groupMetaSimulationEpisodesByStratum,
  isHardMetaSimulationAction,
  metaSimulationStratificationKey,
  scoreMetaSimulationAction,
  type MetaSimulationAdExecutionAction,
  type MetaSimulationEpisode,
} from "./action-scoring";

function adEpisode(input: {
  id: string;
  emitted?: MetaSimulationAdExecutionAction;
  opportunity?: MetaSimulationAdExecutionAction;
  eligibility?: "eligible" | "ineligible" | "unknown";
  outcome?: "supported" | "refuted" | "neutral" | "unknown" | "censored";
  severity?: "critical" | "high" | "medium" | "low" | null;
  confidence?: number;
  currency?: string | null;
  accountId?: string;
}): MetaSimulationEpisode<"ad"> {
  const action = input.opportunity ?? "cut_ad";
  return {
    contractVersion: META_SIMULATION_SCORE_CONTRACT_VERSION,
    grain: "ad",
    entity: {
      accountId: input.accountId ?? "account-1",
      campaignId: "campaign-1",
      adsetId: "adset-1",
      adId: input.id,
      creativeId: `creative-${input.id}`,
    },
    asOfDate: "2026-07-01",
    cutoff: "2026-07-01T03:00:00.000Z",
    context: {
      currency: input.currency === undefined ? "USD" : input.currency,
      objective: "OUTCOME_SALES",
      sourceMode: "exact_day_generation",
    },
    pit: {
      status: "complete",
      sourceGenerationIds: ["generation-1"],
      targetHistoryId: "target-1",
      configHistoryIds: ["config-1"],
      inputManifestHash: `hash-${input.id}`,
      missing: [],
    },
    decision: {
      economicVerdict: "below_breakeven",
      portfolioRole: "exhausted",
      authorityState: "actionable",
      executionAction: input.emitted ?? "none",
      operationalState: "active_delivery",
      rawAction: input.emitted ?? null,
      confidence: input.confidence ?? 0.8,
    },
    opportunity: {
      action,
      evaluatedAt: "2026-07-01T03:00:00.000Z",
      eligibility: input.eligibility ?? "eligible",
      reasonCodes: [],
    },
    treatment: {
      status: "not_acted",
      occurredAt: null,
      receiptId: null,
      contamination: [],
    },
    outcome: {
      windowDays: 7,
      status: input.outcome ?? "supported",
      proxyType: "durability",
      severity: input.severity ?? null,
      metrics: { spend: 100, roas: 0.5 },
      reasonCodes: [],
    },
  };
}

describe("scoreMetaSimulationAction", () => {
  it("builds paired confusion metrics without reversing missed-action polarity", () => {
    const score = scoreMetaSimulationAction({
      grain: "ad",
      action: "cut_ad",
      episodes: [
        adEpisode({ id: "tp", emitted: "cut_ad", outcome: "supported" }),
        adEpisode({
          id: "fp",
          emitted: "cut_ad",
          outcome: "refuted",
          severity: "critical",
        }),
        adEpisode({ id: "fn", emitted: "keep_running", outcome: "supported" }),
        adEpisode({ id: "tn", emitted: "keep_running", outcome: "refuted" }),
      ],
    });

    expect(score.pairedConfusion).toEqual({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 1,
    });
    expect(score).toMatchObject({
      precision: 0.5,
      opportunityRecall: 0.5,
      missedOpportunityRate: 0.5,
      criticalFalsePositiveRate: 0.5,
      knownBinarySampleSize: 4,
    });
  });

  it("keeps neutral, unknown, censored, and denominator exclusions out of binary scores", () => {
    const score = scoreMetaSimulationAction({
      grain: "ad",
      action: "cut_ad",
      episodes: [
        adEpisode({ id: "tp", emitted: "cut_ad", outcome: "supported" }),
        adEpisode({ id: "neutral", emitted: "cut_ad", outcome: "neutral" }),
        adEpisode({ id: "unknown", emitted: "cut_ad", outcome: "unknown" }),
        adEpisode({ id: "censored", emitted: "cut_ad", outcome: "censored" }),
        adEpisode({
          id: "excluded",
          emitted: "cut_ad",
          eligibility: "ineligible",
          outcome: "refuted",
        }),
        adEpisode({
          id: "eligibility-unknown",
          emitted: "cut_ad",
          eligibility: "unknown",
          outcome: "refuted",
        }),
      ],
    });

    expect(score).toMatchObject({
      sampleSize: 6,
      eligibleSampleSize: 4,
      ineligibleSampleSize: 1,
      unknownEligibilitySampleSize: 1,
      knownBinarySampleSize: 1,
      neutralSampleSize: 1,
      unknownSampleSize: 1,
      censoredSampleSize: 1,
      precision: 1,
      opportunityRecall: 1,
      unknownRate: 0.25,
      censoredRate: 0.25,
    });
  });

  it("computes ECE only from emitted hard actions with binary known outcomes", () => {
    const hard = scoreMetaSimulationAction({
      grain: "ad",
      action: "cut_ad",
      episodes: [
        adEpisode({
          id: "supported",
          emitted: "cut_ad",
          outcome: "supported",
          confidence: 0.8,
        }),
        adEpisode({
          id: "refuted",
          emitted: "cut_ad",
          outcome: "refuted",
          confidence: 0.8,
        }),
        adEpisode({
          id: "missed",
          emitted: "keep_running",
          outcome: "supported",
          confidence: 0.99,
        }),
      ],
    });
    const nonHard = scoreMetaSimulationAction({
      grain: "ad",
      action: "keep_running",
      episodes: [
        adEpisode({
          id: "keep",
          emitted: "keep_running",
          opportunity: "keep_running",
          outcome: "supported",
          confidence: 0.9,
        }),
      ],
    });

    expect(hard.expectedCalibrationError).toBe(0.3);
    expect(hard.confidenceBuckets).toEqual([
      expect.objectContaining({
        known: 2,
        supported: 1,
        averageConfidence: 0.8,
        observedSupportRate: 0.5,
      }),
    ]);
    expect(nonHard.expectedCalibrationError).toBeNull();
    expect(nonHard.confidenceBuckets).toEqual([]);
    expect(isHardMetaSimulationAction("cut_ad")).toBe(true);
    expect(isHardMetaSimulationAction("keep_running")).toBe(false);
  });

  it("never invents costs and accepts only explicit same-currency costs", () => {
    const episodes = [
      adEpisode({ id: "fp", emitted: "cut_ad", outcome: "refuted" }),
      adEpisode({ id: "fn", emitted: "keep_running", outcome: "supported" }),
    ];
    expect(
      scoreMetaSimulationAction({ grain: "ad", action: "cut_ad", episodes })
        .cost,
    ).toBeNull();

    expect(
      scoreMetaSimulationAction({
        grain: "ad",
        action: "cut_ad",
        episodes,
        costs: { currency: "usd", falsePositive: 100, falseNegative: 25 },
      }).cost,
    ).toEqual({ currency: "USD", total: 125, averagePerEligibleEpisode: 62.5 });

    expect(() =>
      scoreMetaSimulationAction({
        grain: "ad",
        action: "cut_ad",
        episodes,
        costs: { currency: "EUR", falsePositive: 100, falseNegative: 25 },
      }),
    ).toThrow("explicit simulation costs must match the score currency");
  });

  it("rejects currency pooling before computing action scores", () => {
    expect(() =>
      scoreMetaSimulationAction({
        grain: "ad",
        action: "cut_ad",
        episodes: [
          adEpisode({ id: "usd", currency: "USD" }),
          adEpisode({ id: "eur", currency: "EUR" }),
        ],
      }),
    ).toThrow("meta simulation scoring cannot pool currencies");
  });
});

describe("meta simulation stratification", () => {
  it("always includes currency and separates account/action/source strata", () => {
    const usd = adEpisode({ id: "usd", currency: "USD", accountId: "a-1" });
    const eur = adEpisode({ id: "eur", currency: "EUR", accountId: "a-1" });
    const key = metaSimulationStratificationKey(usd, ["account", "action"]);
    const groups = groupMetaSimulationEpisodesByStratum(
      [usd, eur],
      ["account", "action"],
    );

    expect(key).toBe("currency=USD|account=a-1|action=cut_ad");
    expect(groups.size).toBe(2);
  });
});
