import { afterEach, describe, expect, it } from "vitest";
import {
  getCreativeDecisionCenterV21CanaryBusinesses,
  isCreativeDecisionCenterV21Enabled,
  isCreativeDecisionCenterV21EnabledForBusiness,
  isCreativeDecisionCenterV21LiveRowsEnabled,
  isCreativeDecisionCenterV21LiveRowsEnabledForBusiness,
} from "@/lib/creative-decision-os-config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("creative decision center v2.1 feature flag", () => {
  it("is disabled by default", () => {
    delete process.env.CREATIVE_DECISION_CENTER_V21;
    delete process.env.CREATIVE_DECISION_CENTER_V21_CANARY_BUSINESSES;
    delete process.env.CREATIVE_DECISION_CENTER_V21_LIVE_ROWS;

    expect(isCreativeDecisionCenterV21Enabled()).toBe(false);
    expect(isCreativeDecisionCenterV21EnabledForBusiness("biz_1")).toBe(false);
    expect(isCreativeDecisionCenterV21LiveRowsEnabled()).toBe(false);
    expect(isCreativeDecisionCenterV21LiveRowsEnabledForBusiness("biz_1")).toBe(false);
  });

  it("enables all businesses when the flag is on and no canary list is set", () => {
    process.env.CREATIVE_DECISION_CENTER_V21 = "1";
    delete process.env.CREATIVE_DECISION_CENTER_V21_CANARY_BUSINESSES;

    expect(isCreativeDecisionCenterV21Enabled()).toBe(true);
    expect(getCreativeDecisionCenterV21CanaryBusinesses()).toEqual([]);
    expect(isCreativeDecisionCenterV21EnabledForBusiness("biz_1")).toBe(true);
  });

  it("honors canary business allowlists", () => {
    process.env.CREATIVE_DECISION_CENTER_V21 = "true";
    process.env.CREATIVE_DECISION_CENTER_V21_CANARY_BUSINESSES =
      "biz_1, biz_2";

    expect(getCreativeDecisionCenterV21CanaryBusinesses()).toEqual([
      "biz_1",
      "biz_2",
    ]);
    expect(isCreativeDecisionCenterV21EnabledForBusiness("biz_1")).toBe(true);
    expect(isCreativeDecisionCenterV21EnabledForBusiness("other")).toBe(false);
    expect(isCreativeDecisionCenterV21EnabledForBusiness(null)).toBe(false);
  });

  it("gates live row generation behind both V2.1 and live-row flags", () => {
    process.env.CREATIVE_DECISION_CENTER_V21 = "1";
    process.env.CREATIVE_DECISION_CENTER_V21_LIVE_ROWS = "1";
    process.env.CREATIVE_DECISION_CENTER_V21_CANARY_BUSINESSES = "biz_1";

    expect(isCreativeDecisionCenterV21LiveRowsEnabled()).toBe(true);
    expect(isCreativeDecisionCenterV21LiveRowsEnabledForBusiness("biz_1")).toBe(true);
    expect(isCreativeDecisionCenterV21LiveRowsEnabledForBusiness("other")).toBe(false);

    process.env.CREATIVE_DECISION_CENTER_V21 = "0";
    expect(isCreativeDecisionCenterV21LiveRowsEnabledForBusiness("biz_1")).toBe(false);
  });
});
