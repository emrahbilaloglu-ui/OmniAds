import { describe, expect, it } from "vitest";
import {
  buildDataLayerHealth,
  classifyStaleTier,
  composeDataHealth,
  staleTierForDisplay,
  worstStaleTier,
} from "../data-health";
import type { DataLayerHealth } from "../types";

function makeLayer(
  overrides: Partial<DataLayerHealth> = {},
): DataLayerHealth {
  return {
    asOfDate: "2026-05-04",
    computedAt: "2026-05-04T12:00:00.000Z",
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "runtime_sql",
    note: null,
    ...overrides,
  };
}

describe("data health", () => {
  it.each([
    [null, "unknown"],
    [0, "none"],
    [36, "none"],
    [37, "warning"],
    [72, "warning"],
    [73, "disabled"],
  ] as const)("classifies %s freshness hours as %s", (hours, expected) => {
    expect(classifyStaleTier(hours)).toBe(expected);
  });

  it.each([
    [["none", "warning", "none"], "warning"],
    [["warning", "unknown", "none"], "unknown"],
    [["unknown", "disabled", "warning"], "disabled"],
    [["warning", "disabled", "none"], "disabled"],
    [["none", "none"], "none"],
  ] as const)("returns worst tier for %j", (tiers, expected) => {
    expect(worstStaleTier([...tiers])).toBe(expected);
  });

  it("composes mixed layer tiers into worstTier and degraded", () => {
    expect(
      composeDataHealth({
        calibration: makeLayer({ staleTier: "none" }),
        lifecycle: makeLayer({ staleTier: "warning" }),
        decisions: makeLayer({ staleTier: "disabled" }),
      }),
    ).toMatchObject({
      worstTier: "disabled",
      degraded: true,
    });
  });

  it("keeps unknown source freshness explicit", () => {
    expect(
      buildDataLayerHealth({
        asOfDate: "2026-05-04",
        computedAt: "2026-05-04T12:00:00.000Z",
        sourceMaxUpdatedAt: null,
        fallbackMode: "runtime_sql",
      }),
    ).toMatchObject({
      sourceFreshnessHours: null,
      staleTier: "unknown",
    });
  });

  it("maps unknown to warning for display without changing disabled semantics", () => {
    expect(staleTierForDisplay("unknown")).toBe("warning");
    expect(staleTierForDisplay("warning")).toBe("warning");
    expect(staleTierForDisplay("disabled")).toBe("disabled");
  });

  it("does not mark unknown-only health as engine degraded", () => {
    expect(
      composeDataHealth({
        calibration: makeLayer({ staleTier: "unknown" }),
        lifecycle: makeLayer({ staleTier: "none" }),
        decisions: makeLayer({ staleTier: "warning" }),
      }),
    ).toMatchObject({
      worstTier: "unknown",
      degraded: false,
    });
  });

  it("computes source freshness hours and stale tier from timestamps", () => {
    expect(
      buildDataLayerHealth({
        asOfDate: "2026-05-04",
        computedAt: "2026-05-04T12:00:00.000Z",
        sourceMaxUpdatedAt: "2026-05-02T10:00:00.000Z",
        now: new Date("2026-05-04T12:00:00.000Z"),
        fallbackMode: "runtime_sql",
      }),
    ).toMatchObject({
      sourceFreshnessHours: 50,
      staleTier: "warning",
    });
  });
});
