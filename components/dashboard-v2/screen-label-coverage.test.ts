import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DASHBOARD_REFERENCE_SCREENS } from "@/lib/dashboard-v2/screen-registry";

/**
 * Every screen the reference defines carries its own `data-screen-label`.
 *
 * The prototype puts that attribute on every `<section>` it draws, and this app
 * reproduces it for two reasons that both bite silently when it is missing: it
 * is the capture boundary the visual parity harness keys on
 * (`scripts/dashboard-v2/strict-visual-parity.ts`), and it is how a coverage
 * sweep can tell "this route renders its exact body" from "this route renders
 * something". Four screens -- Reports, Klaviyo, Insights and Integrations --
 * shipped without it and nothing noticed, because every other gate reads the
 * component, not the DOM it produces.
 *
 * Asserting on the source rather than a render keeps this cheap and total: it
 * cannot pass because a screen happened not to be exercised.
 */
const SCREEN_ROOT_FILES: Readonly<Record<string, string>> = {
  overview: "app/(dashboard)/overview/legacy-page.tsx",
  meta: "components/meta/decision-center/MetaDecisionCenterExact.tsx",
  // The two rail rows D3 adds. Both bodies existed and both routes worked;
  // neither carried the capture attribute, so the visual parity harness had no
  // boundary to key on and a coverage sweep could not tell "renders its exact
  // body" from "renders something" for either of them.
  "meta-intelligence":
    "components/zero-base/meta/intelligence/intelligence-view.tsx",
  "meta-history": "components/zero-base/meta/history/history-view.tsx",
  creative: "components/creatives/CreativeStudioExact.tsx",
  launchpad: "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
  automation: "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
  google: "components/google-ads/GoogleOverviewExact.tsx",
  "google-advisor": "components/google-ads/GoogleAdvisorExact.tsx",
  "google-search": "components/google-ads/GoogleSearchExact.tsx",
  "google-products": "components/google-ads/GoogleProductsExact.tsx",
  "google-assets": "components/google-ads/GoogleAssetsExact.tsx",
  "google-plan": "components/google-ads/GooglePlanExact.tsx",
  klaviyo: "components/klaviyo/KlaviyoExact.tsx",
  insights: "components/insights/InsightsShellExact.tsx",
  reports: "components/reports/ReportsExact.tsx",
  "commercial-truth": "components/commercial-truth/CommercialTruthExact.tsx",
  integrations: "components/integrations/IntegrationsExact.tsx",
  team: "components/team/TeamExact.tsx",
  settings: "components/settings/SettingsExact.tsx",
};

describe("every reference screen marks its own root", () => {
  it("covers every screen in the registry", () => {
    expect(Object.keys(SCREEN_ROOT_FILES).sort()).toEqual(
      Object.keys(DASHBOARD_REFERENCE_SCREENS).sort(),
    );
  });

  for (const [screen, file] of Object.entries(SCREEN_ROOT_FILES)) {
    it(`${screen} renders data-screen-label="${DASHBOARD_REFERENCE_SCREENS[screen as keyof typeof DASHBOARD_REFERENCE_SCREENS].label}"`, () => {
      const source = readFileSync(file, "utf8");
      const label =
        DASHBOARD_REFERENCE_SCREENS[
          screen as keyof typeof DASHBOARD_REFERENCE_SCREENS
        ].label;
      expect(source).toContain(`data-screen-label="${label}"`);
    });
  }
});
