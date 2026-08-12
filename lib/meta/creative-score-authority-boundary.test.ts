import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ACTIVE_RECOMMENDATIONS_ROUTE =
  "app/api/meta/recommendations/route.ts";
const ACTIVE_RECOMMENDATIONS_SNAPSHOT = "lib/meta/snapshot.ts";
const HISTORICAL_SCORE_READER = "lib/meta/creative-score-service.ts";
const RECOMMENDATION_BUILDER = "lib/meta/recommendations.ts";

describe("legacy creative-score authority boundary", () => {
  it("keeps the active recommendations route detached from legacy creative decisions", () => {
    for (const path of [
      ACTIVE_RECOMMENDATIONS_ROUTE,
      ACTIVE_RECOMMENDATIONS_SNAPSHOT,
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("creative-score-service");
      expect(source).not.toContain("creative-intelligence");
      expect(source).not.toContain("creativeIntelligence");
    }
  });

  it("keeps the retained snapshot service SELECT-only and non-scoring", () => {
    const source = readFileSync(HISTORICAL_SCORE_READER, "utf8");

    expect(source).toContain("readHistoricalCreativeScoreSnapshot");
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?meta_creative_score_snapshots\b/i);
    expect(source).not.toContain("scoreMetaCreativeRows");
    expect(source).not.toContain("refreshCreativeScoreSnapshot");
    expect(source).not.toContain("getCreativeScoreSnapshot");
  });

  it("makes legacy creative intelligence an explicitly historical-only API", () => {
    const source = readFileSync(RECOMMENDATION_BUILDER, "utf8");

    expect(source).toContain(
      "buildHistoricalMetaRecommendationsWithLegacyCreativeIntelligence",
    );
    expect(source).toMatch(
      /export function buildMetaRecommendations\([\s\S]*?MetaRecommendationsBuildInput[\s\S]*?creativeIntelligence: null/,
    );
    expect(source).not.toMatch(
      /export interface MetaRecommendationsBuildInput\s*\{[^}]*creativeIntelligence\??:/,
    );
  });
});
