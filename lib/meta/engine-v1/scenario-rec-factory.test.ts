import { describe, expect, it } from "vitest";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";
import {
  buildMetaScenarioFixtureRecommendations,
  buildMetaScenarioRecommendation,
} from "@/lib/meta/engine-v1/scenario-rec-factory";
import { META_ENGINE_V1_SCENARIOS } from "@/lib/meta/engine-v1/scenarios";

describe("Meta Engine v1 scenario recommendation factory", () => {
  it("fires every scenario-library rec type under validation fixtures", () => {
    const recs = buildMetaScenarioFixtureRecommendations();
    const firedTypes = new Set(recs.map((rec) => rec.type));

    expect(recs).toHaveLength(META_ENGINE_V1_SCENARIOS.length);
    expect(firedTypes.size).toBe(META_ENGINE_V1_SCENARIOS.length);
    expect(
      META_ENGINE_V1_SCENARIOS.every((scenario) => firedTypes.has(scenario.recType)),
    ).toBe(true);
    expect(firedTypes.size).toBeGreaterThanOrEqual(32);
  });

  it("emits complete recommendation shape without high confidence when fixture is watch-only", () => {
    const unsupportedScenario = META_ENGINE_V1_SCENARIOS.find((scenario) => scenario.id === "H1");
    expect(unsupportedScenario).toBeTruthy();

    const rec = buildMetaScenarioRecommendation({
      scenario: unsupportedScenario!,
      entity: {
        level: "campaign",
        campaignId: "cmp_fixture",
        campaignName: "Fixture Campaign",
        roas: 1.1,
        purchases: 4,
      },
    });

    expect(rec.decisionState).toBe("watch");
    expect(rec.confidence).toBe("low");
    expect(rec.confidenceScore).toBeLessThan(0.55);
    expect(rec.signalQuality).toMatchObject({ confidence_cap: "fixture_only" });
    expect(decisionLabelForMetaRec(rec)).toBe("diagnose");
  });

  it("keeps scenario labels derived by shared mapping instead of type prefix", () => {
    const recs = buildMetaScenarioFixtureRecommendations();
    const labels = new Set(recs.map(decisionLabelForMetaRec));

    expect(labels.has("scale")).toBe(true);
    expect(labels.has("diagnose")).toBe(true);
    expect(labels.has("refresh")).toBe(true);
    expect(labels.has("rebuild")).toBe(true);
    expect(labels.has("tune")).toBe(true);
  });
});
