import { describe, expect, it } from "vitest";
import { MockDataSource, WarehouseDataSource } from "..";

describe("creative-decision-engine v3 - data source", () => {
  describe("MockDataSource", () => {
    const mock = new MockDataSource();

    it("returns a creative input", async () => {
      const input = await mock.getCreativeInput({
        creativeId: "c-1",
        businessId: "biz-1",
        asOf: "2026-05-04",
      });
      expect(input).not.toBeNull();
      expect(input!.creativeId).toBe("c-1");
      expect(input!.creativeName).toBe("Mock — c-1");
      expect(input!.objective).toBe("OUTCOME_SALES");
      expect(input).toMatchObject({
        lifecyclePosition: "plateau",
        daysSincePeak: 5,
        peakRoas30d: 3.4,
        peakConfidence: 0.7,
        spendTrajectory30d: "flat",
        spendSlope7d: 0.5,
        spendSlope30d: 0.2,
        roasSlope7d: -0.05,
        roasSlope30d: 0.0,
      });
    });

    it("returns calibration", async () => {
      const cal = await mock.getAccountCalibration({
        businessId: "biz-1",
        asOf: "2026-05-04",
      });
      expect(cal.matureCreativeCount).toBeGreaterThan(0);
      expect(cal.roasP75).not.toBeNull();
    });

    it("lists creative inputs", async () => {
      const list = await mock.listCreativeInputs({
        businessId: "biz-1",
        asOf: "2026-05-04",
      });
      expect(list.length).toBeGreaterThan(0);
    });

    it("returns fresh data health for all mock layers", async () => {
      const health = await mock.getDataHealth({
        businessId: "biz-1",
        asOf: "2026-05-04",
      });

      expect(health.worstTier).toBe("none");
      expect(health.degraded).toBe(false);
      expect(health.calibration.staleTier).toBe("none");
      expect(health.lifecycle.staleTier).toBe("none");
      expect(health.decisions.staleTier).toBe("none");
      expect(health.calibration.sourceFreshnessHours).toBe(0);
      expect(health.lifecycle.sourceFreshnessHours).toBe(0);
      expect(health.decisions.sourceFreshnessHours).toBe(0);
    });
  });

  describe("WarehouseDataSource", () => {
    it("instantiates cleanly", () => {
      const warehouse = new WarehouseDataSource();

      expect(warehouse).toBeInstanceOf(WarehouseDataSource);
    });
  });
});
