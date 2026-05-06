import { describe, expect, it } from "vitest";
import {
  detectOperatorResponse,
  type OperatorResponseInput,
} from "../operator-response-detection";

const AS_OF = "2026-05-05";
const RECOMMENDED_10D_AGO = "2026-04-25";
const RECOMMENDED_7D_AGO = "2026-04-28";

function makeInput(
  overrides: Partial<OperatorResponseInput> = {},
): OperatorResponseInput {
  return {
    creativeId: "creative-1",
    businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    asOf: AS_OF,
    recentRecommendations: [
      {
        decisionDate: RECOMMENDED_10D_AGO,
        label: "scale",
        confidence: 84,
      },
    ],
    adsetBudgetHistory: [
      {
        capturedAt: "2026-04-24T00:00:00.000Z",
        dailyBudget: 100,
        lifetimeBudget: null,
      },
      {
        capturedAt: "2026-05-05T00:00:00.000Z",
        dailyBudget: 100,
        lifetimeBudget: null,
      },
    ],
    campaignBudgetHistory: [],
    dailySpend: activeSpend([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    actionJournal: [],
    lifecyclePosition: "plateau",
    recent7dRoas: 2.8,
    cumulative28dRoas: 3,
    recent7dFrequency: 1.2,
    cumulative28dFrequency: 1.1,
    ...overrides,
  };
}

function activeSpend(spend: number[]) {
  return spend.map((value, index) => ({
    date: addDays(RECOMMENDED_10D_AGO, index + 1),
    spend: value,
    purchases: value > 0 ? 1 : 0,
    effectiveStatus: "ACTIVE",
  }));
}

function addDays(date: string, offset: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

describe("operator response detection", () => {
  it("returns no_recommendation when there is no hard recommendation", () => {
    const result = detectOperatorResponse(
      makeInput({
        recentRecommendations: [],
      }),
    );

    expect(result.responseType).toBe("no_recommendation");
    expect(result.confidence).toBe(1);
    expect(result.decisionRecommendedAt).toBeNull();
    expect(result.signals).toEqual({
      spendSlope7d: null,
      budgetChangeAmount: null,
      actionJournalReceiptCount: 0,
      statusChanged: false,
      roasDecayPct: null,
      frequencyRosePct: null,
    });
  });

  it("classifies scaled when spend rises materially after scale recommendation", () => {
    const result = detectOperatorResponse(
      makeInput({
        recentRecommendations: [
          {
            decisionDate: RECOMMENDED_7D_AGO,
            label: "scale",
            confidence: 82,
          },
        ],
        dailySpend: activeSpend([90, 100, 115, 130, 145, 160, 175]),
      }),
    );

    expect(result.responseType).toBe("scaled");
    expect(result.confidence).toBe(0.8);
    expect(result.signals.spendSlope7d).toBeGreaterThan(0);
    expect(result.evidence).toContain("spend rose after recommendation");
  });

  it("classifies scaled when budget increases after recommendation", () => {
    const result = detectOperatorResponse(
      makeInput({
        adsetBudgetHistory: [
          {
            capturedAt: "2026-04-24T00:00:00.000Z",
            dailyBudget: 50,
            lifetimeBudget: null,
          },
          {
            capturedAt: "2026-04-30T00:00:00.000Z",
            dailyBudget: 100,
            lifetimeBudget: null,
          },
        ],
      }),
    );

    expect(result.responseType).toBe("scaled");
    expect(result.signals.budgetChangeAmount).toBe(50);
    expect(result.evidence).toContain("adset budget increased by 50");
  });

  it("classifies scaled_natural_saturation when scaled response is followed by ROAS decay", () => {
    const result = detectOperatorResponse(
      makeInput({
        dailySpend: activeSpend([100, 110, 125, 140, 155, 170, 185]),
        recent7dRoas: 2.2,
        cumulative28dRoas: 3,
      }),
    );

    expect(result.responseType).toBe("scaled_natural_saturation");
    expect(result.confidence).toBe(0.75);
    expect(result.signals.roasDecayPct).toBeCloseTo(0.266, 2);
  });

  it("classifies ignored and promotes past_peak_unclear to past_peak_inaction", () => {
    const result = detectOperatorResponse(
      makeInput({
        lifecyclePosition: "past_peak_unclear",
      }),
    );

    expect(result.responseType).toBe("ignored");
    expect(result.confidence).toBe(0.7);
    expect(result.promoteLifecyclePosition).toBe("past_peak_inaction");
  });

  it("classifies paused when latest status is PAUSED", () => {
    const result = detectOperatorResponse(
      makeInput({
        dailySpend: [
          ...activeSpend([100, 100, 100, 100, 100, 100, 100, 100, 100]),
          {
            date: AS_OF,
            spend: 0,
            purchases: 0,
            effectiveStatus: "PAUSED",
          },
        ],
      }),
    );

    expect(result.responseType).toBe("paused");
    expect(result.confidence).toBe(0.75);
    expect(result.signals.statusChanged).toBe(true);
  });

  it("classifies creative_archived for archive journal plus DELETED status", () => {
    const result = detectOperatorResponse(
      makeInput({
        dailySpend: [
          ...activeSpend([100, 100, 100, 100, 100, 100, 100, 100, 100]),
          {
            date: AS_OF,
            spend: 0,
            purchases: 0,
            effectiveStatus: "DELETED",
          },
        ],
        actionJournal: [
          {
            createdAt: "2026-05-01T12:00:00.000Z",
            eventType: "status_changed",
            actionTitle: "Creative archived",
            metadata: { action: "archive", creativeId: "creative-1" },
          },
        ],
      }),
    );

    expect(result.responseType).toBe("creative_archived");
    expect(result.confidence).toBe(0.9);
  });

  it("classifies budget_decreased when budget is reduced by more than 15 percent", () => {
    const result = detectOperatorResponse(
      makeInput({
        adsetBudgetHistory: [
          {
            capturedAt: "2026-04-24T00:00:00.000Z",
            dailyBudget: 100,
            lifetimeBudget: null,
          },
          {
            capturedAt: "2026-04-30T00:00:00.000Z",
            dailyBudget: 70,
            lifetimeBudget: null,
          },
        ],
      }),
    );

    expect(result.responseType).toBe("budget_decreased");
    expect(result.confidence).toBe(0.7);
    expect(result.signals.budgetChangeAmount).toBe(-30);
  });

  it("classifies unknown for conflicting rising spend and pause journal signals", () => {
    const result = detectOperatorResponse(
      makeInput({
        dailySpend: activeSpend([100, 115, 130, 145, 160, 175, 190]),
        actionJournal: [
          {
            createdAt: "2026-05-01T12:00:00.000Z",
            eventType: "status_changed",
            actionTitle: "Pause requested",
            metadata: { action: "pause", creativeId: "creative-1" },
          },
        ],
      }),
    );

    expect(result.responseType).toBe("unknown");
    expect(result.confidence).toBe(0.4);
    expect(result.evidence[0]).toContain("mixed signals");
  });

  it("returns unknown with zero confidence when recommendation is too recent", () => {
    const result = detectOperatorResponse(
      makeInput({
        recentRecommendations: [
          {
            decisionDate: "2026-05-04",
            label: "refresh",
            confidence: 74,
          },
        ],
      }),
    );

    expect(result.responseType).toBe("unknown");
    expect(result.confidence).toBe(0);
    expect(result.evidence).toContain("recommendation too recent (<3 days)");
  });

  it("keeps confidence levels calibrated by evidence strength", () => {
    const ignored = detectOperatorResponse(
      makeInput({ lifecyclePosition: "past_peak_unclear" }),
    );
    const paused = detectOperatorResponse(
      makeInput({
        dailySpend: [
          ...activeSpend([100, 100, 100, 100, 100, 100, 100, 100, 100]),
          {
            date: AS_OF,
            spend: 0,
            purchases: 0,
            effectiveStatus: "PAUSED",
          },
        ],
        actionJournal: [
          {
            createdAt: "2026-05-03T12:00:00.000Z",
            eventType: "status_changed",
            actionTitle: "Paused creative",
            metadata: { action: "pause" },
          },
        ],
      }),
    );

    expect(ignored.confidence).toBe(0.7);
    expect(paused.confidence).toBe(0.85);
  });
});
