import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/creatives/decisions/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(() => false),
  getDemoAiCreativeDecisions: vi.fn(() => []),
}));

vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(() => "en"),
}));

vi.mock("@/lib/ai/generate-creative-decisions", () => ({
  CREATIVE_DECISION_ENGINE_VERSION: "test-engine-v1",
  buildHeuristicCreativeDecisions: vi.fn(() => [
    {
      creativeId: "creative_1",
      action: "scale",
      score: 78,
      confidence: 0.72,
      scoringFactors: ["roas"],
      reasons: ["Strong profitability"],
      nextStep: "Increase spend carefully",
    },
  ]),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");

function buildRequest(forceRefresh = false) {
  return new NextRequest("http://localhost/api/creatives/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      businessId: "biz_1",
      currency: "USD",
      forceRefresh,
      creatives: [
        {
          creativeId: "creative_1",
          name: "Creative 1",
          creativeAgeDays: 14,
          spendVelocity: 10,
          frequency: 1.4,
          spend: 100,
          purchaseValue: 320,
          roas: 3.2,
          cpa: 25,
          ctr: 1.6,
          cpm: 12,
          cpc: 2,
          purchases: 4,
          impressions: 4000,
          linkClicks: 50,
          hookRate: 18,
          holdRate: 8,
          video25Rate: 22,
          watchRate: 14,
          video75Rate: 9,
          clickToPurchaseRate: 8,
          atcToPurchaseRate: 33,
        },
      ],
    }),
  });
}

describe("POST /api/creatives/decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
  });

  it("returns cached provenance for cache hits", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("SELECT decisions, source, warning, updated_at")) {
        return [
          {
            decisions: [
              {
                creativeId: "creative_1",
                action: "watch",
                score: 55,
                confidence: 0.5,
                scoringFactors: [],
                reasons: ["Need more data"],
                nextStep: "Wait",
              },
            ],
            source: "deterministic",
            warning: null,
            updated_at: "2026-04-10T10:00:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source).toBe("cache");
    expect(payload.decisions).toHaveLength(1);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("returns deterministic provenance for fresh computations and stores deterministic cache rows", async () => {
    const writes: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      if (query.includes("SELECT decisions, source, warning, updated_at")) {
        return [];
      }
      if (query.includes("INSERT INTO ai_creative_decisions_cache")) {
        writes.push(values);
        return [];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await POST(buildRequest(true));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source).toBe("deterministic");
    expect(payload.decisions[0]?.creativeId).toBe("creative_1");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("deterministic");
  });
});
