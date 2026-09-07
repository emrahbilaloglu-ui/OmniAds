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
const TIER_ZERO_SURFACES: Array<{
  label: string;
  /** The route entry the user actually navigates to. */
  route: string;
  /** The component that route renders, when it delegates. */
  file: string;
}> = [
  {
    label: "Overview / Agency Today",
    route: "app/(dashboard)/overview/legacy-page.tsx",
    file: "app/(dashboard)/overview/legacy-page.tsx",
  },
  {
    label: "Decisions and inspector",
    route: "app/(dashboard)/platforms/meta/legacy-page.tsx",
    file: "components/meta/redesign/MetaPlatformPage.tsx",
  },
  {
    label: "History",
    route: "app/(dashboard)/platforms/meta/history/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/history/history-view.tsx",
  },
  {
    label: "Creative Studio",
    route: "app/(dashboard)/platforms/meta/creatives/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/creatives/legacy-page.tsx",
  },
  {
    label: "Google Ads",
    route: "app/(dashboard)/platforms/google/legacy-page.tsx",
    file: "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  },
  {
    label: "Reports",
    route: "app/(dashboard)/reports/legacy-page.tsx",
    file: "components/reports/reports-exact-container.tsx",
  },
  {
    // The list reported its age while the page that renders the figures an
    // agency sends to a client said nothing. Nobody acts on the list.
    label: "Rendered report",
    route: "app/(dashboard)/reports/[reportId]/legacy-page.tsx",
    file: "components/reports/report-builder-page.tsx",
  },
  {
    label: "Studio — Copies",
    route: "app/(dashboard)/platforms/meta/copies/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/copies/legacy-page.tsx",
  },
  {
    label: "Studio — Creative inbox",
    route: "app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx",
  },
  {
    label: "Studio — Landing pages",
    route: "app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx",
  },
  {
    label: "Launchpad",
    route: "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
  },
  {
    label: "Automation",
    route: "app/(dashboard)/platforms/meta/automation/legacy-page.tsx",
    file: "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
  },
  {
    label: "Settings",
    route: "app/(dashboard)/settings/legacy-page.tsx",
    file: "app/(dashboard)/settings/legacy-page.tsx",
  },
  {
    label: "Integrations",
    route: "app/(dashboard)/integrations/legacy-page.tsx",
    file: "app/(dashboard)/integrations/legacy-page.tsx",
  },
];

/** The component name a route file must reference for the wiring to be live. */
function componentName(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.tsx?$/, "");
}

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
      expect(
        source.includes("useTierZeroFreshness("),
        `${surface.file} does not report its data age; silence reads as "current"`,
      ).toBe(true);
    });

    it(`${surface.label} wires the component its route actually renders`, () => {
      // The wiring was once added to a component the route had stopped
      // rendering. The file passed its own check and the surface still said
      // nothing, so the route has to vouch for the component.
      if (surface.route === surface.file) return;
      const route = readFileSync(surface.route, "utf8");
      expect(
        route.includes(componentName(surface.file)),
        `${surface.route} does not render ${surface.file}; the wiring is dead`,
      ).toBe(true);
    });
  }

  it("mounts the shared freshness contract in the reference topbar", () => {
    // Dashboard v2 keeps one canonical topbar status pill. It may expose only
    // the retry handler registered by the active surface; it must not invent a
    // second refresh bar or refetch unrelated provider-status queries.
    const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");
    const signals = readFileSync(
      "components/layout/v2/use-shell-signals.ts",
      "utf8",
    );
    const topbar = readFileSync("components/layout/v2/app-topbar.tsx", "utf8");
    expect(frame).toContain("<AppTopbar");
    expect(frame).not.toContain("<TierZeroFreshnessBar />");
    expect(topbar.match(/className="adv-pill"/g)).toHaveLength(1);
    expect(topbar).toContain("data-freshness-state={sync.freshnessState}");
    expect(topbar).toContain("sync.onRetry ?");
    expect(topbar).toContain('aria-label="Retry data refresh"');
    expect(topbar).toContain("onClick={sync.onRetry}");
    expect(signals).toContain("useTierZeroFreshnessStore");
    expect(signals).toContain("activeSurfaceForBusiness.asOf");
    expect(signals).toContain("activeSurfaceForBusiness.retryKey");
    expect(signals).toContain("runFreshnessRetry(");
    expect(signals).not.toContain("retryHandlers");
    expect(signals).not.toContain("refetchMetaStatus");
    expect(signals).not.toContain("refetchGoogleStatus");
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
