import { describe, expect, it } from "vitest";
import { META_ENGINE_V1_SCENARIOS, scenarioDefinitionById } from "@/lib/meta/engine-v1/scenarios";

describe("Meta Engine v1 scenario registry", () => {
  it("covers every scenario-library id from A1 through EG4", () => {
    const ids = META_ENGINE_V1_SCENARIOS.map((scenario) => scenario.id);

    expect(ids).toHaveLength(62);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "A1", "A2", "A3", "A4", "A5",
      "B1", "B2", "B3", "B4", "B5", "B6",
      "C1", "C2", "C3",
      "D1", "D2", "D3", "D4", "D5",
      "E1", "E2", "E3", "E4",
      "F1", "F2", "F3", "F4",
      "G1", "G2", "G3",
      "H1", "H2", "H3", "H4",
      "I1", "I2", "I3", "I4", "I5",
      "J1", "J2", "J3",
      "K1", "K2", "K3", "K4",
      "M1", "M2", "M3", "M4",
      "L1", "L2", "L3", "L4",
      "T1", "T2", "T3", "T4",
      "EG1", "EG2", "EG3", "EG4",
    ]);
  });

  it("defines rec type, required signals, and missing-signal fallback for each scenario", () => {
    expect(
      META_ENGINE_V1_SCENARIOS.every(
        (scenario) =>
          scenario.recType.startsWith("scenario_") &&
          scenario.requiredSignals.length > 0 &&
          Boolean(scenario.missingSignalFallback),
      ),
    ).toBe(true);
    expect(scenarioDefinitionById("K4")?.requiredSignals).toContain("feed_status");
  });
});
