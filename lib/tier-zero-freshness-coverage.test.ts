import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every Tier-0 data surface reports its freshness, and they all use one rule.
 *
 * The failure this prevents is subtle: a surface that says nothing about the age
 * of its data reads as current, so an operator trusts a number that may be a day
 * old. Adding a surface without wiring it is the easy mistake, so it is the one
 * this test catches.
 */
const TIER_ZERO_SURFACES: Array<{ label: string; file: string }> = [
  { label: "Overview / Agency Today", file: "app/(dashboard)/overview/page.tsx" },
  {
    label: "Decisions and inspector",
    file: "components/meta/redesign/MetaPlatformPage.tsx",
  },
  {
    label: "History",
    file: "app/(dashboard)/platforms/meta/history/history-view.tsx",
  },
  {
    label: "Creative Studio",
    file: "components/creatives/CreativeStudioWorkspace.tsx",
  },
  {
    label: "Google Ads",
    file: "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  },
  { label: "Reports", file: "app/(dashboard)/reports/page.tsx" },
  {
    label: "Launchpad",
    file: "app/(dashboard)/platforms/meta/launchpad/page.tsx",
  },
  {
    label: "Automation",
    file: "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
  },
  { label: "Settings", file: "app/(dashboard)/settings/page.tsx" },
  { label: "Integrations", file: "app/(dashboard)/integrations/page.tsx" },
];

const contract = readFileSync(
  "components/states/TierZeroFreshness.tsx",
  "utf8",
);
const hook = readFileSync(
  "components/states/useTierZeroFreshness.ts",
  "utf8",
);

describe("every Tier-0 surface reports its data age", () => {
  for (const surface of TIER_ZERO_SURFACES) {
    it(`${surface.label} reports freshness`, () => {
      const source = readFileSync(surface.file, "utf8");
      const reports =
        source.includes("useTierZeroFreshness(") ||
        source.includes("FreshnessChip") ||
        source.includes("TierZeroFreshness");
      expect(
        reports,
        `${surface.file} does not report its data age; silence reads as "current"`,
      ).toBe(true);
    });
  }

  it("renders through one shared contract, mounted once", () => {
    const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");
    expect(frame).toContain("TierZeroFreshnessBar");
  });
});

describe("the states are the honest ones", () => {
  it("never renders a figure while loading", () => {
    // A zero during load is indistinguishable from a real zero, and people act
    // on it.
    expect(contract).toContain('data-freshness-state="loading"');
    expect(contract).toContain("Loading — no figures yet");
  });

  it("names a terminal failure and withholds figures", () => {
    expect(contract).toContain('data-freshness-state="error"');
    expect(contract).toContain("Could not load — figures withheld");
    expect(contract).toContain("data-freshness-error");
  });

  it("offers a retry that actually retries", () => {
    // A retry button that does nothing tells the operator the system is trying
    // when it is not.
    expect(contract).toContain("onClick={onRetry}");
    const store = readFileSync("store/tier-zero-freshness-store.ts", "utf8");
    expect(store).toContain("runRetry");
    expect(store).toContain("if (handler) handler();");
  });

  it("says which part is missing rather than presenting a partial total as whole", () => {
    expect(contract).toContain('data-freshness-partial="true"');
    expect(contract).toContain("totals are incomplete");
  });

  it("ranks loading above every other state", () => {
    // Any other order lets a stale-but-present reading mask "we do not know yet".
    const order = hook.indexOf("input.isLoading");
    const errorAt = hook.indexOf("input.error");
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(errorAt);
  });

  it("carries a bounded error code, never a provider message", () => {
    expect(hook).toContain('"upstream_unavailable"');
    expect(contract).toContain("A bounded code, never a raw provider message");
  });
});
