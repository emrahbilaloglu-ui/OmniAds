import { describe, expect, it } from "vitest";

import {
  isMutationUiEnabled,
  isZeroBaseUiEnabledForBusiness,
  isZeroBaseUiEnabledForInternal,
  readZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";

function config(env: Record<string, string | undefined>) {
  return readZeroBaseRolloutConfig(env as NodeJS.ProcessEnv);
}

describe("readZeroBaseRolloutConfig", () => {
  it("defaults to fully off when nothing is set", () => {
    expect(config({})).toEqual({
      uiMode: "off",
      allowlistedBusinessIds: [],
      mutationUiEnabled: false,
      reportShareFailClosed: false,
    });
  });

  it("defaults report-share fail-closed to false", () => {
    // WP-03A ships default-off; a deployed `true` needs written authority.
    expect(config({}).reportShareFailClosed).toBe(false);
    expect(config({ ZERO_BASE_REPORT_SHARE_FAIL_CLOSED: "true" }).reportShareFailClosed).toBe(
      true,
    );
  });

  it("parses each UI mode and falls back to off for anything unknown", () => {
    for (const mode of ["off", "internal", "allowlist", "on"]) {
      expect(config({ ZERO_BASE_UI_MODE: mode }).uiMode).toBe(mode);
    }
    expect(config({ ZERO_BASE_UI_MODE: " ON " }).uiMode).toBe("on");
    for (const bad of ["", "yes", "1", "enabled", "ONN", undefined]) {
      expect(config({ ZERO_BASE_UI_MODE: bad }).uiMode, String(bad)).toBe("off");
    }
  });

  it("only treats an exact true as enabled", () => {
    for (const raw of ["true", "TRUE", " true "]) {
      expect(config({ ZERO_BASE_MUTATION_UI_ENABLED: raw }).mutationUiEnabled, raw).toBe(true);
    }
    for (const raw of ["1", "yes", "on", "", "false", undefined]) {
      expect(
        config({ ZERO_BASE_MUTATION_UI_ENABLED: raw }).mutationUiEnabled,
        String(raw),
      ).toBe(false);
    }
  });

  it("parses, trims and de-duplicates the business allowlist", () => {
    expect(
      config({ ZERO_BASE_UI_BUSINESS_IDS: " biz_1 , biz_2,,biz_1 ," }).allowlistedBusinessIds,
    ).toEqual(["biz_1", "biz_2"]);
    expect(config({ ZERO_BASE_UI_BUSINESS_IDS: "" }).allowlistedBusinessIds).toEqual([]);
  });
});

describe("isZeroBaseUiEnabledForBusiness", () => {
  it("is off for every business when the mode is off", () => {
    const c = config({ ZERO_BASE_UI_MODE: "off", ZERO_BASE_UI_BUSINESS_IDS: "biz_1" });
    expect(isZeroBaseUiEnabledForBusiness(c, "biz_1")).toBe(false);
  });

  it("matches only allowlisted businesses in allowlist mode", () => {
    const c = config({ ZERO_BASE_UI_MODE: "allowlist", ZERO_BASE_UI_BUSINESS_IDS: "biz_1,biz_2" });
    expect(isZeroBaseUiEnabledForBusiness(c, "biz_1")).toBe(true);
    expect(isZeroBaseUiEnabledForBusiness(c, "biz_3")).toBe(false);
    expect(isZeroBaseUiEnabledForBusiness(c, null)).toBe(false);
    expect(isZeroBaseUiEnabledForBusiness(c, undefined)).toBe(false);
  });

  it("does not enable a client surface from internal mode alone", () => {
    const c = config({ ZERO_BASE_UI_MODE: "internal", ZERO_BASE_UI_BUSINESS_IDS: "biz_1" });
    expect(isZeroBaseUiEnabledForBusiness(c, "biz_1")).toBe(false);
    expect(isZeroBaseUiEnabledForInternal(c)).toBe(true);
  });

  it("is on for every business in on mode", () => {
    const c = config({ ZERO_BASE_UI_MODE: "on" });
    expect(isZeroBaseUiEnabledForBusiness(c, "biz_anything")).toBe(true);
    expect(isZeroBaseUiEnabledForInternal(c)).toBe(true);
  });
});

describe("rollout is presentation only", () => {
  it("exposes no function that returns an authorization decision", () => {
    // Guards the boundary: nothing in this module may be mistaken for a grant.
    const c = config({ ZERO_BASE_UI_MODE: "on", ZERO_BASE_MUTATION_UI_ENABLED: "true" });
    expect(Object.keys(c).sort()).toEqual([
      "allowlistedBusinessIds",
      "mutationUiEnabled",
      "reportShareFailClosed",
      "uiMode",
    ]);
    expect(isMutationUiEnabled(c)).toBe(true);
  });

  it("reads nothing from NEXT_PUBLIC_*", () => {
    const c = config({
      NEXT_PUBLIC_ZERO_BASE_UI_MODE: "on",
      NEXT_PUBLIC_ZERO_BASE_MUTATION_UI_ENABLED: "true",
      NEXT_PUBLIC_ZERO_BASE_REPORT_SHARE_FAIL_CLOSED: "true",
    });
    expect(c.uiMode).toBe("off");
    expect(c.mutationUiEnabled).toBe(false);
    expect(c.reportShareFailClosed).toBe(false);
  });
});
